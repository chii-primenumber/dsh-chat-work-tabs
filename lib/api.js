import { solvePow, encodePowResponse } from './pow.js'

/** Web origin of the DeepSeek chat product (not the API platform). */
export const ORIGIN = 'https://chat.deepseek.com'
/** Path the proof-of-work challenge must be issued for. */
export const COMPLETION_PATH = '/api/v0/chat/completion'

const CLIENT_VERSION = '2.7.1'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const DEFAULT_TIMEOUT_MS = 180000

/** Failure from the web endpoint, carrying the surfaces the adapter reports. */
export class DeepSeekWebError extends Error {
  constructor(message, { status, code, expired = false } = {}) {
    super(message)
    this.name = 'DeepSeekWebError'
    this.status = status
    this.code = code
    this.expired = expired
  }
}

function timezoneOffsetSeconds() {
  return String(-new Date().getTimezoneOffset() * 60)
}

export function baseHeaders(auth) {
  const headers = {
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    origin: ORIGIN,
    referer: `${ORIGIN}/`,
    'user-agent': USER_AGENT,
    'x-client-platform': 'web',
    'x-client-version': CLIENT_VERSION,
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-locale': 'zh_CN',
    'x-client-timezone-offset': timezoneOffsetSeconds(),
    'x-device-id': auth.deviceId,
    'x-device-model': '',
  }
  // A cookie-only credential omits the header entirely: sending `Bearer ` with an
  // empty value is rejected outright instead of falling back to the cookie.
  if (auth.token) headers.authorization = `Bearer ${auth.token}`
  if (auth.cookie) headers.cookie = auth.cookie
  return headers
}

function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms)
  if (!signal) return timeout
  return AbortSignal.any([signal, timeout])
}

/**
 * Read one JSON envelope, requiring the platform's `code === 0` success marker.
 * A missing `biz_data` on the challenge call is the documented expired-token signal.
 */
