// 策略实验室（只读）：读 /data/shadow 的每日快照 + 注册表，按持有规则算推荐/模拟持仓。
// 线上 A/B/dual 的 /api/recommend、/api/positions 完全不受影响。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cachedKline } from './kline-cache.js'
import { sharesFor } from './positions.js'
import { getQuotes } from './market.js'
import { DATA_DIR } from './scope.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REG_PATH = process.env.LAB_REGISTRY || path.join(__dirname, '../config/lab-strategies.json')
const REG = JSON.parse(fs.readFileSync(REG_PATH, 'utf8'))
const STYLE_SECID = { 沪深300: '1.000300', 创业板指: '0.399006', 中证1000: '1.000852' }
const TTL = 5 * 60_000
const MEMO = new Map()
const memoGet = (k) => { const v = MEMO.get(k); return v && Date.now() - v.t < TTL ? v.v : null }
const memoSet = (k, v) => { MEMO.set(k, { t: Date.now(), v }); return v }
const round2 = (n) => (n == null || !Number.isFinite(n) ? null : Number(n.toFixed(2)))
const pct = (n) => (n == null || !Number.isFinite(n) ? null : round2(n * 100))
const barCache = new Map()
const barsOf = async (sid) => { if (!barCache.has(sid)) barCache.set(sid, (await cachedKline(sid).catch(() => null))?.bars || []); return barCache.get(sid) }
const findGe = (bs, t) => { for (let i = 0; i < bs.length; i += 1) if (bs[i].time >= t) return i; return -1 }
const findLe = (bs, t) => { for (let i = bs.length - 1; i >= 0; i -= 1) if (bs[i].time <= t) return i; return -1 }
const px = (b, k) => (b ? Number(b[k]) || null : null)
const emptySummary = () => ({ count: 0, openCount: 0, closedCount: 0, invested: 0, openCost: 0, realized: 0, unrealized: 0, total: 0, returnPct: null, winPct: null })

