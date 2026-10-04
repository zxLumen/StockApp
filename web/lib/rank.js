import { fetchJson, cached } from './http.js'
import { sinaKline } from './sina.js'

// 每日推荐的数据源。东财 push2 整条线对服务器 502、同花顺榜单 ajax 401、雪球要登录，
// 实测**只有新浪**能拿到全 A 股列表 + 日 K。所以：
//   1) 新浪榜单接口按成交额取候选池（全市场逐个请求太多）
//   2) 客观初筛到 200 后交给模型选；近一月涨幅仅作展示字段，**不参与筛选**
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
 * 客观初筛：把成交额 Top500 压到 target（默认 200）。
 *
 * **只用客观、方向中性的规则**——目的只是踢掉「明显异常 / 不可交易 / 过热」的，
 * 不替模型判断好坏（方向交给模型）。阈值放宽，宁可多留不可错杀；参数集中在这里，
 * 上线后一眼可调。日志会打印剔了多少、因何剔。
 *
 * 规则（更宽口径）：
 *   - 停牌/无价/成交额为 0 → 剔（必须）
 *   - ST / *ST / 退市整理 → 剔
 *   - 近 5 日连续 ≥3 个涨停 → 剔（高位连板）
 *   - 单日换手 > 40% 或 振幅 > 25% → 剔（过热）
 * 剩下的按成交额降序取前 target。
 */
export const OBJECTIVE = {
  limitUpStreak: 3, // 近 5 日连续涨停达此数就剔
  streakWindow: 5,
  maxTurnover: 40, // %
  maxAmplitude: 25, // %
  target: 200,
}

/** ST / 退市/风险警示 标题一律剔除。 */
export function isSt(name) {
  return /ST|\*ST|退市|退$/.test(String(name || '').toUpperCase()) || /退/.test(String(name || ''))
}

/** 近 N 日是否出现 limitUpStreak 个连续涨停（按日 K 收盘涨幅 ≈ +9.8% 及以上）。 */
export function hasLimitUpStreak(bars, streak = 3, window = 5) {
  if (!Array.isArray(bars) || bars.length < 2) return false
  const recent = bars.slice(-(window + 1))
  let run = 0
  for (let i = 1; i < recent.length; i += 1) {
    const prev = recent[i - 1]?.close
    const cur = recent[i]?.close
    if (prev && cur && cur / prev - 1 >= 0.098) {
      run += 1
      if (run >= streak) return true
    } else {
      run = 0
    }
  }
  return false
}

/** 单日振幅（%）= (高-低)/前收。取最近一根。 */
export function lastAmplitude(bars) {
  if (!Array.isArray(bars) || bars.length < 2) return null
  const last = bars[bars.length - 1]
  const prev = bars[bars.length - 2]
  if (!last || !prev || !prev.close) return null
  const amp = ((last.high - last.low) / prev.close) * 100
  return Number.isFinite(amp) ? Number(amp.toFixed(2)) : null
}

/**
 * @param {Array} pool 成交额候选（含 price/changePct/amount/turnover/name/code/secid）
 * @param {{ target?:number, kline?: (secid:string)=>Promise<any>, onLog?:Function }} opts
 *   kline 缺省走新浪日 K；纯逻辑测试时传入假实现。
 */
export async function objectiveFilter(pool, { target = OBJECTIVE.target, kline, onLog = () => {} } = {}) {
  const getK = kline || ((secid) => sinaKline(secid, { period: 'd', limit: 12 }))
  const reasons = { noPrice: 0, st: 0, limitUp: 0, hot: 0 }
  const kept = []
  // 先做便宜的判断（停牌/ST），再拉日 K 做连板/振幅（有网络成本）
  const pre = pool.filter((x) => {
    if (!x || !x.price || !x.amount) {
      reasons.noPrice += 1
      return false
    }
    if (isSt(x.name)) {
      reasons.st += 1
      return false
    }
    return true
  })

  const checked = await mapLimit(pre, 8, async (x) => {
    let bars = null
    try {
      const k = await getK(x.secid)
      bars = k?.bars || null
    } catch {
      bars = null
    }
    const amp = lastAmplitude(bars)
    const turnover = Number(x.turnover)
    if (hasLimitUpStreak(bars, OBJECTIVE.limitUpStreak, OBJECTIVE.streakWindow)) {
      reasons.limitUp += 1
      return null
    }
    if (
      (Number.isFinite(turnover) && turnover > OBJECTIVE.maxTurnover) ||
      (amp != null && amp > OBJECTIVE.maxAmplitude)
    ) {
      reasons.hot += 1
      return null
    }
    return { ...x, amplitude: amp }
  })

  for (const x of checked) if (x) kept.push(x)
  kept.sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))
  onLog(
    `客观初筛：${pool.length} → ${kept.length}（取前 ${target}）；剔停牌 ${reasons.noPrice}、ST ${reasons.st}、连板 ${reasons.limitUp}、过热 ${reasons.hot}`,
  )
  return kept.slice(0, target)
}
