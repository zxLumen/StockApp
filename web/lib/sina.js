import { fetchGbk, fetchJson, fetchText, cached } from './http.js'
import { marketOf, withMa, withDerived } from './eastmoney.js'

// 新浪是第 3 数据源：快照覆盖沪深/港/美/指数且口径贴近东财；A 股日/分钟 K 与美股历史 K 只有它有
// （腾讯的 mkline 只有 A 股分钟、美股 day 只回 1~2 根，都不可用）。
const QUOTE_HOST = 'https://hq.sinajs.cn/list='
const KLINE_HOST = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData'
const US_KLINE =
  'https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20_a=/US_MinKService.getDailyK'
const REFERER = { Referer: 'https://finance.sina.com.cn' }

const HK_INDEX_CODES = new Set(['HSI', 'HSCEI', 'HSTECH'])

/** 和 marketOf 的美股前缀保持一致（少一个就会静默走错源）。 */
const US_MARKET_PREFIXES = new Set(['100', '105', '106', '107', '153', '155'])

/**
 * 美股指数：东财 secid 的代码段 → 新浪 `US_MinKService` 认的符号。
 *
 * 这一层必须显式映射：直接把代码段丢过去（`100.NDX` → `NDX`）新浪会返回空，
 * 日 K 就整段拿不到（实测 NDX / SPX / IXIC / INX 全空）。带点的才是对的符号，
 * 且只有这四个指数有 `.` 前缀形式（`.DJI` 道指 / `.IXIC` 纳指 / `.NDX` 纳指100 /
 * `.INX` 标普500，各 5700+ 根日线）；个股直接用代码段即可。
 */
const US_INDEX_TABLE = {
  DJIA: '.DJI',
  DJI: '.DJI',
  IXIC: '.IXIC',
  COMP: '.IXIC',
  NDX: '.NDX',
  SPX: '.INX',
  INX: '.INX',
  GSPC: '.INX',
}

/** 按市场前缀分组：100 / 155 是美股指数，其余美股前缀只会有个股。 */
const US_INDEX_SYMBOLS = {
  100: US_INDEX_TABLE,
  155: US_INDEX_TABLE,
}

/**
 * 东财 secid → 新浪代码。
 * 1.x=沪 `sh600519`（指数 `1.000001` 也走这套长表）0.x=深 116.x/港指数=港 `hk00700` 美股 `gb_aapl`
 * 90.x=板块新浪没有对应品种，返回 null。
 */
export function toSinaCode(secid) {
  const [m, code = ''] = String(secid || '').split('.')
  if (!code) return null
  if (m === '1') return `sh${code}`
  if (m === '0') return `sz${code}`
  if (m === '116') return `hk${code}`
  if (m === '90') return null
  const up = code.toUpperCase()
  if (HK_INDEX_CODES.has(up)) return `hk${up}`
  if (['100', '105', '106', '107', '153', '155'].includes(m)) return `gb_${code.toLowerCase()}`
  return null
}

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const enc = encodeURIComponent

/** 日期两种写法：日/周/月 `2026-09-30`，分钟 `202609301100`，统一成东财那套。 */
function normTime(raw) {
  const s = String(raw || '').trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?$/.exec(s)
  if (!m) return ''
  return `${m[1]}-${m[2]}-${m[3]}` + (m[4] ? ` ${m[4]}:${m[5] || '00'}` : '')
}

/**
 * 新浪长表有三种列序：
 *  A 股 `名称,今开,昨收,现价,最高,最低,买一,卖一,成交量(股),成交额(元),…`
 *  港股 `英文名,中文名,今开,昨收,最高,最低,现价,涨跌额,涨跌幅,买一,卖一,成交额,成交量,…`
 *  美股 `名称,现价,涨跌幅,时间,涨跌额,今开,最高,最低,52周高,52周低,成交量,…`
 */
export function parseSinaLong(body, sinaCode) {
  const c = body.split(',')
  if (c.length < 6) return null
  if (sinaCode.startsWith('gb_')) {
    const price = num(c[1])
    if (price == null || price === 0) return null
    const change = num(c[4])
    return {
      name: c[0],
      price,
      change,
      changePct: num(c[2]),
      prevClose: change != null ? Number((price - change).toFixed(3)) : null,
      open: num(c[5]),
      high: num(c[6]),
      low: num(c[7]),
      volume: num(c[10]),
      time: c[3] || null,
    }
  }
  if (sinaCode.startsWith('hk')) {
    const price = num(c[6])
    if (price == null || price === 0) return null
    return {
      name: c[1],
      price,
      change: num(c[7]),
      changePct: num(c[8]),
      prevClose: num(c[3]),
      open: num(c[2]),
      high: num(c[4]),
      low: num(c[5]),
      amount: num(c[11]),
      volume: num(c[12]),
    }
  }
  const price = num(c[3])
  if (price == null || price === 0) return null
  // A 股这里给的是「股」，东财口径是「手」，统一成手。
  const volume = num(c[8])
  const prevClose = num(c[2])
  // A 股长表没有涨跌列，用昨收推出来。
  const change = prevClose != null ? Number((price - prevClose).toFixed(3)) : null
  return {
    name: c[0],
    price,
    prevClose,
    open: num(c[1]),
    high: num(c[4]),
    low: num(c[5]),
    change,
    changePct:
      prevClose ? Number((((price - prevClose) / prevClose) * 100).toFixed(2)) : null,
    volume: volume == null ? null : Math.round(volume / 100),
    amount: num(c[9]),
  }
}