export function labDates() {
  const set = new Set()
  for (const src of Object.values(REG.sources)) {
    const dir = path.join(DATA_DIR, src)
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) set.add(f.slice(0, 10))
  }
  return [...set].sort()
}
export function labStrategies() {
  return { name: REG.name, forwardWindow: REG.forwardWindow, holdRules: REG.holdRules, strategies: REG.strategies, dates: labDates() }
}
const loadShadow = (src, date) => {
  const p = path.join(DATA_DIR, src, `${date}.json`)
  if (!fs.existsSync(p)) return null
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}
async function resolvePicks(st, date) {
  const src = st.source
  if (['A', 'B', 'dual', 'Btuned'].includes(src)) {
    const p = loadShadow(REG.sources[src], date)
    return p?.top?.length ? { picks: p.top.map((x) => ({ ...x, sleeve: src, style: st.style || '沪深300' })), basisDate: p.basisDate || null, style: st.style || '沪深300' } : null
  }
  if (src === 'blend50') {
    const a = loadShadow(REG.sources.A, date)
    const b = loadShadow(REG.sources.B, date)
    if (!a?.top?.length || !b?.top?.length) return null
    return { picks: [...a.top.map((x) => ({ ...x, sleeve: 'A', style: '沪深300' })), ...b.top.map((x) => ({ ...x, sleeve: 'B', style: '创业板指' }))], basisDate: a.basisDate || null, style: '创业板指' }
  }
  if (src === 'dual-tilt') {
    const a = loadShadow(REG.sources.A, date)
    const b = loadShadow(REG.sources.B, date)
    if (!a?.top?.length || !b?.top?.length) return null
    const tilt = Number(a.regime?.tilt ?? b.regime?.tilt ?? 0)
    const useA = tilt >= Number(st.tilt)
    return { picks: (useA ? a : b).top.map((x) => ({ ...x, sleeve: useA ? 'A' : 'B', style: useA ? '沪深300' : '创业板指' })), basisDate: a.basisDate || null, style: useA ? '沪深300' : '创业板指' }
  }
  // A-filtered：LLM A + 收盘>MA20 且 20日动量>0（确定性过滤，无训练）
  if (src === 'A-f') {
    const a = loadShadow(REG.sources.A, date)
    if (!a?.top?.length) return null
    const basis = a.basisDate || date
    const kept = []
    for (const p of a.top) {
      const bs = await barsOf(p.secid)
      const i = findLe(bs, basis)
      if (i < 20) continue
      const closes = bs.slice(i - 19, i + 1).map((x) => px(x, 'close')).filter((v) => v != null)
      if (closes.length < 20) continue
      const close = closes[closes.length - 1]
      const ma20 = closes.reduce((x, y) => x + y, 0) / closes.length
      const prev = px(bs[i - 20], 'close')
      const mom20 = prev ? close / prev - 1 : null
      if (close > ma20 && mom20 != null && mom20 > 0) kept.push({ ...p, sleeve: 'A', style: '沪深300' })
    }
    return kept.length ? { picks: kept, basisDate: a.basisDate || null, style: '沪深300' } : null
  }
  // dual-voltarget：沪深300 vs 创业板 20日波动率，低波一侧优先（确定性）
  if (src === 'voltarget') {
    const a = loadShadow(REG.sources.A, date)
    const b = loadShadow(REG.sources.B, date)
    if (!a?.top?.length || !b?.top?.length) return null
    const basis = a.basisDate || date
    const volOf = async (secid) => {
      const bs = await barsOf(secid)
      const i = findLe(bs, basis)
      if (i < 21) return null
      const rs = []
      for (let k = i - 19; k <= i; k += 1) {
        const c = px(bs[k], 'close')
        const p0 = px(bs[k - 1], 'close')
        if (c && p0) rs.push(c / p0 - 1)
      }
      return rs.length ? Math.sqrt(rs.reduce((s0, r) => s0 + r * r, 0) / rs.length) : null
    }
    const va = await volOf('1.000300')
    const vb = await volOf('0.399006')
    const useA = va != null && vb != null ? va <= vb : false
    return { picks: (useA ? a : b).top.map((x) => ({ ...x, sleeve: useA ? 'A' : 'B', style: useA ? '沪深300' : '创业板指' })), basisDate: basis, style: useA ? '沪深300' : '创业板指' }
  }
  return null
}
async function applyPick(p, rule, date, opt = {}) {
  const bs = await barsOf(p.secid)
  if (!bs.length) return null
  const ei = findGe(bs, date)
  // 当天：日K还没这根 → 用实时「今开/现价」兜底（与线上持仓同口径）；非当天不拿别的价充数。
  if (ei < 0) {
    if (opt.useQuote && Number(opt.quote?.open) > 0) {
      const entry = Number(opt.quote.open)
      const latest = Number(opt.quote.price) || entry
      const hold = rule.type === 'llm' ? Math.max(1, Number(p.aiHoldDays ?? 10)) : rule.n ?? null
      const bret = opt.indexQuote && Number(opt.indexQuote.open) > 0 ? Number(opt.indexQuote.price) / Number(opt.indexQuote.open) - 1 : null
      const ret = latest / entry - 1
      return { ...p, entryDate: date, entryPrice: round2(entry), exitDate: null, exitPrice: null, holdDays: hold, done: false, status: '持有中', retPct: pct(ret), benchPct: pct(bret), excessPct: pct(bret == null ? null : ret - bret), latestPrice: latest }
    }
    return { ...p, entryDate: date, entryPrice: null, exitDate: null, exitPrice: null, holdDays: null, done: false, status: '待开盘', retPct: null, benchPct: null, excessPct: null }
  }
  const entry = px(bs[ei], 'open') ?? px(bs[ei], 'close')
  if (!entry) return null
  let exitBar = bs[bs.length - 1]
  let exitKind = 'close'
  let done = false
  let hold = null
  if (rule.type === 'fixed' || rule.type === 'llm') {
    hold = rule.type === 'llm' ? Math.max(1, Number(p.aiHoldDays ?? 10)) : rule.n
    const xi = ei + hold
    if (xi < bs.length) { exitBar = bs[xi]; exitKind = 'open'; done = true }
  } else if (rule.type === 'trail') {
    let peak = px(bs[ei], 'close') ?? entry
    for (let k = ei + 1; k < Math.min(ei + 61, bs.length); k += 1) {
      const c = px(bs[k], 'close')
      if (c == null) continue
      if (c > peak) peak = c
      if (c / peak - 1 <= -rule.pct / 100) { exitBar = bs[k]; done = true; break }
    }
  } else return null
  const exit = px(exitBar, exitKind) ?? px(exitBar, 'close')
  if (!exit) return null
  const ret = exit / entry - 1
  const sb = await barsOf(STYLE_SECID[p.style] || '1.000300')
  const bi = findLe(sb, date)
  const bj = findLe(sb, exitBar.time)
  let bret = null
  if (bi >= 0 && bj >= 0) {
    const be = px(sb[bi], 'open') ?? px(sb[bi], 'close')
    const bx = exitKind === 'open' ? px(sb[bj], 'open') ?? px(sb[bj], 'close') : px(sb[bj], 'close')
    if (be && bx) bret = bx / be - 1
  }
  return { ...p, entryDate: date, entryPrice: round2(entry), exitDate: exitBar.time, exitPrice: round2(exit), holdDays: hold, done, status: done ? (rule.type === 'trail' ? '已触发' : '已了结') : '持有中', retPct: pct(ret), benchPct: pct(bret), excessPct: pct(bret == null ? null : ret - bret), latestPrice: opt.useQuote ? Number(opt.quote?.price) || null : null }
}
export async function labRecommend(id, date) {
  const st = REG.strategies.find((s) => s.id === id)
  if (!st) return null
  const d = date || labDates().at(-1)
  if (!d) return null
  const key = `rec:${id}:${d}`
  const hit = memoGet(key)
  if (hit) return hit
  const r = await resolvePicks(st, d)
  if (!r) return null
  const rule = REG.holdRules[st.hold]
  const bj = new Date(Date.now() + 8 * 3600_000)
  const today = bj.toISOString().slice(0, 10)
  const mins = bj.getUTCHours() * 60 + bj.getUTCMinutes()
  const useQuote = d === today && mins >= 9 * 60 + 30
  const qmap = new Map()
  if (useQuote) {
    try {
      const q = await getQuotes([...new Set([...r.picks.map((p) => p.secid), ...Object.values(STYLE_SECID)])])
      for (const x of q.items || []) qmap.set(x.secid, x)
    } catch {
      /* 行情挂了退回日K/待开盘 */
    }
  }
  const top = (await Promise.all(r.picks.map((p) => applyPick(p, rule, d, { useQuote, quote: qmap.get(p.secid), indexQuote: qmap.get(STYLE_SECID[p.style] || '1.000300') })))).filter(Boolean)
  const rets = top.map((p) => p.retPct).filter((v) => v != null)
  const exs = top.map((p) => p.excessPct).filter((v) => v != null)
  return memoSet(key, {
    strategy: st, date: d, basisDate: r.basisDate, style: r.style,
    hold: { name: st.hold, ...rule }, top,
    summary: { n: top.length, meanRet: rets.length ? round2(rets.reduce((a, b) => a + b, 0) / rets.length) : null, meanExcess: exs.length ? round2(exs.reduce((a, b) => a + b, 0) / exs.length) : null, win: exs.length ? round2((exs.filter((v) => v > 0).length / exs.length) * 100) : null, pending: top.filter((p) => p.status === '待开盘').length },
  })
}
export async function labPositions(id, asOf) {
  const st = REG.strategies.find((s) => s.id === id)
  if (!st) return null
  const dates = labDates().filter((d) => !asOf || d <= asOf)
  if (!dates.length) return { asOf: asOf || null, dates: [], summary: emptySummary(), open: [], closed: [], equity: [], benchName: st.style || '沪深300', strategy: st }
  const end = asOf || dates[dates.length - 1]
  const key = `pos:${id}:${end}`
  const hit = memoGet(key)
  if (hit) return hit
  const lots = []
  for (const d of dates) {
    const rec = await labRecommend(id, d)
    if (!rec) continue
    for (const p of rec.top) {
      if (p.entryPrice == null) continue
      const shares = sharesFor(p.entryPrice)
      if (shares > 0) lots.push({ ...p, shares })
    }
  }
  const open = []
  const closed = []
  let invested = 0
  let openCost = 0
  let realized = 0
  let unrealized = 0
  for (const l of lots) {
    invested += l.shares * l.entryPrice
    if (l.done && l.exitPrice != null) {
      const pnl = round2(l.shares * (l.exitPrice - l.entryPrice))
      realized += pnl
      closed.push({ secid: l.secid, code: l.code, name: l.name, sleeve: l.sleeve, sellDate: l.exitDate, sellPrice: l.exitPrice, shares: l.shares, avgCost: l.entryPrice, pnl, reason: l.status })
    } else {
      const bs = await barsOf(l.secid)
      const i = findLe(bs, end)
      const last = l.latestPrice != null ? l.latestPrice : i >= 0 ? px(bs[i], 'close') : null
      const pnl = last != null ? round2(l.shares * (last - l.entryPrice)) : null
      if (pnl != null) unrealized += pnl
      openCost += l.shares * l.entryPrice
      open.push({ secid: l.secid, code: l.code, name: l.name, sleeve: l.sleeve, shares: l.shares, avgCost: l.entryPrice, lastPrice: last, mv: last != null ? round2(l.shares * last) : null, pnl, retPct: last != null ? pct(last / l.entryPrice - 1) : null })
    }
  }
  const total = round2(realized + unrealized)
  const summary = { count: lots.length, openCount: open.length, closedCount: closed.length, invested: round2(invested), openCost: round2(openCost), realized: round2(realized), unrealized: round2(unrealized), total, returnPct: invested > 0 ? round2((total / invested) * 100) : null, winPct: closed.length ? round2(closed.filter((x) => x.pnl > 0).length / closed.length) : null }
  const style = st.style || '沪深300'
  const sb = await barsOf(STYLE_SECID[style] || '1.000300')
  const b0 = findLe(sb, dates[0])
  const base = b0 >= 0 ? px(sb[b0], 'close') : null
  const equity = []
  for (const d of dates) {
    let inv = 0
    let real = 0
    let un = 0
    for (const l of lots) {
      if (l.entryDate > d) continue
      inv += l.shares * l.entryPrice
      if (l.done && l.exitDate && l.exitDate <= d && l.exitPrice != null) real += l.shares * (l.exitPrice - l.entryPrice)
      else {
        const bs = await barsOf(l.secid)
        const i = findLe(bs, d)
        const c = d === end && l.latestPrice != null ? l.latestPrice : i >= 0 ? px(bs[i], 'close') : null
        if (c != null) un += l.shares * (c - l.entryPrice)
      }
    }
    const bi = findLe(sb, d)
    const c = bi >= 0 ? px(sb[bi], 'close') : null
    equity.push({ date: d, ret: inv > 0 ? round2(((real + un) / inv) * 100) : 0, bench: base && c ? round2((c / base - 1) * 100) : null })
  }
  const out = { asOf: end, dates, summary, open: open.sort((a, b) => (b.pnl ?? -1e18) - (a.pnl ?? -1e18)), closed: closed.sort((a, b) => (b.pnl ?? -1e18) - (a.pnl ?? -1e18)), equity, benchName: style, strategy: st }
  return memoSet(key, out)
}
export async function labLeaderboard(asOf) {
  const key = `lb:${asOf || 'latest'}`
  const hit = memoGet(key)
  if (hit) return hit
  const items = []
  for (const st of REG.strategies) {
    const p = await labPositions(st.id, asOf)
    items.push({ id: st.id, source: st.source, hold: st.hold, control: !!st.control, summary: p?.summary || emptySummary() })
  }
  items.sort((a, b) => (b.summary.returnPct ?? -1e9) - (a.summary.returnPct ?? -1e9))
  return memoSet(key, { asOf: asOf || labDates().at(-1) || null, items })
}
