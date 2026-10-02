import { fetchGbk, fetchJson, cached } from './http.js'
import { marketOf, withMa } from './eastmoney.js'

// 腾讯（qt.gtimg.cn / ifzq.gtimg.cn）作为行情的第 2 数据源：东财 push2/push2his 会按来源 IP
// 直接掐连接，腾讯这条线基本独立，能顶上快照与日/周/月 K；分钟 K 只有 A 股有。
const QUOTE_HOST = 'https://qt.gtimg.cn/q='
const KLINE_DAY_HOST = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param='
const KLINE_MIN_HOST = 'https://ifzq.gtimg.cn/appstock/app/kline/mkline?param='

const HK_INDEX_CODES = new Set(['HSI', 'HSCEI', 'HSTECH', 'HSCCI', 'HSCCOEX'])

/** 港股指数：东财 `100.HSI` / `124.HSTECH` → 腾讯 `hkHSI` / `hkHSTECH`。 */
const CN_INDEX_CODES = new Map([
  ['DJIA', 'usDJI'],
  ['NDX', 'usNDX'],
  ['IXIC', 'usIXIC'],
  ['SPX', 'usINX'],
])

/**
 * 东财 secid → 腾讯代码。
 * 1.x=沪 0.x=深 116.x=港股个股 90.x=板块（腾讯无对应板块，返回 null）。
 */
export function toTxCode(secid) {
  const [m, code = ''] = String(secid || '').split('.')
  if (!code) return null
  if (m === '1') return `sh${code}`
  if (m === '0') return `sz${code}`
  if (m === '116') return `hk${code}`
  if (m === '90') return null
  const up = code.toUpperCase()
  if (HK_INDEX_CODES.has(up)) return `hk${up}`
  if (CN_INDEX_CODES.has(up)) return CN_INDEX_CODES.get(up)
  if (['100', '105', '106', '107', '153', '155'].includes(m)) return `us${code}`
  return null
}

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const enc = encodeURIComponent

/**
 * 腾讯快照行：`v_sh600519="1~贵州茅台~600519~现价~昨收~今开~成交量~外盘~内盘~买盘…"`
 * 固定列：3=现价 4=昨收 5=今开 6=量 30=时间 31=涨跌 32=涨跌% 33=高 34=低 36=量 37=额(万) 38=换手
 */
export function parseTxQuote(line) {
  const eq = line.indexOf('="')
  if (eq < 0) return null
  const txCode = line.slice(2, eq)
  const body = line.slice(eq + 2, line.lastIndexOf('"'))
  if (!body) return null
  const c = body.split('~')
  if (c.length < 40) return null
  const price = num(c[3])
  if (price == null || price === 0) return null
  // 沪深量是「手」，港美是「股」；统一换算成股。
  const volume = num(c[6])
  const market = txCode.startsWith('sh') || txCode.startsWith('sz')
    ? 'cn'
    : txCode.startsWith('hk')
      ? 'hk'
      : 'us'
  return {
    txCode,
    code: c[2] || txCode.replace(/^(sh|sz|hk|us)/, ''),
    name: c[1],
    price,
    prevClose: num(c[4]),
    open: num(c[5]),
    high: num(c[33]),
    low: num(c[34]),
    change: num(c[31]),
    changePct: num(c[32]),
    volume: num(c[6]),
    // 成交额 / 换手 / 市值这几列只有 A 股口径能对上（37=万元、38=%、44/45=亿元）；
    // 港美股同一列的单位不一样，宁可留空也不给错数。
    amount: market === 'cn' && num(c[37]) != null ? num(c[37]) * 10_000 : null,
    turnover: market === 'cn' ? num(c[38]) : null,
    marketCap: market === 'cn' && num(c[45]) != null ? num(c[45]) * 1e8 : null,
    floatCap: market === 'cn' && num(c[44]) != null ? num(c[44]) * 1e8 : null,
    time: normTxTime(c[30]) || null,
    market,
  }
}

