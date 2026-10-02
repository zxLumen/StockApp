/**
 * OpenAI 兼容的上游调用：流式对话（单通道正文）。
 * 与 yijing64/web/lib/llm.js 同源，按本应用需要做了精简（不需要思考通道与成本表）。
 */

export const endpointURL = (baseURL) => {
  const trimmed = String(baseURL ?? '').trim()
  if (!trimmed) return null
  try {
    return new URL('chat/completions', trimmed.endsWith('/') ? trimmed : `${trimmed}/`)
  } catch {
    return null
  }
}

export const standardHeaders = (config, sessionId) => {
  /** @type {Record<string,string>} */
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'StockWeb/1.0',
  }
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
  if (String(config.baseURL).toLowerCase().includes('opencode.ai')) {
    headers['x-opencode-session'] = sessionId
  }
  return headers
}

export const requestBody = ({ model, messages, maxTokens, stream = false, includeUsage = false, temperature = 0.6 }) => {
  const body = {
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    temperature,
    max_tokens: maxTokens,
    stream,
  }
  if (stream && includeUsage) body.stream_options = { include_usage: true }
  return body
}

export const friendlyDetail = (json) => {
  try {
    const obj = JSON.parse(json)
    const message = obj?.error?.message
    if (typeof message === 'string' && message.trim()) return message.trim()
  } catch {
    /* 非 JSON 正文 */
  }
  return '请检查网络或 Key 是否有效。'
}

/** 解析一行上游 SSE，返回增量正文与（流末尾的）token 用量。 */
export const parseChunk = (line) => {
  if (!line.startsWith('data:')) return null
  let payload = line.slice('data:'.length)
  if (payload.startsWith(' ')) payload = payload.slice(1)
  const data = payload.trim()
  if (!data) return null
  if (data === '[DONE]') return { done: true }

  /** @type {any} */
  let obj
  try {
    obj = JSON.parse(data)
  } catch {
    return null
  }
  if (obj?.usage) {
    const u = obj.usage
    return {
      done: false,
      content: '',
      usage: {
        input: Number(u.prompt_tokens) || 0,
        output: Number(u.completion_tokens) || 0,
      },
    }
  }
  const first = Array.isArray(obj?.choices) ? obj.choices[0] : undefined
  if (!first) return null
  const delta = first.delta ?? {}
  const content = typeof delta.content === 'string' ? delta.content : ''
  if (!content) return null
  return { done: false, content, usage: null }
}

const TIMEOUT_MS = 120_000

/**
 * @param {object} options
 * @param {{ apiKey: string, baseURL: string, model: string, maxTokens: number, temperature?: number }} options.config
 * @param {{ role: string, content: string }[]} options.messages
 * @param {string} options.sessionId
 * @param {(delta: { content: string }) => void} [options.onDelta]
 * @param {AbortSignal} [options.signal]
 */
export const streamChat = async ({ config, messages, sessionId, onDelta, signal }) => {
  if (!config.apiKey) throw new Error('未配置 API Key。')
  const url = endpointURL(config.baseURL)
  if (!url) throw new Error('Base URL 无效。')

  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const response = await fetch(url, {
    method: 'POST',
    headers: standardHeaders(config, sessionId),
    body: JSON.stringify(
      requestBody({
        model: config.model,
        messages,
        maxTokens: config.maxTokens,
        stream: true,
        includeUsage: true,
        temperature: config.temperature ?? 0.6,
      }),
    ),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`请求失败（${response.status}）。${friendlyDetail(detail)}`)
  }
  if (!response.body) throw new Error('网络响应异常。')

  let text = ''
  /** @type {{input:number, output:number} | null} */
  let usage = null
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const handle = (line) => {
    const chunk = parseChunk(line)
    if (!chunk) return false
    if (chunk.done) return true
    if (chunk.usage) {
      usage = chunk.usage
      return false
    }
    if (!chunk.content) return false
    text += chunk.content
    onDelta?.({ content: chunk.content })
    return false
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx = buffer.indexOf('\n')
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (handle(line)) {
          await reader.cancel().catch(() => {})
          return { text, usage }
        }
        idx = buffer.indexOf('\n')
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) handle(buffer.trim())
  } catch (err) {
    if (signal?.aborted) throw new Error('已取消。')
    if (timeout.aborted) throw new Error('请求超时，请稍后重试。')
    throw new Error(`流式响应中断：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    reader.cancel().catch(() => {})
  }

  return { text, usage }
}

/** 拉取上游模型列表（OpenAI 兼容 `GET {base}/models`）。 */
export const fetchModels = async (config, sessionId) => {
  const trimmed = String(config.baseURL ?? '').trim()
  if (!trimmed) throw new Error('Base URL 无效。')
  const url = new URL('models', trimmed.endsWith('/') ? trimmed : `${trimmed}/`)
  const response = await fetch(url, {
    method: 'GET',
    headers: standardHeaders(config, sessionId),
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`获取模型列表失败（${response.status}）。${friendlyDetail(detail)}`)
  }
  /** @type {any} */
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new Error('模型列表响应不是合法 JSON。')
  }
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
  const models = list
    .map((item) => (typeof item === 'string' ? item : item?.id))
    .filter((id) => typeof id === 'string' && id.trim())
    .map((id) => ({ id, label: id }))
  if (!models.length) throw new Error('未获取到模型列表。')
  return models
}