async function postJson(path, auth, body, { signal, timeoutMs = 60000, requiresBizData = true } = {}) {
  let response
  try {
    response = await fetch(ORIGIN + path, {
      method: 'POST',
      headers: { ...baseHeaders(auth), 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: withTimeout(signal, timeoutMs),
    })
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error
    throw new DeepSeekWebError(`request to ${path} failed: ${error?.message ?? error}`)
  }

  const text = await response.text()
  let envelope
  try {
    envelope = JSON.parse(text)
  } catch {
    throw new DeepSeekWebError(`${path} returned a non-JSON body (HTTP ${response.status})`, { status: response.status })
  }

  const code = envelope?.code
  if (!response.ok || (code !== undefined && code !== 0)) {
    throw new DeepSeekWebError(
      `${path} failed: ${envelope?.msg ?? `HTTP ${response.status}`} (code ${code ?? response.status})`,
      { status: response.status, code },
    )
  }
  if (requiresBizData && (envelope?.data?.biz_data === null || envelope?.data?.biz_data === undefined)) {
    throw new DeepSeekWebError(
      `${path} returned no biz_data; the web credential is most likely expired`,
      { status: response.status, code, expired: true },
    )
  }
  return envelope
}

/** Fetch a proof-of-work challenge for the completion endpoint. */
export async function createPowChallenge(auth, { signal, targetPath = COMPLETION_PATH } = {}) {
  const envelope = await postJson('/api/v0/chat/create_pow_challenge', auth, { target_path: targetPath }, { signal })
  const biz = envelope.data.biz_data
  // The endpoint wraps the challenge one level deeper than the payload its own
  // consumers expect: biz_data is `{ challenge: { algorithm, salt, ... } }`.
  return biz?.challenge ?? biz
}

/** Path that accepts one uploaded attachment. */
export const UPLOAD_PATH = '/api/v0/file/upload_file'

/**
 * Upload one file and return its web-side id.
 *
 * The attachment endpoint demands its own proof of work, minted for this exact
 * path, and a proof is single use: every upload needs a fresh challenge.
 */
export async function uploadFile(auth, { name, type = 'application/octet-stream', bytes, signal } = {}) {
  if (!bytes || bytes.length === 0) throw new DeepSeekWebError('不能上传空文件')
  const challenge = await createPowChallenge(auth, { signal, targetPath: UPLOAD_PATH })
  const answer = await solvePow(challenge)
  const powHeader = encodePowResponse(challenge, answer, challenge.target_path ?? UPLOAD_PATH)

  const form = new FormData()
  form.append('file', new Blob([bytes], { type }), name || 'file')
  const headers = baseHeaders(auth)
  // fetch must own the multipart boundary, so the JSON content type is dropped.
  delete headers['content-type']
  headers['x-ds-pow-response'] = powHeader

  let response
  try {
    response = await fetch(ORIGIN + UPLOAD_PATH, { method: 'POST', headers, body: form, signal })
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error
    throw new DeepSeekWebError(`upload request failed: ${error?.message ?? error}`)
  }

  const text = await response.text()
  let envelope
  try {
    envelope = JSON.parse(text)
  } catch {
    throw new DeepSeekWebError(`upload returned a non-JSON body (HTTP ${response.status})`, { status: response.status })
  }
  const code = envelope?.code
  if (!response.ok || (code !== undefined && code !== 0)) {
    throw new DeepSeekWebError(
      `upload failed: ${envelope?.msg ?? `HTTP ${response.status}`} (code ${code ?? response.status})`,
      { status: response.status, code },
    )
  }
  const biz = envelope?.data?.biz_data
  if (typeof biz?.id !== 'string' || biz.id === '') {
    throw new DeepSeekWebError('upload returned no file id')
  }
  return {
    id: biz.id,
    name: typeof biz.file_name === 'string' ? biz.file_name : name,
    size: typeof biz.file_size === 'number' ? biz.file_size : bytes.length,
    status: typeof biz.status === 'string' ? biz.status : 'PENDING',
  }
}

/** Read one upload's processing state. */
export async function fetchFileInfo(auth, fileId, { signal } = {}) {
  const response = await fetch(
    `${ORIGIN}/api/v0/file/fetch_files?file_ids=${encodeURIComponent(fileId)}`,
    { headers: baseHeaders(auth), signal },
  )
  const text = await response.text()
  let envelope
  try {
    envelope = JSON.parse(text)
  } catch {
    return null
  }
  if (envelope?.code !== 0) return null
  const biz = envelope?.data?.biz_data
  const list = Array.isArray(biz) ? biz : (Array.isArray(biz?.files) ? biz.files : [])
  return list.find((entry) => entry?.id === fileId) ?? null
}

/**
 * Wait until the web side has parsed the upload.
 *
 * A turn cannot reference a file the server is still PARSING, so the caller needs
 * this before it puts the id into `ref_file_ids`.
 */
export async function waitForFile(auth, fileId, { signal, timeoutMs = 45000, intervalMs = 700 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  for (;;) {
    last = await fetchFileInfo(auth, fileId, { signal })
    if (last?.status === 'SUCCESS') return last
    if (last?.status === 'FAILED') {
      throw new DeepSeekWebError(`文件解析失败：${last?.error_code ?? 'unknown'}`)
    }
    if (Date.now() >= deadline) throw new DeepSeekWebError('文件解析超时')
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** Create a fresh web chat session and return its id. */
export async function createChatSession(auth, { signal } = {}) {
  const envelope = await postJson('/api/v0/chat_session/create', auth, {}, { signal })
  const id = envelope?.data?.biz_data?.chat_session?.id
  if (typeof id !== 'string' || id === '') {
    throw new DeepSeekWebError('chat_session/create returned no session id')
  }
  return id
}

/** Yield raw `{p, v}` frames from one SSE response body. */
async function* readFrames(response) {
  if (!response.body) throw new DeepSeekWebError('completion returned no response body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '' || payload === '[DONE]') continue
        try {
          yield JSON.parse(payload)
        } catch {
          // A partial or non-JSON keep-alive line carries nothing to render.
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

/**
 * Stream one completion turn.
 *
 * Yields `{ kind: 'thought' | 'text', text }` deltas and a final
 * `{ kind: 'done', messageId, modelType }`. Fragment `type` decides the channel:
 * `THINK` is reasoning, everything else is answer text.
 */
export async function* streamCompletion(auth, {
  chatSessionId,
  parentMessageId = null,
  prompt,
  thinkingEnabled = false,
  searchEnabled = false,
  refFileIds = [],
  modelType = 'default',
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const challenge = await createPowChallenge(auth, { signal })
  const answer = await solvePow(challenge)
  const powHeader = encodePowResponse(challenge, answer, COMPLETION_PATH)

  const body = {
    chat_session_id: chatSessionId,
    parent_message_id: parentMessageId,
    model_type: modelType,
    prompt,
    ref_file_ids: Array.isArray(refFileIds) ? refFileIds : [],
    thinking_enabled: Boolean(thinkingEnabled),
    search_enabled: Boolean(searchEnabled),
    action: null,
    preempt: false,
  }

  let response
  try {
    response = await fetch(ORIGIN + COMPLETION_PATH, {
      method: 'POST',
      headers: {
        ...baseHeaders(auth),
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'x-ds-pow-response': powHeader,
      },
      body: JSON.stringify(body),
      signal: withTimeout(signal, timeoutMs),
    })
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error
    throw new DeepSeekWebError(`completion request failed: ${error?.message ?? error}`)
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new DeepSeekWebError(
      `completion failed: HTTP ${response.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
      { status: response.status },
    )
  }

  let currentPath = null
  let currentFragmentId = null
  let currentType = 'RESPONSE'
  let emitted = 0
  let messageId = null

  /** A real fragment always carries a numeric id and a string type. */
  const isFragment = (value) => value !== null && typeof value === 'object'
    && typeof value.id === 'number' && typeof value.type === 'string'

  /**
   * Point the parser at the fragment the next deltas belong to.
   *
   * A thinking turn opens `THINK` first and then publishes the answer fragment
   * separately; missing that switch labels the whole answer as reasoning.
   */
  const beginFragment = (fragment) => {
    if (fragment.id === currentFragmentId) return
    currentFragmentId = fragment.id
    currentType = fragment.type
    emitted = 0
  }

  for await (const frame of readFrames(response)) {
    // Continuation frames omit `p` and inherit the previous path.
    if (typeof frame?.p === 'string') currentPath = frame.p
    const value = frame?.v

    if (typeof frame?.response_message_id === 'number') messageId = frame.response_message_id
    if (typeof value?.response_message_id === 'number') messageId = value.response_message_id
    if (typeof value?.response?.message_id === 'number') messageId = value.response.message_id

    // A frame that lists fragments names the current one: either a whole-response
    // object, or the `response/fragments` array published when a new fragment opens.
    // Other arrays on this path (search results, tool payloads) are not fragments.
    const listing = Array.isArray(value)
      ? value
      : (Array.isArray(value?.response?.fragments) ? value.response.fragments : null)
    if (listing !== null && listing.length > 0 && isFragment(listing[listing.length - 1])) {
      const last = listing[listing.length - 1]
      beginFragment(last)
      const content = typeof last.content === 'string' ? last.content : ''
      if (content.length > emitted) {
        const text = content.slice(emitted)
        emitted = content.length
        // Only RESPONSE is answer text; THINK, TOOL_* and TIP belong in reasoning.
        yield { kind: currentType === 'RESPONSE' ? 'text' : 'thought', text }
      }
      continue
    }

    // `response/fragments/-1` carrying a fragment opens the next one (with or
    // without its first chunk of content) before any plain deltas arrive.
    if (isFragment(value)
      && (currentPath === 'response/fragments/-1' || currentPath === 'response/fragments')) {
      beginFragment(value)
      const content = typeof value.content === 'string' ? value.content : ''
      if (content.length > 0) {
        emitted = content.length
        yield { kind: currentType === 'RESPONSE' ? 'text' : 'thought', text: content }
      }
      continue
    }

    // A string delta appends to the fragment named by the inherited path.
    if (typeof value === 'string' && value !== ''
      && (currentPath === 'response/fragments/-1/content' || currentPath === 'response/content')) {
      emitted += value.length
      yield { kind: currentType === 'RESPONSE' ? 'text' : 'thought', text: value }
      continue
    }

    if (value?.type === 'error') {
      throw new DeepSeekWebError(`completion stream reported an error: ${value?.content ?? 'unknown'}`)
    }
  }

  yield { kind: 'done', messageId, modelType }
}
