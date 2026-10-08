import type {
  AiUsage,
  Bar,
  Board,
  BoardCategory,
  BoardMember,
  FundItem,
  FundNavPoint,
  FundPickGroup,
  FundRankItem,
  Kline,
  Market,
  NewsItem,
  PositionsPayload,
  Quote,
  RecommendPayload,
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
  get<{
    scope: string
    source?: string
    sourceLabel?: string
    items: (Quote & { secid: string; name: string })[]
  }>(`/api/market/indices?scope=${scope}`, signal)

export const searchMarket = (q: string, scope?: Exclude<Market, 'fund'>, signal?: AbortSignal) =>
  get<{ items: SearchItem[] }>(
    `/api/market/search?q=${encodeURIComponent(q)}${scope ? `&scope=${scope}` : ''}`,
    signal,
  )

export const fetchKline = (
  secid: string,
  period: string,
  limit = 240,
  signal?: AbortSignal,
  end?: string,
) =>
  get<Kline>(
    `/api/market/kline?secid=${encodeURIComponent(secid)}&period=${period}&limit=${limit}` +
      (end ? `&end=${encodeURIComponent(end)}` : ''),
    signal,
  )

export const fetchQuotes = (secids: string[], signal?: AbortSignal) =>
  get<{ items: Quote[]; source?: string; sourceLabel?: string }>(
    `/api/market/quote?secids=${encodeURIComponent(secids.join(','))}`,
    signal,
  )

export const fetchBoards = (kind: BoardCategory, limit = 300, signal?: AbortSignal) =>
  get<{ kind: string; items: Board[]; source?: string; sourceLabel?: string }>(
    `/api/market/board?kind=${kind}&limit=${limit}`,
    signal,
  )

export const fetchBoardMembers = (
  code: string,
  name: string,
  kind?: BoardCategory,
  cid?: string | null,
  signal?: AbortSignal,
) => {
  const qs = new URLSearchParams({ code, name })
  if (kind) qs.set('kind', kind)
  if (cid) qs.set('cid', cid)
  return get<{
    name: string
    items: BoardMember[]
    source?: string
    sourceLabel?: string
    board?: Board | null
  }>(`/api/market/board/members?${qs.toString()}`, signal)
}

/** 板块搜索：服务端在同花顺全量索引（90 行业 + 293 概念）+ 中证 10 行业上本地匹配。 */
export const searchBoards = (q: string, kind?: BoardCategory, signal?: AbortSignal) =>
  get<{ items: Board[] }>(
    `/api/market/search?q=${encodeURIComponent(q)}&scope=board${kind ? `&kind=${kind}` : ''}`,
    signal,
  )

/** 链路：dual=每日按 regime 选中的那份（默认）；A/B=两条链路各自的前瞻归档。 */
export type RecommendChain = 'dual' | 'A' | 'B'

/** 每日推荐：不带 date 给最新一天的完整数据；没有生成过则为 null。chain 选链路。 */
export const fetchRecommend = (date?: string, chain: RecommendChain = 'dual', signal?: AbortSignal) => {
  const qs = new URLSearchParams()
  if (date) qs.set('date', date)
  if (chain !== 'dual') qs.set('chain', chain)
  const q = qs.toString()
  return get<RecommendPayload | null>(`/api/recommend${q ? `?${q}` : ''}`, signal)
}

export const fetchRecommendDates = (chain: RecommendChain = 'dual', signal?: AbortSignal) =>
  get<{ dates: string[] }>(`/api/recommend/dates${chain !== 'dual' ? `?chain=${chain}` : ''}`, signal)

/** 模拟推荐持仓：全部链路 × 原始/AI 两套（服务端一次算全 + 缓存）。 */
export const fetchPositions = (signal?: AbortSignal) => get<PositionsPayload>('/api/positions', signal)

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

export const fetchFundQuotes = (codes: string[], signal?: AbortSignal) =>
  get<{ items: FundItem[] }>(`/api/fund/quotes?codes=${encodeURIComponent(codes.join(','))}`, signal)

export const fetchFundRank = (sort: string, limit = 20, signal?: AbortSignal) =>
  get<{
    sort: string
    items: FundRankItem[]
    sorts: { key: string; label: string }[]
  }>(`/api/fund/rank?sort=${sort}&limit=${limit}`, signal)

export const fetchFundHot = (signal?: AbortSignal) =>
  get<{ groups: FundPickGroup[] }>('/api/fund/hot', signal)

/** 两类新闻都多取一些：界面固定只显示 Top 10，剩下的靠「展开」露出来。 */
export const NEWS_FETCH_LIMIT = 20

/** `scope` 决定取哪个市场的新闻：美股页必须是美股自己的，不能沿用沪深港。 */
export const fetchMarketNews = (limit = NEWS_FETCH_LIMIT, signal?: AbortSignal, scope: 'cn' | 'us' = 'cn') =>
  get<{ items: NewsItem[] }>(`/api/news?kind=market&limit=${limit}&scope=${scope}`, signal)

export const fetchStockNews = (
  name: string,
  code: string,
  signal?: AbortSignal,
  scope: 'cn' | 'us' = 'cn',
  limit = NEWS_FETCH_LIMIT,
) =>
  get<{ items: NewsItem[]; degraded: boolean }>(
    `/api/news?kind=stock&name=${encodeURIComponent(name)}&code=${encodeURIComponent(code)}&scope=${scope}&limit=${limit}`,
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

/** 一个服务商一个槽位：地址与模型各自独立，切换 provider 不会串味。 */
export interface AiProviderSlot {
  id: string
  label: string
  defaultModel: string
  defaultBaseURL: string
  model: string
  baseURL: string
  hasKey: boolean
  keyMask: string | null
}

export interface AiSettings {
  provider: string
  /** 当前 provider 槽位解析出的实际值（省得调用方自己去 providers 里找） */
  model: string
  baseURL: string
  maxTokens: number
  temperature: number
  visitorAi: boolean
  hasKey: boolean
  keyMask: string | null
  providers: AiProviderSlot[]
}

export const fetchAiSettings = () => get<AiSettings>('/api/ai/settings')

export const saveAiSettings = (patch: Partial<Omit<AiSettings, 'providers'>> & { providers?: Partial<Record<string, Partial<AiProviderSlot>>> }) =>
  post<AiSettings>('/api/ai/settings', patch)

export const saveAiKey = (provider: string, key: string) =>
  post<AiSettings>('/api/ai/key', { provider, key })

/**
 * 拉服务端点对应的模型列表。
 * `provider` 决定用哪个槽的 Key，`baseURL` 可覆盖（面板里改了还没保存的地址）。
 * 不传 provider 时用当前服务商。
 */
export const fetchAiModels = (provider?: string, baseURL?: string) => {
  const qs = new URLSearchParams()
  if (provider) qs.set('provider', provider)
  if (baseURL) qs.set('baseURL', baseURL)
  const query = qs.toString()
  return get<{ models: { id: string; label: string }[] }>(`/api/ai/models${query ? `?${query}` : ''}`)
}

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

export type { Bar, Board, FundItem, Kline, NewsItem, PositionsPayload, Quote, RecommendPayload, SearchItem, WatchItem }