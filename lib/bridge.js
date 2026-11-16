import { createServer } from 'node:http'
import { once } from 'node:events'
import { fetchMessages, fetchSessions } from './history.js'
import { createChatSession, uploadFile, waitForFile } from './api.js'

// Extend the existing loopback bridge; never replace the GUI server.
const DEFAULT_PORT = 45871
const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EFFORTS = new Set(['off', 'think', 'search', 'think-search'])
const MAX_BODY = 256 * 1024
/** Attachments travel as raw bytes, so they get their own, larger ceiling. */
const MAX_UPLOAD = 32 * 1024 * 1024
const FILE_ID = /^file-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function allowedOrigin(origin) {
  return origin === 'dsh-app://app' || (typeof origin === 'string' && LOCAL_ORIGIN.test(origin))
}
function cors(origin) {
  return allowedOrigin(origin) ? { 'access-control-allow-origin': origin, vary: 'origin' } : {}
}
function respond(res, status, payload, origin) {
  if (res.destroyed || res.writableEnded) return
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body), ...cors(origin),
  })
  res.end(body)
}
async function readBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw Object.assign(new Error('消息过长。'), { httpStatus: 413 })
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw Object.assign(new Error('请求格式无效。'), { httpStatus: 400 }) }
}
async function readRaw(req, limit) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw Object.assign(new Error('文件过大。'), { httpStatus: 413 })
    chunks.push(chunk)
  }
  if (size === 0) throw Object.assign(new Error('文件为空。'), { httpStatus: 400 })
  return Buffer.concat(chunks)
}
function sessionId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw Object.assign(new Error('会话标识无效。'), { httpStatus: 400 })
  return value
}
export function startBridge({ readAuth, adapter, port = DEFAULT_PORT, logger } = {}) {
  const busy = new Set()
  const controllers = new Set()
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin
    // Reject foreign websites before reading credentials or mutating the account.
    if (origin !== undefined && !allowedOrigin(origin)) {
      respond(res, 403, { error: '不允许此页面访问聊天。' }, origin)
      return
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors(origin),
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' })
      res.end()
      return
    }
    if (!['GET', 'POST'].includes(req.method)) {
      respond(res, 405, { error: 'method not allowed' }, origin)
      return
    }
    let url
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      respond(res, 400, { error: 'bad request' }, origin)
      return
    }
    // Attachments arrive as raw bytes; every other POST is a JSON command.
    const isUpload = req.method === 'POST' && url.pathname === '/upload'
    if (req.method === 'POST' && !allowedOrigin(origin)) {
      respond(res, 403, { error: '聊天请求必须来自 DSH 界面。' }, origin)
      return
    }
    if (req.method === 'POST' && !isUpload && !/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) {
      respond(res, 403, { error: '聊天请求必须来自 DSH 界面。' }, origin)
      return
    }
    const controller = new AbortController()
    controllers.add(controller)
    res.on('close', () => { controller.abort(); controllers.delete(controller) })
    let lockedId
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        respond(res, 200, { ok: true, chat: true }, origin)
      } else if (req.method === 'GET' && url.pathname === '/sessions') {
        respond(res, 200, await fetchSessions(await readAuth(), { count: url.searchParams.get('count') ?? 40, signal: controller.signal }), origin)
      } else if (req.method === 'GET' && url.pathname === '/messages') {
        respond(res, 200, await fetchMessages(await readAuth(), sessionId(url.searchParams.get('id')), { signal: controller.signal }), origin)
      } else if (req.method === 'POST' && url.pathname === '/sessions') {
        await readBody(req)
        const id = await createChatSession(await readAuth(), { signal: controller.signal })
        respond(res, 200, { id }, origin)
      } else if (req.method === 'POST' && url.pathname === '/upload') {
        const rawType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : ''
        const bytes = await readRaw(req, MAX_UPLOAD)
        const name = (url.searchParams.get('name') ?? 'file').trim().slice(0, 180) || 'file'
        const auth = await readAuth()
        const uploaded = await uploadFile(auth, { name, type: rawType || 'application/octet-stream', bytes, signal: controller.signal })
        // A turn may only reference a file the web side has finished parsing.
        const ready = await waitForFile(auth, uploaded.id, { signal: controller.signal })
        respond(res, 200, {
          id: uploaded.id,
          name: uploaded.name,
          size: uploaded.size,
          status: ready?.status ?? 'SUCCESS',
        }, origin)
      } else if (req.method === 'POST' && url.pathname === '/messages') {
        const body = await readBody(req)
        const id = sessionId(body.id)
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
        const files = Array.isArray(body.files)
          ? body.files.filter((value) => typeof value === 'string' && FILE_ID.test(value)).slice(0, 8)
          : []
        if ((!prompt && files.length === 0) || !EFFORTS.has(body.effort ?? 'off')) throw Object.assign(new Error('消息或思考选项无效。'), { httpStatus: 400 })
        if (!adapter) throw new Error('聊天服务尚未就绪。')
        if (busy.has(id)) throw Object.assign(new Error('这段对话正在回复，请稍后继续。'), { httpStatus: 409 })
        busy.add(id)
        lockedId = id
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform', 'x-content-type-options': 'nosniff', ...cors(origin) })
        res.flushHeaders()
        for await (const event of adapter.stream({
          sessionId: `web-${id}`, provider: 'deepseek-web', model: 'chat',
          reasoningEffort: body.effort ?? 'off', refFileIds: files,
          messages: [{ role: 'user', content: prompt || '请阅读附件。' }], signal: controller.signal,
        })) {
          if (controller.signal.aborted) break
          if (!res.write(`data: ${JSON.stringify(event)}\n\n`)) await once(res, 'drain', { signal: controller.signal })
        }
        res.end()
      } else respond(res, 404, { error: 'not found' }, origin)
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error?.message ?? String(error)
        logger?.warn?.(`dsh-deepseek-web bridge: ${message}`)
        if (res.headersSent) res.end(`data: ${JSON.stringify({ type: 'finish', reason: { kind: 'error', failure: { message } } })}\n\n`)
        else respond(res, error.httpStatus ?? 502, { error: message }, origin)
      }
    } finally {
      if (lockedId) busy.delete(lockedId)
      controllers.delete(controller)
    }
  })
  server.on('error', (error) => logger?.warn?.(`dsh-deepseek-web bridge: ${error?.message ?? error}`))
  const close = server.close.bind(server)
  server.close = (...args) => {
    for (const controller of controllers) controller.abort()
    return close(...args)
  }
  server.listen(port, '127.0.0.1')
  return server
}
export { DEFAULT_PORT }
