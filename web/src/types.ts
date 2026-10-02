export type Market = 'cn' | 'us' | 'fund'
export type BoardKind = 'industry' | 'concept'

export interface Quote {
  secid: string
  code: string
  name: string
  market: string
  price: number | null
  changePct: number | null
  change: number | null
  high: number | null
  low: number | null
  open: number | null
  prevClose: number | null
  volume: number | null
  amount: number | null
  turnover: number | null
  marketCap: number | null
  floatCap: number | null
}

export interface Bar {
  time: string
  open: number
  close: number
  high: number
  low: number
  volume: number | null
  amount: number | null
  amplitude: number | null
  changePct: number | null
  change: number | null
  turnover: number | null
  ma5: number | null
  ma10: number | null
  ma20: number | null
}

export interface Kline {
  secid: string
  code: string | null
  market: string
  name: string | null
  bars: Bar[]
  /** 实际生效的数据源；非东财说明当前是降级数据 */
  source?: string
  sourceLabel?: string
}

/** 行情降级链：东财 → 腾讯 → 新浪。 */
export type SourceId = 'eastmoney' | 'tencent' | 'sina'

export interface SourceBadge {
  id: string
  label: string
}

export interface SearchItem {
  code: string
  name: string
  secid: string
  market: string
  classify: string | null
  type: string | null
  exchange: string | null
}

export interface Board {
  code: string
  secid: string
  name: string
  index: number | null
  changePct: number | null
  up: number | null
  down: number | null
  leader: string | null
  leaderCode: string | null
  leaderPct: number | null
}

export interface NewsItem {
  title: string
  url: string | null
  source: string
  time: number | null
  summary: string | null
}

export interface FundItem {
  code: string
  name: string
  nav: number | null
  accNav: number | null
  changePct: number | null
  date: string | null
}

/** 场外基金区间涨幅榜的一行。 */
export interface FundRankItem {
  code: string
  name: string
  date: string | null
  nav: number | null
  accNav: number | null
  d1: number | null
  w1: number | null
  m1: number | null
  y1: number | null
}

/** 精选分类下的一只基金（复用 FundItem 的净值字段）。 */
export interface FundPickGroup {
  key: string
  label: string
  hint: string | null
  funds: FundItem[]
}

export interface FundNavPoint {
  date: string
  nav: number
  accNav: number | null
  changePct: number | null
}

export interface WatchItem {
  /** 场外基金存 6 位代码，行情类存 `market.code` */
  secid: string
  code: string
  name: string
  market: string
  kind?: 'stock' | 'fund'
  at: number
}

export interface Selection {
  kind: 'stock' | 'fund'
  secid: string
  code: string
  name: string
  market: Market
}

export interface AiUsage {
  input: number
  output: number
}

export type AiState = 'idle' | 'thinking' | 'working' | 'busy' | 'success' | 'error' | 'blocked'