/**
 * 「模拟推荐持仓」：把历史推荐当成一个模拟组合来算，**移动加权平均成本**口径（券商式）。
 *
 * 两种口径（前端可切换）：
 *   - orig（原始周期）：每只按文件里的原始 holdDays 持有到到期日收盘卖出。
 *   - ai（AI动态调整）：套用 recommend-actions.json 的提前终止 / 延长周期。
 *
 * 每只固定 1 万元：低价股整手（100 股/手），一手就超 1 万的高价股取整股（股数一律整数）。
 *
 * 成本按**移动加权**逐股维护：买入摊薄、卖出只减数量（均价不变），卖出盈亏按当时的摊薄成本计。
 * 曲线用金额法（逐日 (已实现+浮动)/累计投入）——其和与成本口径无关，故不受本口径影响。
 */
import path from 'node:path'
import { readJson } from './store.js'
import { cached } from './http.js'
import { cachedKline } from './kline-cache.js'
import { mapLimit } from './rank.js'
import {
  bjDate,
  listRecommendDates,
  recommendTtlMs,
  BENCH_SECID,
  BENCH_NAME,
  CHAIN_SUBDIR,
} from './recommend.js'
import { addTradingDays, prevTradingDay } from './trading-days.js'

const ACTIONS_FILE = 'recommend-actions.json'
const PER_STOCK = 10000

/** 目标成本 1 万，**股数一律取整**：低价股整手（100 股/手）；一手就超 1 万的高价股取整股。 */
export function sharesFor(price) {
  const p = Number(price)
  if (!(p > 0)) return 0
  if (p * 100 <= PER_STOCK) return Math.max(100, Math.round(PER_STOCK / p / 100) * 100)
  return Math.max(1, Math.round(PER_STOCK / p))
}

const round2 = (n) => (n == null || !Number.isFinite(Number(n)) ? null : Number(Number(n).toFixed(2)))

/** 全部链路 × 两套口径（结果整体缓存：盘中 6min / 盘后长 TTL）。 */
export async function buildPositionsAll(dataDir, { ttlMs = recommendTtlMs() } = {}) {
  return cached('positions:all', ttlMs, () => computeAll(dataDir))
}

async function computeAll(dataDir) {
  const raw = await readJson(path.join(dataDir, ACTIONS_FILE), null)
  const actions = raw && raw.positions ? raw.positions : {}
  const benchBars = (await cachedKline(BENCH_SECID).catch(() => null))?.bars || []
  // 估值日 = 最近一个「有日K」的交易日（未开盘的今天不合成，避免幽灵点）。
  const valuationDate = benchBars.length ? benchBars[benchBars.length - 1].time : bjDate()
  // 全局起点 = 所有链路里最早的买入日：三条曲线共用同一 x 轴。
  let globalStart = null
  for (const chain of ['dual', 'A', 'B']) {
    const s = await earliestBasis(dataDir, chain).catch(() => null)
    if (s && (!globalStart || s < globalStart)) globalStart = s
  }
  const chains = {}
  for (const chain of ['dual', 'A', 'B']) {
    chains[chain] = await computeChain(dataDir, chain, actions, benchBars, globalStart, valuationDate).catch(() => emptyChain())
  }
  return { benchName: BENCH_NAME, asOf: valuationDate, chains }
}

/** 该链路最早一天的买入日（归一到交易日）。 */
async function earliestBasis(dataDir, chain) {
  const dates = await listRecommendDates(dataDir, chain)
  if (!dates.length) return null
  const d = dates.slice().sort()[0]
  const p = await readJson(path.join(dataDir, CHAIN_SUBDIR[chain] || 'recommend', `${d}.json`), null)
  return prevTradingDay(p?.basisDate || d)
}

function emptyChain() {
  return { orig: emptyMode(), ai: emptyMode(), equity: [] }
}
function emptyMode() {
  return { summary: emptySummary(), open: [], closed: [], trades: [] }
}
function emptySummary() {
  return { count: 0, openCount: 0, closedCount: 0, invested: 0, openCost: 0, realized: 0, unrealized: 0, total: 0, returnPct: null, winPct: null }
}

