import { baseHeaders, ORIGIN, DeepSeekWebError } from './api.js'

/**
 * The web product's own read endpoints.
 *
 * These are the calls the chat.deepseek.com sidebar makes, and they are why the
 * account's history is reachable at all: `fetch_page` lists sessions,
 * `history_messages` returns one session's transcript. Neither is part of the
 * public API surface, so both are treated as discovery — a shape change here
 * degrades the history view instead of breaking chat.
 */

async function getJson(path, auth, { signal } = {}) {
  const response = await fetch(ORIGIN + path, {
    method: 'GET',
    headers: baseHeaders(auth),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
  })
  const text = await response.text()
  let envelope
  try {
    envelope = JSON.parse(text)
  } catch {
    throw new Error(`${path} returned a non-JSON body (HTTP ${response.status})`)
  }
  const code = envelope?.code
  if (!response.ok || (code !== undefined && code !== 0)) {
    throw new DeepSeekWebError(`读取网页版记录失败：${envelope?.msg || `HTTP ${response.status}`}`, { status: response.status, code })
  }
  const business = envelope?.data
  if (business?.biz_code !== 0 || business?.biz_data == null) {
    throw new DeepSeekWebError(`读取网页版记录失败：${business?.biz_msg || '接口未返回有效记录，请检查网页登录状态。'}`, { status: response.status, code: business?.biz_code })
  }
  return envelope
}

/** Text of every fragment of one type, joined in the order the server sent them. */
function fragmentText(fragments, type) {
  const parts = []
  for (const fragment of fragments) {
    if (fragment?.type !== type) continue
    if (typeof fragment.content === 'string' && fragment.content !== '') parts.push(fragment.content)
  }
  return parts.join('')
}

function secondsToMs(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1000) : null
}

/** List the account's recent web sessions, newest first. */
export async function fetchSessions(auth, { count = 30, signal } = {}) {
  const safeCount = Math.min(Math.max(Math.trunc(Number(count) || 40), 20), 100)
  const envelope = await getJson(`/api/v0/chat_session/fetch_page?count=${safeCount}`, auth, { signal })
  const biz = envelope?.data?.biz_data ?? {}
  const rows = Array.isArray(biz.chat_sessions) ? biz.chat_sessions : []
  const sessions = []
  for (const row of rows) {
    const id = typeof row?.id === 'string' ? row.id.trim() : ''
    if (id === '') continue
    const title = typeof row?.title === 'string' ? row.title.trim() : ''
    sessions.push({
      id,
      title: title === '' ? '（无标题）' : title,
      modelType: typeof row?.model_type === 'string' ? row.model_type : 'default',
      pinned: row?.pinned === true,
      updatedAt: secondsToMs(row?.updated_at),
    })
  }
  return { sessions, hasMore: biz.has_more === true }
}

/** Read one web session's transcript in a UI-ready shape. */
export async function fetchMessages(auth, chatSessionId, { signal } = {}) {
  const id = typeof chatSessionId === 'string' ? chatSessionId.trim() : ''
  if (id === '') throw new Error('fetchMessages requires a chat session id')
  const envelope = await getJson(
    `/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(id)}`,
    auth,
    { signal },
  )
  const biz = envelope?.data?.biz_data ?? {}
  const rows = Array.isArray(biz.chat_messages) ? biz.chat_messages : []
  const messages = []
  for (const row of rows) {
    const fragments = Array.isArray(row?.fragments) ? row.fragments : []
    const isUser = String(row?.role ?? '').toUpperCase() === 'USER'
    // A user turn keeps its text in a REQUEST fragment; an assistant turn splits
    // reasoning into THINK and the answer into RESPONSE.
    const text = isUser ? fragmentText(fragments, 'REQUEST') || fragmentText(fragments, 'RESPONSE') : fragmentText(fragments, 'RESPONSE')
    const thinking = isUser ? '' : fragmentText(fragments, 'THINK')
    if (!['USER', 'ASSISTANT'].includes(String(row?.role ?? '').toUpperCase())) continue
    messages.push({
      messageId: typeof row?.message_id === 'number' ? row.message_id : null,
      parentId: typeof row?.parent_id === 'number' ? row.parent_id : null,
      role: isUser ? 'user' : 'assistant',
      text,
      thinking,
      thinkingEnabled: row?.thinking_enabled === true,
      searchEnabled: row?.search_enabled === true,
      searchTriggered: row?.search_triggered === true,
      status: typeof row?.status === 'string' ? row.status : '',
      insertedAt: secondsToMs(row?.inserted_at),
    })
  }
  // Follow the web page's selected branch, rather than blindly continuing the
  // last item of an array that may contain regenerated alternatives.
  const currentMessageId = biz?.chat_session?.current_message_id
  const byId = new Map(messages.map((message) => [message.messageId, message]))
  const branch = []
  const seen = new Set()
  let cursor = currentMessageId
  if (messages.length && !byId.has(cursor)) throw new Error('网页版当前消息位置无法匹配，请刷新后重试。')
  while (byId.has(cursor)) {
    if (seen.has(cursor)) throw new Error('网页版消息关系异常，请在网页确认后重试。')
    seen.add(cursor)
    const message = byId.get(cursor)
    branch.push(message)
    cursor = message.parentId
  }
  branch.reverse()
  return {
    id: typeof biz?.chat_session?.id === 'string' ? biz.chat_session.id : id,
    title: typeof biz?.chat_session?.title === 'string' ? biz.chat_session.title : '',
    currentMessageId: typeof currentMessageId === 'number' ? currentMessageId : null,
    messages: branch,
  }
}
