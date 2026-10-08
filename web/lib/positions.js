/**
 * 「模拟推荐持仓」：把历史推荐当成一个模拟组合来算。
 *
 * 两种口径（前端可切换）：
 *   - orig（原始周期）：每只按文件里的原始 holdDays 持有到到期日收盘卖出。
 *   - ai（AI动态调整）：套用 recommend-actions.json 的提前终止 / 延长周期。
 *
 * 每只固定 1 万元：低价股整手取整（≥1 手），一手就超 1 万的高价股用小数股保证成本≈1万。
 *
 * 曲线（甲·净值法，贴近基金）：组合日收益 = 当日**持仓标的等权**涨跌，逐日链式累乘成
 * 累计收益率%；沪深300 同起点归一，三者（原始 / AI / 沪深300）叠加在同一张图。
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

/** 目标成本 1 万：低价股整手取整（≥1 手）；一手就超 1 万的高价股用小数股。 */
export function sharesFor(price) {
  const p = Number(price)
  if (!(p > 0)) return 0
  if (p * 100 <= PER_STOCK) return Math.max(100, Math.round(PER_STOCK / p / 100) * 100)
  return Number((PER_STOCK / p).toFixed(4))
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
  // 全页统一按该日收盘估值，保证「上方汇总 == 曲线末点」。
  const valuationDate = benchBars.length ? benchBars[benchBars.length - 1].time : bjDate()
  // 全局起点 = 所有链路里最早的买入日：三条曲线共用同一 x 轴（A/B 数据晚也画得出来）。
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
  return { count: 0, openCount: 0, closedCount: 0, invested: 0, realized: 0, unrealized: 0, total: 0, returnPct: null, winPct: null }
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
    // 买入日归一到一个**交易日**：basisDate 可能是跑批当天恰好是假日（如 10-06/10-07），
    // 而买入价本就是「≤ 该日的最后交易日收盘」，所以退到 prevTradingDay，起算/日历才对得上。
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

  // 持仓估值一律用「估值日收盘」：不再取实时价（未开盘时实时=上一收盘、且与日K可能不同源，
  // 会让曲线末点与逐日点对不上）。缺当日收盘则退回该票最近一根收盘。
  const closeOn = (b, day) => closeMap.get(b.secid)?.get(day) ?? null
  const spotOf = (b) => closeOn(b, valuationDate) ?? lastClose.get(b.secid)?.close ?? null

  const o = buildMode(buys, 'orig', { valuationDate, closeOn, spotOf })
  const a = buildMode(buys, 'ai', { valuationDate, closeOn, spotOf })
  const equity = buildEquity(buys, { closeMap, benchBars, valuationDate, orig: o.positions, ai: a.positions, globalStart })
  return {
    orig: { summary: summarize(o.positions), ...split(o.positions), trades: o.trades },
    ai: { summary: summarize(a.positions), ...split(a.positions), trades: a.trades },
    equity,
  }
}

/** 某票在指定口径下的生效持有天数。 */
function effHoldOf(b, mode) {
  if (mode === 'ai' && b.pos && !b.pos.exited && Number.isFinite(Number(b.pos.holdDays))) return Number(b.pos.holdDays)
  return b.origHold
}

