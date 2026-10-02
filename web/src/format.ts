/** 数字/金额/涨跌幅的展示格式化。null 一律显示为占位符，绝不渲染 NaN。 */

const DASH = '—'

export function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return DASH
  return v.toFixed(digits)
}

export function fmtSigned(v: number | null | undefined, digits = 2, suffix = ''): string {
  if (v == null || !Number.isFinite(v)) return DASH
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}${suffix}`
}

/** 大额数字：万 / 亿。 */
export function fmtCompact(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH
  const abs = Math.abs(v)
  if (abs >= 1e8) return `${(v / 1e8).toFixed(2)}亿`
  if (abs >= 1e4) return `${(v / 1e4).toFixed(2)}万`
  return v.toFixed(2)
}

export function fmtVolume(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)}亿手`
  if (v >= 1e4) return `${(v / 1e4).toFixed(2)}万手`
  return `${v.toFixed(0)}手`
}

export function fmtAmount(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH
  return `¥${fmtCompact(v)}`
}

export function fmtCap(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH
  if (v >= 1e12) return `${(v / 1e12).toFixed(2)}万亿`
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)}亿`
  return v.toFixed(0)
}

/** 涨跌配色：A股红涨绿跌，美股绿涨红跌。 */
export function trendClass(v: number | null | undefined, market: string): string {
  if (v == null || !Number.isFinite(v) || v === 0) return 'flat'
  const up = v > 0
  const redFirst = market !== 'us'
  const rising = redFirst ? up : !up
  return rising ? 'up' : 'down'
}

export function fmtTime(ms: number | null | undefined): string {
  if (!ms) return ''
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}