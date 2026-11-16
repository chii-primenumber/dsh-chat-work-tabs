import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
function connect(wsUrl) {
  const socket = new WebSocket(wsUrl)
  let nextId = 0
  const pending = new Map()

  socket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    const settle = pending.get(message.id)
    if (settle === undefined) return
    pending.delete(message.id)
    settle(message)
  })

  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('DevTools 连接失败')), { once: true })
  })

  const send = (method, params = {}, sessionId) => new Promise((resolve) => {
    const id = ++nextId
    pending.set(id, resolve)
    socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
  })

  return { socket, opened, send }
}

async function waitForDevTools(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return await response.json()
    } catch {
      // The browser has not opened its debugging port yet.
    }
    if (Date.now() >= deadline) throw new Error('浏览器没有打开调试端口')
    await sleep(250)
  }
}

/** Pick the page target that shows the chat product. */
async function findPageTarget(send, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const response = await send('Target.getTargets')
    const infos = response?.result?.targetInfos ?? []
    const pages = infos.filter((info) => info.type === 'page')
    const chat = pages.find((info) => typeof info.url === 'string' && info.url.includes('chat.deepseek.com'))
    if (chat !== undefined) return chat
    if (Date.now() >= deadline) {
      // The user may have navigated somewhere odd; the only page left is still
      // worth attaching to so the flow can report a useful failure.
      if (pages.length > 0) return pages[0]
      throw new Error('没有找到登录页面')
    }
    await sleep(400)
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
async function looksSignedIn(credential) {
  try {
    const url = new URL('/api/v0/users/current', ORIGIN)
    const response = await fetch(url, {
      headers: baseHeaders({ token: credential.userToken, cookie: credential.cookie, deviceId: 'dsh-login-probe' }),
      signal: AbortSignal.timeout(10000),
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
export async function runLogin({ logger, timeoutMs = 600000, browserPath, headless = false } = {}) {
  const executable = browserPath ?? findBrowser()
  if (executable === null) throw new Error('找不到 Edge 或 Chrome，无法打开登录窗口')

  const profile = mkdtempSync(join(tmpdir(), 'dsh-chat-login-'))
  const port = 40000 + Math.floor(Math.random() * 8000)
  const args = [
    ...(headless ? ['--headless=new'] : []),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msEdgeFirstRunExperience',
    '--new-window',
    LOGIN_URL,
  ]

  logger?.info?.(`dsh-chat-work-tabs: 打开登录窗口 ${executable}`)
  const child = spawn(executable, args, { stdio: 'ignore', detached: false })
  let exited = false
  const childExited = new Promise((resolve) => {
    child.once('exit', () => {
      exited = true
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

  const deadline = Date.now() + timeoutMs
  let connection = null
  let lastProbe = ''

  try {
    const version = await waitForDevTools(port, 30000)
    connection = connect(version.webSocketDebuggerUrl)
    await connection.opened
    const { send } = connection

    const page = await findPageTarget(send, 30000)
    const attached = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
    const sessionId = attached?.result?.sessionId
    if (sessionId === undefined) throw new Error('无法附加到登录页面')

    for (;;) {
      if (exited) throw new Error('登录窗口已关闭')
      if (Date.now() >= deadline) throw new Error('等待登录超时')

      const evaluated = await send('Runtime.evaluate', {
        expression: 'localStorage.getItem("userToken")',
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
            if (await looksSignedIn(candidate)) {
              await send('Browser.close').catch(() => {})
              return { ...candidate, capturedAt: Date.now() }
            }
          }
        }
      }
      await sleep(POLL_MS)
    }
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
