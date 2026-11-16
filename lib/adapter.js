import { randomUUID } from 'node:crypto'
import { createChatSession, streamCompletion, DeepSeekWebError } from './api.js'
import { fetchMessages } from './history.js'

/** Provider route this adapter serves. */
export const PROVIDER_ID = 'deepseek-web'

const CONTEXT_WINDOW = 131072
const MAX_OUTPUT_TOKENS = 8192

/**
 * One entry only: the deep-thinking and smart-search switches are not models, and
 * each variation listed here would clutter every model picker in the app.
 */
const MODELS = [
  {
    provider: PROVIDER_ID,
    id: 'chat',
    name: 'DeepSeek 网页版',
    description: 'DeepSeek 网页端对话接口（chat.deepseek.com），使用你已登录的网页账号。',
  },
]

/**
 * The two switches make four states, and reasoning effort is the only per-call
 * control this route carries: `GenerateOptions.reasoningEffort` reaches the
 * adapter's `stream`, so the variants cost nothing in the model catalog.
 */
const EFFORTS = [
  { id: 'off', name: '普通对话', description: '不开启深度思考，也不联网搜索。' },
  { id: 'think', name: '深度思考', description: '先推理再作答。' },
  { id: 'search', name: '智能搜索', description: '联网检索后再作答。' },
  { id: 'think-search', name: '深度思考 + 智能搜索', description: '推理并联网检索后再作答。' },
]

const EFFORT_IDS = new Set(EFFORTS.map((entry) => entry.id))

/** The earlier four-model layout, still honored so old sessions keep working. */
const LEGACY_EFFORT = {
  chat: 'off',
  reasoner: 'think',
  'chat-search': 'search',
  'reasoner-search': 'think-search',
}

/** Resolve the requested combination, falling back for a bare or legacy route. */
function effortOf(options) {
  const chosen = typeof options.reasoningEffort === 'string' ? options.reasoningEffort : ''
  if (EFFORT_IDS.has(chosen)) return chosen
  return LEGACY_EFFORT[options.model] ?? 'off'
}

/** Pull plain text out of one message's content blocks. */
function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('')
}

function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role === 'user') return messageText(message)
  }
  return ''
}

function userTurnCount(messages) {
  let count = 0
  for (const message of messages) if (message?.role === 'user') count++
  return count
}

/**
 * Compose the prompt for a brand-new web session: the system prompt and any
 * earlier turns have no home on the web side, so they ride along as transcript.
 */
function composeOpeningPrompt(options) {
  const parts = []
  const system = typeof options.system === 'string' ? options.system.trim() : ''
  if (system !== '') parts.push(system)
  for (const message of options.messages) {
    const text = messageText(message).trim()
    if (text === '') continue
    if (message.role === 'user') parts.push(`【用户】\n${text}`)
    else if (message.role === 'assistant') parts.push(`【助手】\n${text}`)
    else if (message.role === 'system' || message.role === 'developer') parts.push(text)
  }
  return parts.join('\n\n')
}

/**
 * Adapter over the DeepSeek web chat endpoint.
 *
 * The web side is stateful: a turn is a new message under a chat session, so the
 * adapter remembers one `chat_session_id` + `parent_message_id` pair per DSH
 * Session and sends only the newest user turn. Whenever the remembered turn count
 * no longer matches the history DSH is replaying (fork, retry, compaction) it
 * starts a fresh web session and re-sends the transcript instead of risking a
 * mismatched parent.
 */
// A profile-installed bundle cannot resolve `@deepseek-ai/dsh-llm` (its
// node_modules holds no such scope), so this class implements the whole adapter
// surface directly instead of extending the shipped abstract base. The method
// set and return shapes follow that contract.
export class DeepSeekWebAdapter {
  /** @param {() => Promise<{token: string, cookie?: string, deviceId: string}>} readAuth */
  constructor(readAuth) {
    this.readAuth = readAuth
    this.sessions = new Map()
    this.deviceId = null
  }

  providerInfo(provider) {
    return { id: provider, name: 'DeepSeek 网页版' }
  }

  /** No adapter-owned retry policy: let the caller apply its defaults. */
  providerRetryPolicy() {
    return undefined
  }

  /** The web chat endpoint takes no request images. */
  imageRequestPricing() {
    return undefined
  }

  imageRequestTarget(_provider, _model, image) {
    return {
      width: image?.width ?? 0,
      height: image?.height ?? 0,
      maxBytes: 20 * 1024 * 1024,
    }
  }

  async listModels() {
    // Web chat belongs to the dedicated Chat page, not the Work model catalog.
    // Keep resolveModel/stream for existing sessions and the loopback bridge.
    return []
  }

  async prepareCall(provider, model, signal) {
    const resolved = await this.resolveModel(provider, model, signal)
    return {
      model: resolved,
      stream: (options) => this.stream(options),
    }
  }

  async resolveModel(provider, model) {
    const known = MODELS.find((entry) => entry.id === model)
    return {
      provider,
      id: model,
      name: known?.name ?? MODELS[0].name,
      description: known?.description ?? MODELS[0].description,
      context: { contextWindow: CONTEXT_WINDOW },
      defaultMaxTokens: MAX_OUTPUT_TOKENS,
      // Declaring the efforts is what lets the switches carry their state through
      // the selection instead of through extra catalog entries.
      reasoning: { efforts: EFFORTS, defaultEffort: 'off' },
    }
  }