async function computeChain(dataDir, chain, actions, benchBars, globalStart, valuationDate) {
  const sub = CHAIN_SUBDIR[chain] || 'recommend'
  const dates = (await listRecommendDates(dataDir, chain)).slice().sort() // 升序
  if (!dates.length) return emptyChain()

  // 1) 收集买入（每个推荐日的每只票 = 一次模拟买入）
  const buys = []
  for (const D of dates) {
    const p = await readJson(path.join(dataDir, sub, `${D}.json`), null)
    if (!p || !Array.isArray(p.top)) continue
    // 买入日归一到交易日（basisDate 可能是跑批当天恰逢假日）。
    const buyDate = prevTradingDay(p.basisDate || D)
    for (const s of p.top) {
      const origHold = Number(s.ai?.holdDays ?? s.holdDays)
      if (!s.secid || !Number.isFinite(origHold) || !(s.price > 0)) continue
      buys.push({
        chain,
        recDate: D,
        secid: s.secid,
        code: s.code,
        name: s.name,
        buyDate,
        buyPrice: Number(s.price),
        origHold,
        pos: actions[`${chain}:${D}:${s.code}`] || null,
      })
    }
  }
  if (!buys.length) return emptyChain()

  // 2) 拉每只日K（收盘序列）
  const closeMap = new Map() // secid -> Map<date, close>
  const lastClose = new Map() // secid -> {date, close}
  const secids = [...new Set(buys.map((b) => b.secid))]
  await mapLimit(secids, 8, async (sid) => {
    const k = await cachedKline(sid).catch(() => null)
    const m = new Map()
    for (const bar of k?.bars || []) if (bar.close != null) m.set(bar.time, bar.close)
    if (m.size) {
      closeMap.set(sid, m)
      const last = (k.bars || [])[k.bars.length - 1]
      lastClose.set(sid, { date: last?.time ?? null, close: last?.close ?? null })
    }
  })

  const closeOn = (secid, day) => closeMap.get(secid)?.get(day) ?? null
  const priceAt = (secid) => closeOn(secid, valuationDate) ?? lastClose.get(secid)?.close ?? null

  const o = buildLedger(buys, 'orig', { valuationDate, closeOn, priceAt })
  const a = buildLedger(buys, 'ai', { valuationDate, closeOn, priceAt })
  const equity = buildEquity(buys, { closeMap, benchBars, valuationDate, globalStart, origLots: o.lots, aiLots: a.lots })
  return {
    orig: { summary: o.summary, open: o.open, closed: o.closed, trades: o.trades },
    ai: { summary: a.summary, open: a.open, closed: a.closed, trades: a.trades },
    equity,
  }
}

/** 某笔在指定口径下的生效持有天数。 */
function effHoldOf(b, mode) {
  if (mode === 'ai' && b.pos && !b.pos.exited && Number.isFinite(Number(b.pos.holdDays))) return Number(b.pos.holdDays)
  return b.origHold
}

/**
 * 移动加权台账：把「逐笔买入 + 逐笔结束卖出」按时间排序（**同日先买后卖**），逐股维护 {股数,成本}。
 * 买入摊薄；卖出按当时均价计已实现，只减数量、均价不变。估值日给出 持仓中/已了结/流水/汇总。
 */
function buildLedger(buys, mode, { valuationDate, closeOn, priceAt }) {
  const events = []
  const lots = [] // 供收益曲线（方法无关）
  let invested = 0
  for (const b of buys) {
    const shares = sharesFor(b.buyPrice)
    if (!(shares > 0)) continue
    let sellDate = null
    let sellPrice = null
    let reason = null
    if (mode === 'ai' && b.pos?.exited && b.pos?.exit) {
      sellDate = b.pos.exit.date
      sellPrice = Number(b.pos.exit.price)
      reason = 'ai'
    } else {
      sellDate = addTradingDays(b.buyDate, effHoldOf(b, mode))
      reason = 'cycle'
    }
    const dueClosed = !!sellDate && sellDate <= valuationDate
    if (dueClosed && !Number.isFinite(sellPrice)) sellPrice = closeOn(b.secid, sellDate)
    const closed = dueClosed && sellPrice != null
    invested += shares * b.buyPrice
    events.push({ date: b.buyDate, type: 'buy', secid: b.secid, code: b.code, name: b.name, shares, price: b.buyPrice })
    if (closed) events.push({ date: sellDate, type: 'sell', secid: b.secid, code: b.code, name: b.name, shares, price: sellPrice, reason })
    lots.push({ secid: b.secid, buyDate: b.buyDate, buyPrice: b.buyPrice, shares, sellDate: closed ? sellDate : null, sellPrice: closed ? sellPrice : null })
  }

  // 同日先买后卖
  events.sort((x, y) => (x.date !== y.date ? (x.date < y.date ? -1 : 1) : x.type === 'buy' ? -1 : 1))

  const book = new Map() // secid -> {shares, cost, code, name}
  const closed = []
  const trades = []
  for (const e of events) {
    const bk = book.get(e.secid) || { shares: 0, cost: 0, code: e.code, name: e.name }
    if (e.type === 'buy') {
      bk.shares += e.shares
      bk.cost += e.shares * e.price
      trades.push({ date: e.date, code: e.code, name: e.name, secid: e.secid, dir: 'buy', shares: e.shares, price: round2(e.price), amount: Number((e.shares * e.price).toFixed(2)), avgCost: null, pnl: null })
    } else {
      const avg = bk.shares > 0 ? bk.cost / bk.shares : 0
      const pnl = Number((e.shares * (e.price - avg)).toFixed(2))
      closed.push({ secid: e.secid, code: e.code, name: e.name, sellDate: e.date, sellPrice: round2(e.price), shares: e.shares, avgCost: round2(avg), pnl, reason: e.reason })
      bk.shares -= e.shares
      bk.cost -= e.shares * avg
      trades.push({ date: e.date, code: e.code, name: e.name, secid: e.secid, dir: 'sell', shares: e.shares, price: round2(e.price), amount: Number((e.shares * e.price).toFixed(2)), avgCost: round2(avg), pnl, reason: e.reason })
    }
    book.set(e.secid, bk)
  }

  const open = []
  let openCost = 0
  let unrealized = 0
  for (const [secid, bk] of book) {
    if (bk.shares <= 1e-9) continue
    const avg = bk.cost / bk.shares
    openCost += bk.shares * avg
    const price = priceAt(secid)
    const pnl = price != null ? bk.shares * (price - avg) : null
    if (pnl != null) unrealized += pnl
    open.push({
      secid,
      code: bk.code,
      name: bk.name,
      shares: bk.shares,
      avgCost: round2(avg),
      lastPrice: round2(price),
      mv: price != null ? Number((bk.shares * price).toFixed(2)) : null,
      pnl: pnl != null ? Number(pnl.toFixed(2)) : null,
      retPct: price != null && avg > 0 ? round2(((price / avg - 1) * 100)) : null,
    })
  }
  open.sort((x, y) => (y.pnl ?? -1e18) - (x.pnl ?? -1e18))

  const realized = Number(closed.reduce((a, p) => a + p.pnl, 0).toFixed(2))
  const unreal = Number(unrealized.toFixed(2))
  const total = Number((realized + unreal).toFixed(2))
  const summary = {
    count: buys.length,
    openCount: open.length,
    closedCount: closed.length,
    invested: Number(invested.toFixed(2)),
    openCost: Number(openCost.toFixed(2)),
    realized,
    unrealized: unreal,
    total,
    returnPct: invested > 0 ? round2((total / invested) * 100) : null,
    winPct: closed.length ? Number((closed.filter((p) => p.pnl > 0).length / closed.length).toFixed(4)) : null,
  }
  return { open, closed, trades, summary, invested, lots }
}

