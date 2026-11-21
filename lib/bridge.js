import { randomBytes, timingSafeEqual } from 'node:crypto'
import { fetchMessages, fetchSessions } from './history.js'
import { createChatSession, uploadFile, waitForFile } from './api.js'
import { startLogin } from './login.js'

const PREFIX = '/api/chat-work-tabs'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FILE_ID = /^file-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EFFORTS = new Set(['off', 'think', 'search', 'think-search'])
const MAX_BODY = 256 * 1024
const MAX_UPLOAD = 32 * 1024 * 1024
const MAX_ATTACHMENTS = 8

function fail(message, httpStatus = 400) {
  return Object.assign(new Error(message), { httpStatus })
}

function json(payload, status = 200) {
  return Response.json(payload, { status, headers: { 'cache-control': 'no-store' } })
}

async function readBytes(request, limit, message) {
  const chunks = []
  let size = 0
  if (Number(request.headers.get('content-length')) > limit) throw fail(message, 413)
  if (request.body) {
    for await (const chunk of request.body) {
      size += chunk.byteLength
      if (size > limit) throw fail(message, 413)
      chunks.push(chunk)
    }
  }
  return Buffer.concat(chunks, size)
}

async function readJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) {
    throw fail('请求格式无效。', 415)
  }
  const bytes = await readBytes(request, MAX_BODY, '消息过长。')
  try {
    const value = JSON.parse(bytes.toString('utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value
  } catch {
    throw fail('请求格式无效。')
  }
}

function sessionId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw fail('会话标识无效。')
  return value
}

function replyStream(adapter, options, busy, id, requestSignal, lifetimeSignal, logger) {
  const controller = new AbortController()
  const signal = AbortSignal.any([requestSignal, lifetimeSignal, controller.signal])
  const iterator = adapter.stream({ ...options, signal })[Symbol.asyncIterator]()
  const encoder = new TextEncoder()
  const encode = (event) => encoder.encode('data: ' + JSON.stringify(event) + '\n\n')
  let released = false
  const release = () => {
    if (released) return
    released = true
    busy.delete(id)
  }
  let closing
  const closeIterator = () => (closing ??= Promise.resolve(iterator.return?.()).finally(release))
  return new Response(new ReadableStream({
    async pull(stream) {
      try {
        const { done, value } = await iterator.next()
        if (signal.aborted) {
          await closeIterator()
          if (!controller.signal.aborted) stream.close()
        } else if (done) {
          release()
          stream.close()
        } else {
          stream.enqueue(encode(value))
        }
      } catch (error) {
        release()
        if (!signal.aborted) {
          const message = error?.message ?? String(error)
          logger?.warn?.('chat-work-tabs stream: ' + message)
          stream.enqueue(encode({ type: 'finish', reason: { kind: 'error', failure: { message } } }))
        }
        if (!controller.signal.aborted) stream.close()
      }
    },
    async cancel() {
      controller.abort()
      await closeIterator()
    },
  }), {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'x-content-type-options': 'nosniff',
    },
  })
}

/** Only register these routes on DSH's authenticated owner-only connection. */
export function createChatBridge({ readAuth, saveAuth, adapter, logger, signal: lifetimeSignal }) {
  const token = randomBytes(32).toString('base64url')
  const tokenBytes = Buffer.from(token)
  const busy = new Set()
  const route = (path, methods, handle) => ({
    path: PREFIX + path,
    methods,
    requestBody: methods.includes('POST') ? 'streaming' : 'buffered',
    async fetch(request) {
      if (lifetimeSignal.aborted) return json({ error: '聊天服务已关闭。' }, 503)
      if (path === '/bootstrap') {
        if (request.headers.get('x-dsh-chat-bootstrap') !== '1') return json({ error: '请从 DSH 界面打开聊天。' }, 403)
      } else {
        const supplied = Buffer.from(request.headers.get('x-dsh-chat-token') ?? '')
        if (supplied.length !== tokenBytes.length || !timingSafeEqual(tokenBytes, supplied)) {
          return json({ error: '聊天连接已失效，请重试。' }, 401)
        }
      }
      const signal = AbortSignal.any([request.signal, lifetimeSignal])
      try {
        return await handle(request, new URL(request.url), signal)
      } catch (error) {
        if (signal.aborted) return json({ error: '聊天请求已取消。' }, 499)
        const message = error?.message ?? String(error)
        logger?.warn?.('chat-work-tabs: ' + message)
        return json({ error: message }, error?.httpStatus ?? 502)
      }
    },
  })

  return [
    route('/bootstrap', ['GET'], () => json({ token })),
    route('/login', ['POST'], async (request, _url, signal) => {
      await readJson(request)
      const captured = await startLogin({ logger, signal })
      signal.throwIfAborted()
      await saveAuth({ userToken: captured.userToken, cookie: captured.cookie })
      return json({ ok: true })
    }),
    route('/sessions', ['GET'], async (_request, url, signal) =>
      json(await fetchSessions(await readAuth(), { count: url.searchParams.get('count') ?? 40, signal }))),
    route('/sessions/create', ['POST'], async (request, _url, signal) => {
      await readJson(request)
      return json({ id: await createChatSession(await readAuth(), { signal }) })
    }),
    route('/upload', ['POST'], async (request, url, signal) => {
      const bytes = await readBytes(request, MAX_UPLOAD, '文件过大。')
      if (bytes.length === 0) throw fail('文件为空。')
      const type = request.headers.get('content-type') || 'application/octet-stream'
      const name = (url.searchParams.get('name') ?? '').trim().slice(0, 180) || 'file'
      const auth = await readAuth()
      const uploaded = await uploadFile(auth, { name, type, bytes, signal })
      await waitForFile(auth, uploaded.id, { signal })
      return json({ id: uploaded.id, name: uploaded.name, size: uploaded.size, status: 'SUCCESS' })
    }),
    route('/messages', ['GET'], async (_request, url, signal) =>
      json(await fetchMessages(await readAuth(), sessionId(url.searchParams.get('id')), { signal }))),
    route('/messages/send', ['POST'], async (request) => {
      const body = await readJson(request)
      const id = sessionId(body.id)
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
      const files = body.files ?? []
      if (!Array.isArray(files) || files.length > MAX_ATTACHMENTS || files.some((value) => typeof value !== 'string' || !FILE_ID.test(value))) {
        throw fail('附件无效，或数量超过每条消息 8 个的上限。')
      }
      if ((!prompt && files.length === 0) || !EFFORTS.has(body.effort ?? 'off')) throw fail('消息或思考选项无效。')
      if (busy.has(id)) throw fail('这段对话正在回复，请稍后继续。', 409)
      busy.add(id)
      return replyStream(adapter, {
        sessionId: 'web-' + id, provider: 'deepseek-web', model: 'chat',
        reasoningEffort: body.effort ?? 'off', refFileIds: files,
        messages: [{ role: 'user', content: prompt || '请阅读附件。' }],
      }, busy, id, request.signal, lifetimeSignal, logger)
    }),
  ]
}
