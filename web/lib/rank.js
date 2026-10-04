import { fetchJson, cached } from './http.js'
import { sinaKline } from './sina.js'

// 每日推荐的数据源。东财 push2 整条线对服务器 502、同花顺榜单 ajax 401、雪球要登录，
// 实测**只有新浪**能拿到全 A 股列表 + 日 K。所以：
//   1) 新浪榜单接口按成交额取候选池（全市场逐个算月涨幅请求太多）
//   2) 逐只拉新浪日 K，算「近一月涨幅」(20 个交易日)
//
// 新浪榜单接口一次最多 num 条，按 amount 降序分页取前 N。

const LIST_API =
  'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData'
const REFERER = { Referer: 'https://finance.sina.com.cn' }

/** 近一月 ≈ 20 个交易日。 */
export const MONTH_TRADING_DAYS = 20

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 新浪 symbol（sz300308 / sh600519）→ 东财风格 secid（0.300308 / 1.600519）。 */
export function secidOfSinaSymbol(symbol) {
  const m = /^(sh|sz)(\d{6})$/i.exec(String(symbol || '').trim())
  if (!m) return null
  return `${m[1].toLowerCase() === 'sh' ? 1 : 0}.${m[2]}`
}

/**
 * 按成交额降序取全 A 股候选池（默认前 500）。
 * 新浪单页最多 100 条，所以 pages=5 → 约 500 只。
 */
export async function aSharePool({ pages = 5, perPage = 100 } = {}) {
  const bySecid = new Map()
  for (let p = 1; p <= pages; p += 1) {
    const url = `${LIST_API}?page=${p}&num=${perPage}&sort=amount&asc=0&node=hs_a&symbol=`
    let rows
    try {
      rows = await cached(`snrk:${p}:${perPage}`, 10 * 60_000, () => fetchJson(url, { headers: REFERER }))
    } catch {
      break
    }
    if (!Array.isArray(rows) || !rows.length) break
    for (const r of rows) {
      const secid = secidOfSinaSymbol(r?.symbol)
      if (!secid) continue
      bySecid.set(secid, {
        secid,
        code: String(r.code || ''),
        name: String(r.name || '').trim(),
        price: num(r.trade),
        changePct: num(r.changepercent),
        amount: num(r.amount),
        turnover: num(r.turnoverratio),
        mktcap: num(r.mktcap),
        floatCap: num(r.nmc),
      })
    }
  }
  return [...bySecid.values()]
}

/** 从日 K（升序）算近一月涨幅：最新收盘 / N 个交易日前收盘 − 1。 */
export function monthChangeFromBars(bars, days = MONTH_TRADING_DAYS) {
  if (!Array.isArray(bars) || bars.length < 2) return null
  const last = bars[bars.length - 1]?.close
  const i = Math.max(0, bars.length - 1 - days)
  const base = bars[i]?.close
  if (last == null || base == null || base === 0) return null
  return Number(((last / base - 1) * 100).toFixed(2))
}

/** 单只近一月涨幅（走新浪日 K）。 */
export async function monthChange(secid) {
  const k = await sinaKline(secid, { period: 'd', limit: MONTH_TRADING_DAYS + 6 })
  return monthChangeFromBars(k?.bars, MONTH_TRADING_DAYS)
}

/** 有界并发的 map：任一项抛错就记 null，不让一只坏票拖垮整批。 */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length).fill(null)
  let cursor = 0
  const worker = async () => {
    for (;;) {
      const i = cursor
      cursor += 1
      if (i >= items.length) return
      try {
        out[i] = await fn(items[i], i)
      } catch {
        out[i] = null
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}

/**
 * 给候选池逐只补上近一月涨幅，按涨幅降序返回。
 * 取不到涨幅（次新股 / 停牌 / 上游抽风）的条目直接剔除，不参与排名。
 */
export async function rankByMonthChange(pool, { limit = 8, compute = monthChange } = {}) {
  const enriched = await mapLimit(pool, limit, async (x) => {
    const monthPct = await compute(x.secid)
    return { ...x, monthPct }
  })
  return enriched
    .filter((x) => x && x.monthPct != null)
    .sort((a, b) => b.monthPct - a.monthPct || a.code.localeCompare(b.code))
}