/** 金额法曲线：逐日（该口径下 realized+unrealized）/累计投入；沪深300 同起点按收盘归一。 */
function buildEquity(buys, { closeMap, benchBars, valuationDate, globalStart, origLots, aiLots }) {
  const benchByDay = new Map()
  for (const b of benchBars) if (b.close != null) benchByDay.set(b.time, b.close)
  const chainStart = buys.reduce((m, b) => (b.buyDate < m ? b.buyDate : m), buys[0].buyDate)
  const start = globalStart && globalStart < chainStart ? globalStart : chainStart
  const cal = benchBars.map((b) => b.time).filter((t) => t >= start && t <= valuationDate).sort()
  if (cal.length === 0) return []

  const closeOf = (secid, day) => closeMap.get(secid)?.get(day) ?? null
  const seriesAccount = (lots) => {
    const out = []
    for (const t of cal) {
      let realized = 0
      let unrealized = 0
      let invested = 0
      for (const p of lots) {
        if (p.buyDate > t) continue
        invested += p.shares * p.buyPrice
        if (p.sellDate && p.sellDate <= t) {
          if (p.sellPrice != null) realized += p.shares * (p.sellPrice - p.buyPrice)
        } else {
          const c = closeOf(p.secid, t)
          if (c != null) unrealized += p.shares * (c - p.buyPrice)
        }
      }
      out.push({ date: t, pct: invested > 0 ? round2(((realized + unrealized) / invested) * 100) : 0 })
    }
    return out
  }
  const origS = seriesAccount(origLots)
  const aiS = seriesAccount(aiLots)
  const benchS = (() => {
    const out = []
    let cum = 1
    let base = null
    for (let i = 0; i < cal.length; i += 1) {
      const t = cal[i]
      const c = benchByDay.get(t)
      if (i === 0 || base == null) {
        base = c ?? base
        out.push({ date: t, pct: 0 })
        continue
      }
      cum = c != null && base ? c / base : cum
      out.push({ date: t, pct: round2((cum - 1) * 100) })
    }
    return out
  })()
  const origMap = new Map(origS.map((x) => [x.date, x.pct]))
  const aiMap = new Map(aiS.map((x) => [x.date, x.pct]))
  const benchMap = new Map(benchS.map((x) => [x.date, x.pct]))
  const dates = [...new Set([...origS, ...aiS].map((x) => x.date))].sort()
  return dates.map((d) => ({
    date: d,
    orig: origMap.get(d) ?? null,
    ai: aiMap.get(d) ?? null,
    bench: benchMap.get(d) ?? null,
  }))
}
