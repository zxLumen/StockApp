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