/** 腾讯快照批量（一次最多 50 个）。返回 secid → quote 的 Map。 */
export async function tencentQuotes(secids) {
  const wanted = new Map()
  for (const secid of secids) {
    const tx = toTxCode(secid)
    if (tx) wanted.set(tx, secid)
  }
  if (!wanted.size) return new Map()
  const codes = [...wanted.keys()]
  const out = new Map()
  for (let i = 0; i < codes.length; i += 50) {
    const batch = codes.slice(i, i + 50)
    const text = await cached(`txq:${batch.join(',')}`, 10_000, () =>
      fetchGbk(QUOTE_HOST + batch.map(enc).join(','), { headers: { Referer: 'https://gu.qq.com/' } }),
    )
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      const q = parseTxQuote(line)
      if (!q) continue
      const secid = wanted.get(q.txCode)
      if (secid) out.set(secid, { ...q, secid })
    }
  }
  return out
}

/**
 * 腾讯的时间有三种写法：日/周/月是 `2026-09-30`，分钟是 `202609301100`，
 * 快照那列带秒是 `20260930161500`（还有美股已经带空格的 `2026-10-01 16:00:01`）。
 * 统一成东财那套 `YYYY-MM-DD` / `YYYY-MM-DD HH:mm`。
 */
export function normTxTime(raw) {
  const s = String(raw || '').trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 16)
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?$/.exec(s)
  if (!m) return ''
  return `${m[1]}-${m[2]}-${m[3]}` + (m[4] ? ` ${m[4]}:${m[5] || '00'}` : '')
}

/**
 * 腾讯 K 线行：[时间, 开, 收, 高, 低, 量]（分钟行后面还有 2 列副信息，忽略）。
 * 美股偶尔在最前面混进一根 IPO 当年的脏行（与最后一根差好几十年），丢掉即可。
 */
export function parseTxBars(rows, { limit = 240 } = {}) {
  const bars = (Array.isArray(rows) ? rows : [])
    .map((r) => ({
      time: normTxTime(r[0]),
      open: num(r[1]),
      close: num(r[2]),
      high: num(r[3]),
      low: num(r[4]),
      volume: num(r[5]),
    }))
    .filter((b) => b.time && b.close != null)
    .sort((a, b) => (a.time < b.time ? -1 : 1))
  if (bars.length > 1) {
    const gap = Number(bars[bars.length - 1].time.slice(0, 4)) - Number(bars[0].time.slice(0, 4))
    if (gap >= 5) bars.shift()
  }
  return bars.slice(-Math.max(2, limit))
}

const TX_PERIOD = { d: 'day', w: 'week', m: 'month', m5: 'm5', m15: 'm15', m30: 'm30', m60: 'm60' }

/**
 * 日/周/月走 fqkline，分钟走 mkline。
 * 已知限制：mkline 只有 A 股；美股 day 只回 1~2 根（无用），故美股直接交给新浪。
 */
export async function tencentKline(secid, { period = 'd', limit = 240 } = {}) {
  const tx = toTxCode(secid)
  if (!tx) return null
  const market = marketOf(secid)
  if (market === 'us') return null
  const p = TX_PERIOD[period] || 'day'
  const intraday = !['day', 'week', 'month'].includes(p)
  if (intraday && market !== 'cn') return null
  const host = intraday ? KLINE_MIN_HOST : KLINE_DAY_HOST
  const n = Math.min(640, limit)
  // 日/周/月是 `代码,周期,,,数量,复权`（四个逗号），分钟是 `代码,周期,,数量`。
  const url = intraday ? `${host}${enc(tx)},${p},,${n}` : `${host}${enc(tx)},${p},,,${n},qfq`
  const json = await cached(`txk:${secid}:${p}:${limit}`, 5 * 60_000, () => fetchJson(url))
  const data = json?.data?.[tx]
  // 带 qfq 时腾讯把数组放在 `qfqday`/`qfqweek`/`qfqmonth` 下。
  const rows = data?.[`qfq${p}`] ?? data?.[p]
  const bars = parseTxBars(rows, { limit })
  if (!bars.length) return null
  return { secid, market, name: data?.qt?.[tx]?.[1] ?? null, bars: withMa(bars) }
}