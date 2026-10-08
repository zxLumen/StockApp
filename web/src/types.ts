/** 顶级页签。`board` / `pick` 与沪深港 / 美股齐平，不是某个市场下的子页。 */
export type Market = 'board' | 'pick' | 'cn' | 'us' | 'fund'
export type BoardKind = 'industry' | 'concept'
/** 中证一级行业（官方口径的 10 个，与同花顺分类无法互相映射，独立成类）。 */
export type CsiBoardKind = 'csi'
/** 板块搜索结果的分类标签。 */
export type BoardCategory = BoardKind | CsiBoardKind

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
  /** 分类：同花顺行业 / 同花顺概念 / 中证行业 */
  kind?: BoardCategory
  /** 概念成分股页要用 cid（platecode 页恒为 0 条成员） */
  cid?: string | null
  /** 同花顺行业列表给的量额与资金流（新浪源为 null） */
  volume?: number | null
  amount?: number | null
  netInflow?: number | null
  /** 中证指数全称，如「中证能源指数」 */
  fullName?: string | null
}

export interface BoardMember {
  secid: string
  code: string
  name: string
  price: number | null
  changePct: number | null
  change?: number | null
}

/** 每日推荐里的一只股票（榜单行 + AI 解读）。 */
export interface RecommendStock {
  secid: string
  code: string
  name: string
  price: number | null
  changePct: number | null
  amount: number | null
  turnover: number | null
  mktcap: number | null
  floatCap: number | null
  /** 近一月涨幅（%） */
  monthPct: number | null
  /** AI「值得买入」评分与要点（解读失败时 buyScore 为 null） */
  ai?: {
    buyScore: number | null
    /** AI 建议持有交易日数（3 / 5 / 10 / 20） */
    holdDays?: number | null
    /** AI 给这个持有周期的理由（一句话） */
    holdReason?: string
    summary: string
    catalysts?: string[]
    risks?: string[]
    tags?: string[]
    error?: string
  }
  /** 二次评审给的理由（仅进 Top10 的会有） */
  reason?: string
  pickedBy?: 'ai' | 'score' | 'fill' | 'factor'
  /** 最新价（服务端补；盘中=实时价，收盘后=收盘价） */
  latestPrice?: number | null
  /** 自推荐日基准价到最新的涨跌幅（%）；取不到现价时为 null */
  sincePickPct?: number | null
  /** AI 建议持有周期（交易日），服务端补 */
  holdDays?: number | null
  /** 按 AI 持有周期算的涨幅（%）；周期未走完或数据缺失为 null */
  holdPct?: number | null
  /** 持有周期的结束交易日 */
  holdEndDate?: string | null
  /** 该持有周期是否已走完 */
  holdDone?: boolean
  /** 同期沪深300涨跌（%）：推荐日→该股持有周期结束；与 holdPct 同一窗口 */
  holdIdxPct?: number | null
  /** 同期沪深300涨跌（%）：推荐日→最新；与 sincePickPct 同一窗口 */
  sinceIdxPct?: number | null
}

/** 「按历史推荐周期，本页生效日应卖出」的一条（服务端 dueOn 计算）。 */
export interface DueItem {
  secid: string
  code: string
  name: string
  /** 该历史推荐的 AI 持有交易日数 */
  holdDays: number
  /** 来源推荐的生效日（合并时取最早） */
  fromDate: string
  basisDate: string
  /** 来源推荐日基准价 */
  pickPrice: number | null
  holdReason?: string
  /** 同票被多天推荐且同日到期时的命中次数 */
  times: number
  /** 现价（服务端补） */
  price?: number | null
  /** 自推荐日基准价到现在的涨跌（%）（服务端补） */
  sincePct?: number | null
}

export interface RecommendPayload {
  /** 推荐生效日（生成日的下一交易日） */
  date: string
  generatedAt: string
  /** 基准价对应的日期（生成日收盘） */
  basisDate?: string
  /** 对照基准名（如「沪深300」），服务端补 */
  benchName?: string
  model: string
  pool: { size: number; filtered?: number; candidates: number }
  /** 按历史推荐周期、到期日 = 本页生效日 的应卖出股票（服务端补） */
  dueOn?: DueItem[]
  /** regime 双链路的择链判据（单链路产物无此字段） */
  regime?: {
    /** 当日沪深300 动量倾斜 tilt（0=纯反转，1=强动量） */
    tilt: number
    /** tilt 阈值：≥ 走 A 链路 */
    thr: number
    /** 实际选中的链路：A=成交额池+AI选股（激进），B=稳健池+客观因子（保守） */
    chain: 'A' | 'B'
    /** tilt 本来选中的是哪条（与 chain 不一致说明链路挂了退了fallback） */
    intended?: 'A' | 'B'
    /** 是否因选中链路不可用而退回了另一条 */
    fellBack?: boolean
    /** 两条是否都跑成了（便于事后对照） */
    ranBoth?: boolean
  }
  top: RecommendStock[]
  candidates: RecommendStock[]
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
  kind: 'stock' | 'fund' | 'board'
  secid: string
  code: string
  name: string
  market: Market
  /** 概念板块成分股页用的 cid（platecode 打开恒 0 条），列表 / 搜索结果里带过来 */
  cid?: string | null
}

export interface AiUsage {
  input: number
  output: number
  /** 带思考链的模型里被思考占掉的 token（记在同一份 max_tokens 上） */
  reasoning?: number
}

export type AiState = 'idle' | 'thinking' | 'working' | 'busy' | 'success' | 'error' | 'blocked'