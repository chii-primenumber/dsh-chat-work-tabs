import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { baseHeaders, ORIGIN } from './api.js'

/**
 * Guided sign-in for the web account.
 *
 * The host runs as plain Node (`ELECTRON_RUN_AS_NODE`), so it cannot open an
 * Electron window, and no browser API lets a page read another origin's
 * `localStorage` or HttpOnly cookies. What does work: launch the user's own
 * browser against a throwaway profile, let them sign in normally, and read the
 * token plus cookies over the DevTools protocol.
 *
 * The temporary profile keeps their real browser data untouched; it is deleted
 * when the flow ends.
 */

const LOGIN_URL = 'https://chat.deepseek.com'
const POLL_MS = 1200

/** Candidate browser executables, most specific first. */
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

function findBrowser(env = process.env) {
  const configured = (env.DSH_CHAT_BROWSER ?? '').trim()
  if (configured !== '') return configured
  return BROWSERS.find((path) => existsSync(path)) ?? null
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Minimal DevTools-protocol client over the browser-level WebSocket. */
function connect(wsUrl, signal) {
  signal.throwIfAborted()
  const socket = new WebSocket(wsUrl)
  let nextId = 0
  let failure
  const pending = new Map()

  let resolveOpen, rejectOpen
  const opened = new Promise((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject })
  const fail = (error) => {
    if (failure) return
    failure = error
    clearTimeout(openTimer)
    rejectOpen(error)
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
    signal.removeEventListener('abort', abort)
  }
  const abort = () => {
    fail(signal.reason)
    socket.close()
  }
  const openTimer = setTimeout(() => {
    fail(new Error('等待登录浏览器连接超时'))
    socket.close()
  }, 10000)
  signal.addEventListener('abort', abort, { once: true })
  socket.addEventListener('open', () => { clearTimeout(openTimer); resolveOpen() }, { once: true })
  socket.addEventListener('error', () => fail(new Error('登录浏览器连接失败')), { once: true })
  socket.addEventListener('close', () => fail(new Error('登录窗口已关闭')), { once: true })
  socket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.error) request.reject(new Error('登录浏览器无法处理请求：' + message.error.message))
    else request.resolve(message)
  })

  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return }
    const id = ++nextId
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('登录浏览器请求超时'))
    }, 5000)
    pending.set(id, { resolve, reject, timer })
    try {
      socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
    } catch (error) {
      pending.delete(id)
      clearTimeout(timer)
      reject(error)
    }
  })

  return { socket, opened, send }
}

async function waitForDevTools(profile, signal) {
  const deadline = Date.now() + 30000
  for (;;) {
    signal.throwIfAborted()
    try {
      const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/)
      if (/^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65535 && /^\/devtools\/browser\/[a-f0-9-]+$/i.test(path)) {
        return `ws://127.0.0.1:${port}${path}`
      }
    } catch {
      // The browser has not opened its debugging port yet.
    }
    if (Date.now() >= deadline) throw new Error('浏览器没有打开调试端口')
    await delay(250, undefined, { signal })
  }
}

/** Pick the page target that shows the chat product. */
function isChatPage(url) {
  try { return new URL(url).origin === LOGIN_URL } catch { return false }
}

async function findPageTarget(send, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const response = await send('Target.getTargets')
    const infos = response?.result?.targetInfos ?? []
    const pages = infos.filter((info) => info.type === 'page')
    const chat = pages.find((info) => isChatPage(info.url))
    if (chat !== undefined) return chat
    if (Date.now() >= deadline) {
      throw new Error('没有找到登录页面')
    }
    await delay(400, undefined, { signal })
  }
}

function cookieHeader(cookies) {
  const parts = []
  for (const cookie of cookies) {
    if (typeof cookie?.name !== 'string' || cookie.name === '') continue
    parts.push(`${cookie.name}=${cookie.value ?? ''}`)
  }
  return parts.join('; ')
}

/**
 * A visitor who is not signed in still receives a `userToken` and a
 * `ds_session_id`, so their presence proves nothing. Only the account endpoint
 * can tell a real session from a guest one.
 */