  async auth() {
    const auth = await this.readAuth()
    if (this.deviceId === null) {
      this.deviceId = auth.deviceId ?? randomUUID()
    }
    return { ...auth, deviceId: this.deviceId }
  }

  async *stream(options) {
    const key = options.sessionId ?? 'anonymous'
    const messages = Array.isArray(options.messages) ? options.messages : []
    const turns = userTurnCount(messages)
    const effort = effortOf(options)
    const thinkingEnabled = effort === 'think' || effort === 'think-search'
    const searchEnabled = effort === 'search' || effort === 'think-search'
    // Bridge-only extension: attachment ids the web turn should reference. They
    // are not part of GenerateOptions, so an absent value simply sends none.
    const refFileIds = Array.isArray(options.refFileIds) ? options.refFileIds : []

    let auth
    try {
      auth = await this.auth()
    } catch (error) {
      yield errorFinish(error)
      return
    }

    const webMatch = typeof key === 'string' && key.match(/^web-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)
    let state = this.sessions.get(key)
    // Web history is authoritative. Re-read its selected leaf every turn so a
    // restart or a reply made on the website never starts a different chat.
    if (webMatch) {
      try {
        const history = await fetchMessages(auth, webMatch[1], { signal: options.signal })
        const leaf = history.messages.at(-1)
        if (leaf && (leaf.role !== 'assistant' || leaf.status !== 'FINISHED' || leaf.messageId === null)) {
          throw new Error('网页端最后一条回复尚未完成，请先在网页确认或完成回复，再刷新后续聊。')
        }
        state = { chatSessionId: webMatch[1], parentMessageId: leaf?.messageId ?? null, turns }
      } catch (error) {
        yield errorFinish(error)
        return
      }
    } else if (typeof key === 'string' && key.startsWith('web-')) {
      yield errorFinish(new Error('网页版会话标识无效，请从聊天列表重新打开。'))
      return
    }
    const incremental = state !== undefined && turns === state.turns
    let prompt
    if (incremental) {
      prompt = lastUserText(messages)
    } else {
      prompt = composeOpeningPrompt(options)
      state = undefined
    }
    if (prompt.trim() === '') {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    let chatSessionId
    try {
      if (state === undefined) {
        chatSessionId = await createChatSession(auth, { signal: options.signal })
      } else {
        chatSessionId = state.chatSessionId
      }
    } catch (error) {
      this.sessions.delete(key)
      yield errorFinish(error)
      return
    }

    let parentMessageId = state?.parentMessageId ?? null
    let thoughtIndex = -1
    let textIndex = -1
    let thoughtText = ''
    let textText = ''
    let blockCount = 0
    let sawOutput = false
    let done = null

    try {
      const stream = streamCompletion(auth, {
        chatSessionId,
        parentMessageId,
        prompt,
        thinkingEnabled,
        searchEnabled,
        refFileIds,
        signal: options.signal,
      })
      for await (const event of stream) {
        if (event.kind === 'thought') {
          if (thoughtIndex < 0) {
            thoughtIndex = blockCount++
            yield { type: 'block-start', index: thoughtIndex, blockType: 'reasoning' }
          }
          thoughtText += event.text
          yield { type: 'reasoning-delta', index: thoughtIndex, text: event.text }
          sawOutput = true
        } else if (event.kind === 'text') {
          if (thoughtIndex >= 0 && textIndex < 0) {
            yield { type: 'block-end', index: thoughtIndex, block: { type: 'reasoning', text: thoughtText } }
            thoughtIndex = -2
          }
          if (textIndex < 0) {
            textIndex = blockCount++
            yield { type: 'block-start', index: textIndex, blockType: 'text' }
          }
          textText += event.text
          yield { type: 'text-delta', index: textIndex, text: event.text }
          sawOutput = true
        } else if (event.kind === 'done') {
          done = event
        }
      }
    } catch (error) {
      this.sessions.delete(key)
      // Settle whatever already streamed so the transcript keeps the partial answer.
      if (thoughtIndex >= 0) {
        yield { type: 'block-end', index: thoughtIndex, block: { type: 'reasoning', text: thoughtText } }
        thoughtIndex = -3
      }
      if (textIndex >= 0) {
        yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textText } }
        textIndex = -3
      }
      yield errorFinish(error)
      return
    }

    if (thoughtIndex >= 0) {
      yield { type: 'block-end', index: thoughtIndex, block: { type: 'reasoning', text: thoughtText } }
    }
    if (textIndex >= 0) {
      yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textText } }
    }

    if (done !== null && typeof done.messageId === 'number') {
      this.sessions.set(key, {
        chatSessionId,
        parentMessageId: done.messageId,
        turns: turns + 1,
      })
    } else {
      // Without the assistant message id the next turn could not address its
      // parent, so the next call must open a fresh web session.
      this.sessions.delete(key)
    }

    if (!sawOutput) {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
function errorFinish(error) {
  const expired = error instanceof DeepSeekWebError && error.expired
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        message: expired
          ? 'DeepSeek 网页凭据已过期，请在浏览器重新登录 chat.deepseek.com 后更新凭据。'
          : (error?.message ?? String(error)),
        code: expired ? 'INVALID_CREDENTIAL' : (error?.code ?? 'DEEPSEEK_WEB_FAILED'),
        status: error?.status,
      },
    },
  }
}