/** 生成某口径下的所有持仓（未了结在 open，已了结在 closed），并带交易流水。 */
function buildMode(buys, mode, { valuationDate, closeOn, spotOf }) {
  const positions = []
  const trades = []
  for (const b of buys) {
    const shares = sharesFor(b.buyPrice)
    if (!(shares > 0)) continue
    const cost = Number((shares * b.buyPrice).toFixed(2))
    let sellDate = null
    let sellPrice = null
    let reason = null
    if (mode === 'ai' && b.pos?.exited && b.pos?.exit) {
      sellDate = b.pos.exit.date
      sellPrice = Number(b.pos.exit.price)
      reason = 'ai'
    } else {
      const eff = b.pos && !b.pos.exited && Number.isFinite(Number(b.pos.holdDays)) && mode === 'ai' ? Number(b.pos.holdDays) : b.origHold
      sellDate = addTradingDays(b.buyDate, eff)
      reason = 'cycle'
    }
    // 只有「结束日 ≤ 估值日」且**取得到结束日收盘**才算已卖出；否则保持持仓（按估值日收盘估值）。
    const dueClosed = !!sellDate && sellDate <= valuationDate
    if (dueClosed && !Number.isFinite(sellPrice)) sellPrice = closeOn(b, sellDate)
    const closed = dueClosed && sellPrice != null
    const priceNow = closed ? sellPrice : spotOf(b)
    const sharesNow = shares
    const pnl = priceNow != null ? Number((sharesNow * (priceNow - b.buyPrice)).toFixed(2)) : null
    const item = {
      secid: b.secid,
      code: b.code,
      name: b.name,
      recDate: b.recDate,
      buyDate: b.buyDate,
      buyPrice: round2(b.buyPrice),
      shares: sharesNow,
      cost,
      lastPrice: round2(priceNow),
      retPct: priceNow != null ? round2(((priceNow / b.buyPrice - 1) * 100)) : null,
      pnl,
      holdDays: b.origHold,
      effHoldDays: mode === 'ai' ? effHoldOf(b, 'ai') : b.origHold,
      sellDate: closed ? sellDate : null,
      sellPrice: closed ? round2(sellPrice) : null,
      expectedSellDate: sellDate,
      reason: closed ? reason : null,
      extended: !!(mode === 'ai' && b.pos && !b.pos.exited && Number(b.pos.holdDays) > b.origHold),
      terminated: !!(mode === 'ai' && b.pos?.exited),
      open: !closed,
    }
    positions.push(item)
    trades.push({ date: b.buyDate, code: b.code, name: b.name, secid: b.secid, dir: 'buy', shares, price: round2(b.buyPrice), amount: cost })
    if (closed && sellPrice != null) {
      trades.push({ date: sellDate, code: b.code, name: b.name, secid: b.secid, dir: 'sell', shares, price: round2(sellPrice), amount: Number((shares * sellPrice).toFixed(2)), pnl, reason })
    }
  }
  trades.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return { positions, trades }
}

function split(positions) {
  const open = positions.filter((p) => p.open)
  const closed = positions.filter((p) => !p.open)
  return { open, closed }
}

function summarize(positions) {
  const invested = Number(positions.reduce((a, p) => a + p.cost, 0).toFixed(2))
  const realized = Number(positions.filter((p) => !p.open && p.pnl != null).reduce((a, p) => a + p.pnl, 0).toFixed(2))
  const unrealized = Number(positions.filter((p) => p.open && p.pnl != null).reduce((a, p) => a + p.pnl, 0).toFixed(2))
  const closed = positions.filter((p) => !p.open && p.pnl != null)
  const total = Number((realized + unrealized).toFixed(2))
  return {
    count: positions.length,
    openCount: positions.filter((p) => p.open).length,
    closedCount: closed.length,
    invested,
    realized,
    unrealized,
    total,
    returnPct: invested > 0 ? round2((total / invested) * 100) : null,
    winPct: closed.length ? Number((closed.filter((p) => p.pnl > 0).length / closed.length).toFixed(4)) : null,
  }
}

/** 金额法：逐日（已实现+浮动）/累计投入；沪深300 同起点按收盘归一。 */
function buildEquity(buys, { closeMap, benchBars, valuationDate, orig, ai, globalStart }) {
  const benchByDay = new Map()
  for (const b of benchBars) if (b.close != null) benchByDay.set(b.time, b.close)
  const chainStart = buys.reduce((m, b) => (b.buyDate < m ? b.buyDate : m), buys[0].buyDate)
  const start = globalStart && globalStart < chainStart ? globalStart : chainStart
  const cal = benchBars.map((b) => b.time).filter((t) => t >= start && t <= valuationDate).sort()
  if (cal.length === 0) return []

  const closeOf = (secid, day) => closeMap.get(secid)?.get(day) ?? null
  // 金额法：某日收益率 =（当日已实现 + 当日浮动）/ 截至当日累计投入。估值日收尾，
  // 与上方「总盈亏/累计投入」一致。
  const seriesAccount = (positions) => {
    const out = []
    for (const t of cal) {
      let realized = 0
      let unrealized = 0
      let invested = 0
      for (const p of positions) {
        if (p.buyDate > t) continue
        invested += p.cost
        if (p.sellDate && p.sellDate <= t) {
          const sp = p.sellPrice ?? closeOf(p.secid, t)
          if (sp != null) realized += p.shares * (sp - p.buyPrice)
        } else {
          const c = closeOf(p.secid, t)
          if (c != null) unrealized += p.shares * (c - p.buyPrice)
        }
      }
      out.push({ date: t, pct: invested > 0 ? round2(((realized + unrealized) / invested) * 100) : 0 })
    }
    return out
  }
  const origS = seriesAccount(orig)
  const aiS = seriesAccount(ai)
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