/** 新浪快照批量。返回 secid → quote 的 Map。 */
export async function sinaQuotes(secids) {
  const wanted = new Map()
  for (const secid of secids) {
    const sc = toSinaCode(secid)
    if (sc) wanted.set(sc, secid)
  }
  if (!wanted.size) return new Map()
  const codes = [...wanted.keys()]
  const out = new Map()
  for (let i = 0; i < codes.length; i += 40) {
    const batch = codes.slice(i, i + 40)
    const text = await cached(`snq:${batch.join(',')}`, 10_000, () =>
      fetchGbk(QUOTE_HOST + batch.map(enc).join(','), { headers: REFERER }),
    )
    for (const line of text.split('\n')) {
      const eq = line.indexOf('="')
      if (eq < 0) continue
      const sinaCode = line.slice(line.indexOf('hq_str_') + 'hq_str_'.length, eq)
      const body = line.slice(eq + 2, line.lastIndexOf('"'))
      if (!body) continue
      const q = parseSinaLong(body, sinaCode)
      if (!q) continue
      const secid = wanted.get(sinaCode)
      if (secid) out.set(secid, { ...q, secid, market: marketOf(secid) })
    }
  }
  return out
}

function barsFrom(rows, limit) {
  return rows
    .map((r) => ({
      time: normTime(r.day ?? r.d),
      open: num(r.open ?? r.o),
      close: num(r.close ?? r.c),
      high: num(r.high ?? r.h),
      low: num(r.low ?? r.l),
      volume: num(r.volume ?? r.v),
    }))
    .filter((b) => b.time && b.close != null)
    .sort((a, b) => (a.time < b.time ? -1 : 1))
    .slice(-Math.max(2, limit))
}

const SCALE = { d: 240, m5: 5, m15: 15, m30: 30, m60: 60 }

/** A 股日 / 分钟 K：scale 240=日，5/15/30/60=分钟。新浪没有周 K / 月 K。 */
export async function sinaKline(secid, { period = 'd', limit = 240 } = {}) {
  const sc = toSinaCode(secid)
  if (!sc || sc.startsWith('hk') || sc.startsWith('gb_')) return null
  const scale = SCALE[period]
  if (!scale) return null
  const url = `${KLINE_HOST}?symbol=${enc(sc)}&scale=${scale}&ma=no&datalen=${Math.min(1023, limit)}`
  const json = await cached(`snk:${secid}:${period}:${limit}`, 5 * 60_000, () =>
    fetchJson(url, { headers: REFERER }),
  )
  const bars = barsFrom(Array.isArray(json) ? json : [], limit)
  if (!bars.length) return null
  return { secid, market: marketOf(secid), name: null, bars: withDerived(withMa(bars)) }
}

/** 东财 secid → 新浪美股日 K 的符号；非美股 / 残缺 secid 返回 null。 */
export function toSinaUsSymbol(secid) {
  const [m, code = ''] = String(secid || '').split('.')
  if (!code || !US_MARKET_PREFIXES.has(m)) return null
  const table = US_INDEX_SYMBOLS[m] || null
  return (table && table[code.toUpperCase()]) || code
}

/** 美股日 K：新浪给全历史（JSONP）。周 / 月 / 分钟无源。 */
export async function sinaUsKline(secid, { period = 'd', limit = 240 } = {}) {
  if (period !== 'd' || marketOf(secid) !== 'us') return null
  const symbol = toSinaUsSymbol(secid)
  if (!symbol) return null
  const rows = await cached(`snuk:${symbol}`, 30 * 60_000, async () => {
    const text = await fetchText(`${US_KLINE}?symbol=${enc(symbol)}&___qn=3`, {
      headers: { Referer: 'https://stock.finance.sina.com.cn' },
      timeout: 15_000,
    })
    const start = text.indexOf('([')
    const end = text.lastIndexOf('])')
    if (start < 0 || end <= start) throw new Error('上游返回非 JSONP')
    return JSON.parse(text.slice(start + 1, end + 1))
  })
  const bars = barsFrom(Array.isArray(rows) ? rows : [], limit)
  if (!bars.length) return null
  return { secid, market: 'us', name: null, bars: withDerived(withMa(bars)) }
}