async function looksSignedIn(credential, signal) {
  try {
    const url = new URL('/api/v0/users/current', ORIGIN)
    const response = await fetch(url, {
      headers: baseHeaders({ token: credential.userToken, cookie: credential.cookie, deviceId: 'dsh-login-probe' }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    })
    if (!response.ok) return false
    const envelope = await response.json()
    if (envelope?.code !== 0) return false
    const account = envelope?.data?.biz_data
    if (account === null || typeof account !== 'object') return false
    // A guest payload has an id but no identity field.
    return typeof account.email === 'string' || typeof account.mobile_number === 'string'
  } catch {
    return false
  }
}

/** Remove the throwaway profile once the browser has released its handles. */
async function removeProfile(profile) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      rmSync(profile, { recursive: true, force: true })
      return
    } catch {
      await sleep(250)
    }
  }
}

/**
 * Drive one sign-in attempt.
 *
 * Resolves with the captured credential, or rejects when the user closes the
 * window, the browser cannot start, or the attempt times out.
 */
export async function runLogin({ logger, timeoutMs = 600000, browserPath, headless = false, signal } = {}) {
  signal?.throwIfAborted()
  const executable = browserPath ?? findBrowser()
  if (executable === null) throw new Error('找不到 Edge 或 Chrome，无法打开登录窗口')

  const profile = mkdtempSync(join(tmpdir(), 'dsh-chat-login-'))
  const args = [
    ...(headless ? ['--headless=new'] : []),
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msEdgeFirstRunExperience',
    '--new-window',
    LOGIN_URL,
  ]

  logger?.info?.(`dsh-chat-work-tabs: 打开登录窗口 ${executable}`)
  const child = spawn(executable, args, { stdio: 'ignore', detached: false })
  const closed = new AbortController()
  const timeout = AbortSignal.timeout(timeoutMs)
  const loginSignal = AbortSignal.any([closed.signal, timeout, ...(signal ? [signal] : [])])
  const childExited = new Promise((resolve) => {
    child.once('exit', () => {
      closed.abort(new Error('登录窗口已关闭'))
      resolve()
    })
    child.once('error', (error) => {
      closed.abort(new Error('无法启动登录浏览器：' + error.message))
      resolve()
    })
  })

  const cleanup = async () => {
    try {
      child.kill()
    } catch {
      // Already gone.
    }
    await Promise.race([childExited, sleep(3000)])
    await removeProfile(profile)
  }

  let connection = null
  let lastProbe = ''

  try {
    const socketUrl = await waitForDevTools(profile, loginSignal)
    connection = connect(socketUrl, loginSignal)
    await connection.opened
    const { send } = connection

    const page = await findPageTarget(send, 30000, loginSignal)
    const attached = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
    const sessionId = attached?.result?.sessionId
    if (sessionId === undefined) throw new Error('无法附加到登录页面')

    for (;;) {
      loginSignal.throwIfAborted()

      const evaluated = await send('Runtime.evaluate', {
        expression: 'location.origin === "https://chat.deepseek.com" ? localStorage.getItem("userToken") : null',
        returnByValue: true,
      }, sessionId)
      const raw = evaluated?.result?.result?.value

      if (typeof raw === 'string' && raw.trim() !== '') {
        const cookieResult = await send('Network.getCookies', { urls: [LOGIN_URL] }, sessionId)
        const header = cookieHeader(cookieResult?.result?.cookies ?? [])
        if (header.includes('ds_session_id=')) {
          const candidate = { userToken: raw.trim(), cookie: header }
          const signature = `${candidate.userToken}|${candidate.cookie}`
          // Validate only when the values change, so polling stays cheap while the
          // user is still typing, and a guest session never counts as success.
          if (signature !== lastProbe) {
            lastProbe = signature
            if (await looksSignedIn(candidate, loginSignal)) {
              await send('Browser.close').catch(() => {})
              return { ...candidate, capturedAt: Date.now() }
            }
          }
        }
      }
      await delay(POLL_MS, undefined, { signal: loginSignal })
    }
  } catch (error) {
    if (timeout.aborted) throw new Error('等待登录超时')
    if (loginSignal.aborted) throw loginSignal.reason
    throw error
  } finally {
    connection?.socket?.close?.()
    await cleanup()
  }
}

/** Serialize one attempt at a time so a double click cannot open two windows. */
let running = null

export function startLogin(options) {
  if (running !== null) return running
  running = runLogin(options).finally(() => {
    running = null
  })
  return running
}

export function isLoginRunning() {
  return running !== null
}
