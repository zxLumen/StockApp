import type {
  AiUsage,
  Bar,
  Board,
  FundItem,
  FundNavPoint,
  Kline,
  Market,
  NewsItem,
  Quote,
  SearchItem,
  WatchItem,
} from './types'

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error || `请求失败（${res.status}）`
    throw new Error(msg)
  }
  return body as T
}

const get = <T>(url: string, signal?: AbortSignal) =>
  fetch(url, { cache: 'no-store', signal }).then(json<T>)

const post = <T>(url: string, body: unknown, signal?: AbortSignal) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  }).then(json<T>)

export const fetchStatus = () =>
  get<{
    owner: boolean
    visitorAi: boolean
    ai: { enabled: boolean; hasKey: boolean; model: string; provider: string }
    providers: { id: string; label: string }[]
  }>('/api/status')

export const fetchIndices = (scope: Exclude<Market, 'fund'>, signal?: AbortSignal) =>
  get<{ scope: string; items: (Quote & { secid: string; name: string })[] }>(
    `/api/market/indices?scope=${scope}`,
    signal,
  )

export const searchMarket = (q: string, scope?: Exclude<Market, 'fund'>, signal?: AbortSignal) =>
  get<{ items: SearchItem[] }>(
    `/api/market/search?q=${encodeURIComponent(q)}${scope ? `&scope=${scope}` : ''}`,
    signal,
  )

export const fetchKline = (secid: string, period: string, limit = 240, signal?: AbortSignal) =>
  get<Kline>(`/api/market/kline?secid=${encodeURIComponent(secid)}&period=${period}&limit=${limit}`, signal)

export const fetchQuotes = (secids: string[], signal?: AbortSignal) =>
  get<{ items: Quote[] }>(`/api/market/quote?secids=${encodeURIComponent(secids.join(','))}`, signal)

export const fetchBoards = (kind: 'industry' | 'concept', limit = 20, signal?: AbortSignal) =>
  get<{ kind: string; items: Board[] }>(`/api/market/board?kind=${kind}&limit=${limit}`, signal)

export const fetchBoardMembers = (name: string, signal?: AbortSignal) =>
  get<{ name: string; items: SearchItem[]; degraded: boolean }>(
    `/api/market/board/members?name=${encodeURIComponent(name)}`,
    signal,
  )

export const searchFunds = (q: string, signal?: AbortSignal) =>
  get<{ items: { code: string; name: string; type: string | null }[] }>(
    `/api/fund/suggest?q=${encodeURIComponent(q)}`,
    signal,
  )

export const fetchFundNav = (code: string, signal?: AbortSignal) =>
  get<{ code: string; nav: number; accNav: number | null; changePct: number | null; points: FundNavPoint[] }>(
    `/api/fund/nav?code=${code}&limit=240`,
    signal,
  )

export const fetchMarketNews = (limit = 20, signal?: AbortSignal) =>
  get<{ items: NewsItem[] }>(`/api/news?kind=market&limit=${limit}`, signal)

export const fetchStockNews = (name: string, code: string, signal?: AbortSignal) =>
  get<{ items: NewsItem[]; degraded: boolean }>(
    `/api/news?kind=stock&name=${encodeURIComponent(name)}&code=${encodeURIComponent(code)}`,
    signal,
  )

export const fetchWatchlist = (signal?: AbortSignal) =>
  get<{ items: WatchItem[] }>('/api/watchlist', signal)

export const addWatch = (item: {
  secid: string
  code: string
  name: string
  kind?: 'stock' | 'fund'
  market?: string
}) => post<{ items: WatchItem[] }>('/api/watchlist', item)

export const removeWatch = (secid: string) =>
  fetch(`/api/watchlist?secid=${encodeURIComponent(secid)}`, { method: 'DELETE' }).then(
    json<{ items: WatchItem[] }>,
  )

export interface AiSettings {
  provider: string
  model: string
  baseURL: string
  maxTokens: number
  temperature: number
  visitorAi: boolean
  hasKey: boolean
  keyMask: string | null
}

export const fetchAiSettings = () => get<AiSettings>('/api/ai/settings')

export const saveAiSettings = (patch: Partial<AiSettings>) =>
  post<AiSettings>('/api/ai/settings', patch)

export const saveAiKey = (provider: string, key: string) =>
  post<AiSettings>('/api/ai/key', { provider, key })

export const fetchAiModels = (baseURL?: string) =>
  get<{ models: { id: string; label: string }[] }>(
    `/api/ai/models${baseURL ? `?baseURL=${encodeURIComponent(baseURL)}` : ''}`,
  )

/** AI 解读：SSE 文本流，边收边回调。 */
export function interpret(
  body: { secid: string; name: string; question?: string },
  handlers: {
    onDelta: (text: string) => void
    onDone: (text: string, usage: AiUsage | null) => void
    onError: (message: string) => void
  },
  signal?: AbortSignal,
): Promise<void> {
  return (async () => {
    let res: Response
    try {
      res = await fetch('/api/ai/interpret', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
    } catch (err) {
      handlers.onError(err instanceof Error ? err.message : '网络错误')
      return
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      handlers.onError((body as { error?: string } | null)?.error || `请求失败（${res.status}）`)
      return
    }
    if (!res.body) {
      handlers.onError('响应为空')
      return
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let acc = ''
    let usage: AiUsage | null = null
    let done = false
    try {
      for (;;) {
        const { done: finished, value } = await reader.read()
        if (finished) break
        buffer += decoder.decode(value, { stream: true })
        let idx = buffer.indexOf('\n')
        while (idx >= 0) {
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)
          if (line.startsWith('data:')) {
            try {
              const frame = JSON.parse(line.slice(5).trim()) as {
                delta?: { content?: string }
                done?: boolean
                text?: string
                usage?: AiUsage
                error?: { message?: string }
              }
              if (frame.error?.message) {
                handlers.onError(frame.error.message)
                done = true
                break
              }
              if (frame.delta?.content) {
                acc += frame.delta.content
                handlers.onDelta(frame.delta.content)
              }
              if (frame.usage) usage = frame.usage
              if (frame.done) {
                acc = frame.text || acc
                done = true
                break
              }
            } catch {
              /* 半行/非 JSON：忽略，等下一行 */
            }
          }
          idx = buffer.indexOf('\n')
        }
        if (done) break
      }
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) {
        handlers.onError(err instanceof Error ? err.message : '流中断')
      }
      return
    }
    if (!done && acc) handlers.onDone(acc, usage)
    else if (done) handlers.onDone(acc, usage)
  })()
}

export type { Bar, Board, FundItem, Kline, NewsItem, Quote, SearchItem, WatchItem }