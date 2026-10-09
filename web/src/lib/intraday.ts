/**
 * 分时（当日 1 分钟）的纯计算：时间↔槽位映射、午休压缩、均价线。
 *
 * A 股一天 240 个交易分钟：上午 09:30–11:30（120）、下午 13:00–15:00（120）。
 * 专业软件的分时 X 轴把午休「压缩掉」—— 11:30 紧挨 13:00，轴上不出现 12 点，
 * 但 lightweight-charts 是线性时间轴，做不到。这里的做法是：
 * 把每个分钟映射成连续槽位 slot（0..239），绘图用「当日 00:00 + slot 分钟」的
 * 伪时间戳，轴刻度再用 slotLabel(slot) 反算回真实墙钟，于是午休天然不占位。
 */

const AM_OPEN = 9 * 60 + 30 // 09:30
const AM_CLOSE = 11 * 60 + 30 // 11:30
const PM_OPEN = 13 * 60 // 13:00
const PM_CLOSE = 15 * 60 // 15:00
const AM_MINUTES = AM_CLOSE - AM_OPEN // 120
/** 全天交易分钟数（含两端 09:30 与 15:00，午休压缩后的总点数）。 */
export const SESSION_SLOTS = AM_MINUTES + (PM_CLOSE - PM_OPEN) + 1 // 241

/** "2026-10-08 09:31" → 交易日日期 "2026-10-08"；非该形态返回 ''。 */
export function barDay(time: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(time) ? time.slice(0, 10) : ''
}

/**
 * 分钟时间 → 槽位。09:30 记 0、11:30 记 119；13:00 记 120、15:00 记 239。
 * 不在交易时段（午休 / 盘前盘后）返回 null。
 */
export function sessionSlot(time: string): number | null {
  const m = /(\d{2}):(\d{2})/.exec(time.slice(11, 16))
  if (!m) return null
  const mins = Number(m[1]) * 60 + Number(m[2])
  if (mins >= AM_OPEN && mins <= AM_CLOSE) return mins - AM_OPEN
  if (mins >= PM_OPEN && mins <= PM_CLOSE) return AM_MINUTES + (mins - PM_OPEN)
  return null
}

const hhmm = (mins: number) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`

/** 槽位 → 真实墙钟刻度，用于自定义轴格式化。 */
export function slotLabel(slot: number): string {
  const s = Math.max(0, Math.min(SESSION_SLOTS - 1, Math.round(slot)))
  return s <= AM_MINUTES ? hhmm(AM_OPEN + s) : hhmm(PM_OPEN + (s - AM_MINUTES))
}

/** 交易日 "2026-10-08" 的伪起点时间戳（秒）：按 UTC 00:00 取，仅用于内部线性排布。 */
export function dayStartTs(day: string): number {
  const [y, mo, d] = day.split('-').map(Number)
  return Math.floor(Date.UTC(y, mo - 1, d, 0, 0, 0) / 1000)
}

/** 槽位 → 伪时间戳（秒）。 */
export function slotTs(day: string, slot: number): number {
  return dayStartTs(day) + slot * 60
}

/** 伪时间戳（秒）→ 槽位，供轴刻度回调使用。 */
export function tsToSlot(day: string, ts: number): number {
  return Math.round((ts - dayStartTs(day)) / 60)
}

/**
 * 分时均价线 = 成交量加权均价（VWAP）：Σ(close×volume) / Σ(volume)。
 *
 * 为什么不用「成交额 / 成交量」：个股的 amount≈Σ(成交价×股数)，两者等价（差异 <0.05%）；
 * 但**指数**（上证/深证/恒生/纳指…）与**板块**的分钟 amount 是成分股总成交额、volume 是成分股
 * 总手数，二者相除得到的是「全市场平均每股价格」（十几元），与指数点位（几千点）不是一个量纲，
 * 会让均价线被压到图底部。用 close 加权对个股/ETF 同样成立，对指数才正确。
 * 量缺失/为 0 时沿用上一根均价，开头无值则为 null。
 */
export function avgPrices(bars: Array<{ close?: number | null; volume?: number | null }>): Array<number | null> {
  let cumPv = 0
  let cumVol = 0
  let last: number | null = null
  return bars.map((b) => {
    const c = Number(b.close)
    const v = Number(b.volume)
    if (Number.isFinite(c) && Number.isFinite(v) && v > 0) {
      cumPv += c * v
      cumVol += v
    }
    if (cumVol > 0) last = Number((cumPv / cumVol).toFixed(3))
    return last
  })
}

/** 取最后一个交易日的所有分钟 bar（服务端已按天过滤，这里再兜一层）。 */
export function lastDayBars<T extends { time: string }>(bars: T[]): T[] {
  const day = bars.length ? barDay(bars[bars.length - 1].time) : ''
  return day ? bars.filter((b) => barDay(b.time) === day) : bars
}
