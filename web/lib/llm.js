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

/** opencode Zen/Go 端点（与 standardHeaders 里加会话头的判断同源，抽出来复用）。 */
export const isOpenCode = (baseURL) => String(baseURL ?? '').toLowerCase().includes('opencode.ai')

export const standardHeaders = (config, sessionId) => {
  /** @type {Record<string,string>} */
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'StockWeb/1.0',
  }
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
  if (isOpenCode(config.baseURL)) {
    headers['x-opencode-session'] = sessionId
  }
  return headers
}

export const requestBody = ({ model, messages, maxTokens, stream = false, includeUsage = false, temperature = 0.6, noThinking = false }) => {
  const body = {
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    temperature,
    max_tokens: maxTokens,
    stream,
  }
  if (stream && includeUsage) body.stream_options = { include_usage: true }
  // 思考链模型（deepseek-v4.x 等）把 reasoning 和正文记在同一份 max_tokens 上，
  // 而本应用不渲染思考过程 —— 思考就是纯浪费预算，实测 reasoning_effort=none
  // 能把它压到 0（正文 1274 字 / 9.5s，基线是 2048 全被思考吃掉、正文 0 字）。
  // 只对实测支持的 opencode 端点发：DeepSeek / 智谱等未验证，贸然发未知字段可能被判 400。
  if (noThinking) body.reasoning_effort = 'none'
  return body
}

/**
 * 把上游错误正文变成一句能看懂的话。
 *
 * 很多上游（DeepSeek 的 `Authentication Fails (governor)`、各种网关）回的是**纯文本**，
 * 不是 JSON。旧实现只认 JSON，于是把这句话整个吞掉、换成「请检查网络或 Key 是否有效」——
 * 用户只看到 401，完全不知道是「压根没带 Key」还是「Key 真错了」。
 * 所以 JSON 解析失败时**回退到正文本身**（压空白 + 截断），只在真的什么都没有时才给泛泛提示。
 */
export const friendlyDetail = (json) => {
  const text = String(json ?? '').trim()
  if (text) {
    try {
      const obj = JSON.parse(text)
      const message = obj?.error?.message
      if (typeof message === 'string' && message.trim()) return message.trim()
      const detail = obj?.error?.detail
      if (typeof detail === 'string' && detail.trim()) return detail.trim()
    } catch {
      /* 非 JSON 正文：下面当纯文本用 */
    }
    // 纯文本正文：压掉多余空白，限长避免塞满整屏
    const flat = text.replace(/\s+/g, ' ').trim()
    if (flat) return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat
  }
  return '请检查网络或 Key 是否有效。'
}

/** 分片里的 `finish_reason`（截断时是 `length`）。只取这一个字段，容忍坏 JSON。 */
export const finishReasonOf = (line) => {
  if (!line.startsWith('data:')) return null
  const data = line.slice('data:'.length).trim()
  if (!data || data === '[DONE]') return null
  try {
    const reason = JSON.parse(data)?.choices?.[0]?.finish_reason
    return typeof reason === 'string' && reason ? reason : null
  } catch {
    return null
  }
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
        // 思考链模型的 token 记在同一个 max_tokens 上，正文为空时靠它解释预算去哪了
        reasoning: Number(u.completion_tokens_details?.reasoning_tokens) || 0,
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
 * @param {boolean} [options.noThinking] 显式覆盖「是否注入 reasoning_effort:none」；
 *   不传则按 baseURL 自动判断（opencode 端点）。批处理务必传 true，否则思考链会吃光输出预算。
 */
export const streamChat = async ({ config, messages, sessionId, onDelta, signal, noThinking }) => {
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
        noThinking: noThinking ?? isOpenCode(config.baseURL),
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
  /** @type {{input:number, output:number, reasoning?:number} | null} */
  let usage = null
  /** @type {string | null} */
  let finishReason = null
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const handle = (line) => {
    const reason = finishReasonOf(line)
    if (reason) finishReason = reason
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

  /**
   * 一路 `content` 全空、只有思考通道，基本只有一种原因：**token 预算被思考吃光了**。
   * 带思考链的模型（deepseek-v4.x 等）把 reasoning 和正文记在同一份 max_tokens 上，
   * 而我们不显示思考过程，于是正文一个字都轮不到 —— 上游还「成功」返回。
   * 这时必须明确报出来，不然用户只看到一个空白框。
   */
  const emptyBecauseThinking = () => {
    const reasoning = usage?.reasoning ?? 0
    return (
      `模型只输出了思考过程就被 token 上限截断，没有给出正文` +
      `（思考约 ${reasoning} tokens${finishReason === 'length' ? '，finish_reason=length' : ''}）。` +
      `请在设置里调大「最大输出 tokens」后重试。`
    )
  }

  let finished = false
  try {
    for (; !finished; ) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx = buffer.indexOf('\n')
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (handle(line)) {
          finished = true
          await reader.cancel().catch(() => {})
          break
        }
        idx = buffer.indexOf('\n')
      }
    }
    if (!finished) {
      buffer += decoder.decode()
      if (buffer.trim()) handle(buffer.trim())
    }
  } catch (err) {
    if (signal?.aborted) throw new Error('已取消。')
    if (timeout.aborted) throw new Error('请求超时，请稍后重试。')
    throw new Error(`流式响应中断：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    reader.cancel().catch(() => {})
  }

  // 放在 catch 之外：这不是「中断」，别让用户以为是网络问题
  // 上游正常收流、但 `finish_reason=length` 时正文是被硬截断的（未见 `[DONE]`，
  // 服务端直接断流）。此时 text 可能是个半截 JSON —— 对「必须回 JSON」的调用方
  // （如每日推荐的解读 / 评审）这等于废数据，得让它显式知道，而不是拿去 parse。
  if (finishReason === 'length') {
    const reasoning = usage?.reasoning ?? 0
    // 正文完全为空、又全是思考 token → 说成「思考吃掉了预算」；
    // 有正文但被截 → 就是输出上限太小。两种都让人去调大 max_tokens。
    throw new Error(
      (!text && reasoning > 0
        ? `模型只输出了思考过程就被 token 上限截断，没有给出正文（思考约 ${reasoning} tokens）`
        : `模型输出被 token 上限截断，正文不完整（finish_reason=length）`) +
        `。请在设置里调大「最大输出 tokens」后重试。`,
    )
  }
  if (!text) throw new Error(emptyBecauseThinking())
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