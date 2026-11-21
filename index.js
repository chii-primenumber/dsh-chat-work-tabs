import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DeepSeekWebAdapter, PROVIDER_ID } from './lib/adapter.js'
import { createChatBridge } from './lib/bridge.js'

/**
 * Host half of the Chat / Work bundle.
 *
 * It owns the `deepseek-web` provider route and the loopback bridge the browser
 * half reads history and posts messages through. The Chat/Work entries and the
 * chat page itself live in `client.js`; the pure-conversation preset is declared
 * by the bundle patch.
 */
export const name = '@local/dsh-chat-work-tabs'
export const inject = ['llm', 'connection']

/** Where the pasted web credential is expected. */
const CREDENTIAL_FILE = 'deepseek-web-auth.json'

function dshHome(env = process.env) {
  const configured = (env.DSH_HOME ?? '').trim()
  return configured ? resolve(configured) : join(homedir(), '.dsh')
}

/**
 * Accept either a bare token or the web app's `{"value":"...","__version":"0"}`
 * wrapper that `localStorage.userToken` holds.
 */
function normalizeToken(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (typeof parsed?.value === 'string' && parsed.value.trim() !== '') return parsed.value.trim()
    } catch {
      // A malformed wrapper still has a chance as a literal token below.
    }
  }
  return trimmed
}

/**
 * Read the web credential the user pasted from chat.deepseek.com.
 *
 * The web endpoint authenticates with a Bearer token from `localStorage.userToken`
 * plus the browser cookie string, and has no refresh flow, so this reads a file
 * the user refreshes by hand rather than pretending the value is durable.
 */
async function readCredential() {
  const path = join(dshHome(), CREDENTIAL_FILE)
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(
      `找不到 DeepSeek 网页凭据文件 ${path}（${error?.code ?? error?.message ?? error}）。`
      + '请在浏览器登录 chat.deepseek.com 后导出 token 与 cookie 存到该文件。',
    )
  }
  // Notepad and PowerShell's UTF8 writer both may prepend a BOM.
  raw = raw.replace(/^\uFEFF/, '')

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`DeepSeek 网页凭据文件 ${path} 不是合法 JSON。`)
  }

  const token = normalizeToken(parsed?.userToken ?? parsed?.token)
  const cookie = typeof parsed?.cookie === 'string' ? parsed.cookie.trim() : ''
  if (token === null && cookie === '') {
    throw new Error(`DeepSeek 网页凭据文件 ${path} 里既没有 userToken 也没有 cookie。`)
  }
  return { token: token ?? '', cookie }
}

/** Persist a credential captured by the guided login. */
async function writeCredential(credential) {
  const home = dshHome()
  await mkdir(home, { recursive: true })
  const body = `${JSON.stringify({
    userToken: credential.userToken,
    cookie: credential.cookie,
  }, null, 2)}\n`
  await writeFile(join(home, CREDENTIAL_FILE), body, 'utf8')
}

export function apply(ctx) {
  const adapter = new DeepSeekWebAdapter(readCredential)

  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER_ID], adapter), 'dsh-chat-work-tabs: provider route')

  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(), 'dsh-chat-work-tabs: request lifetime')
  for (const route of createChatBridge({
    readAuth: readCredential, saveAuth: writeCredential, adapter,
    logger: ctx.logger, signal: lifetime.signal,
  })) ctx.connection.fetch.register(route)
}
