// 多策略前瞻排行榜（12 月用）：读 /data/shadow 的 A/B/dual 每日快照 + 注册表，逐票应用持有规则。
// 只读；不改线上。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cachedKline } from '../../lib/kline-cache.js'
import { mean, median, bootstrapCI, costAdjust } from './metrics.js'

const argv = process.argv.slice(2)
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d }
const DATA = path.resolve(opt('--data-dir', '/data'))
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(opt('--repo', path.join(HERE, '../../..')))
const REG = path.resolve(opt('--registry', path.join(REPO, 'research/configs/strategies-2026-11.json')))
const FROM = opt('--from', '0000-00-00')
const TO = opt('--to', '9999-99-99')
const OUT = opt('--out', path.join(REPO, 'docs/research/LEADERBOARD.md'))
const reg = JSON.parse(fs.readFileSync(REG, 'utf8'))
const pct = (x) => (x == null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(2)}%`)
const num = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(d))

const cache = new Map()
const bars = async (sid) => { if (!cache.has(sid)) cache.set(sid, (await cachedKline(sid).catch(() => null))?.bars || []); return cache.get(sid) }
const findGe = (bs, t) => { for (let i = 0; i < bs.length; i += 1) if (bs[i].time >= t) return i; return -1 }
const findLe = (bs, t) => { for (let i = bs.length - 1; i >= 0; i -= 1) if (bs[i].time <= t) return i; return -1 }
const px = (b, k) => (b ? Number(b[k]) || null : null)
const styleCache = new Map()
const styleSecid = (name) => (name === '沪深300' ? '1.000300' : name === '创业板指' ? '0.399006' : name === '中证1000' ? '1.000852' : '1.000300')
async function styleBars(name) {
  if (!styleCache.has(name)) styleCache.set(name, (await cachedKline(styleSecid(name)).catch(() => null))?.bars || [])
  return styleCache.get(name)
}
function loadShadow(src, date) {
  const p = path.join(DATA, src, `${date}.json`)
  if (!fs.existsSync(p)) return null
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}
const dates = (() => {
  const set = new Set()
  for (const src of Object.values(reg.sources)) {
    const dir = path.join(DATA, src)
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) { const d = f.slice(0, 10); if (d >= FROM && d <= TO) set.add(d) }
  }
  return [...set].sort()
})()

async function oneTrade(pick, styleName, rule) {
  const bs = await bars(pick.secid)
  if (!bs.length) return null
  const ei = findGe(bs, pick.date)
  if (ei < 0) return null
  const entry = px(bs[ei], 'open') ?? px(bs[ei], 'close')
  if (!entry) return null
  let exitBar = bs[bs.length - 1]
  let exitKind = 'close'
  let done = false
  if (rule.type === 'fixed' || rule.type === 'llm') {
    const hold = rule.type === 'llm' ? Math.max(1, Number(pick.aiHoldDays ?? 10)) : rule.n
    const xi = ei + hold
    done = xi < bs.length
    if (done) { exitBar = bs[xi]; exitKind = 'open' }
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
  const sb = await styleBars(styleName)
  const bi = findLe(sb, pick.date)
  const bj = findLe(sb, exitBar.time)
  let bret = null
  if (bi >= 0 && bj >= 0) {
    const be = px(sb[bi], 'open') ?? px(sb[bi], 'close')
    const bx = exitKind === 'open' ? px(sb[bj], 'open') ?? px(sb[bj], 'close') : px(sb[bj], 'close')
    if (be && bx) bret = bx / be - 1
  }
  return { ret, bret, excess: bret == null ? null : ret - bret, done, date: pick.date }
}

async function picksFor(st, date) {
  if (['A', 'B', 'dual', 'Btuned'].includes(st.source)) {
    const p = loadShadow(reg.sources[st.source], date)
    return p?.top?.length ? { picks: p.top.map((t) => ({ ...t, date })), style: st.style } : null
  }
  if (st.source === 'A-f') {
    const a = loadShadow(reg.sources.A, date)
    if (!a?.top?.length) return null
    const basis = a.basisDate || date
    const kept = []
    for (const p of a.top) {
      const bs = await bars(p.secid)
      const i = findLe(bs, basis)
      if (i < 20) continue
      const closes = bs.slice(i - 19, i + 1).map((x) => px(x, 'close')).filter((v) => v != null)
      if (closes.length < 20) continue
      const close = closes[closes.length - 1]
      const ma20 = mean(closes)
      const prev = px(bs[i - 20], 'close')
      const mom20 = prev ? close / prev - 1 : null
      if (close > ma20 && mom20 != null && mom20 > 0) kept.push({ ...p, date })
    }
    return kept.length ? { picks: kept, style: '沪深300' } : null
  }
  if (st.source === 'voltarget') {
    const a = loadShadow(reg.sources.A, date)
    const b = loadShadow(reg.sources.B, date)
    if (!a?.top?.length || !b?.top?.length) return null
    const basis = a.basisDate || date
    const volOf = async (name) => {
      const sb = await styleBars(name)
      const i = findLe(sb, basis)
      if (i < 21) return null
      const rs = []
      for (let k = i - 19; k <= i; k += 1) {
        const c = px(sb[k], 'close'); const p0 = px(sb[k - 1], 'close')
        if (c && p0) rs.push(c / p0 - 1)
      }
      return rs.length ? Math.sqrt(rs.reduce((s0, r) => s0 + r * r, 0) / rs.length) : null
    }
    const va = await volOf('沪深300'); const vb = await volOf('创业板指')
    const useA = va != null && vb != null ? va <= vb : false
    return { picks: (useA ? a : b).top.map((x) => ({ ...x, date })), style: useA ? '沪深300' : '创业板指' }
  }
  if (st.source === 'blend50') {
    const a = loadShadow(reg.sources.A, date)
    const b = loadShadow(reg.sources.B, date)
    if (!a?.top?.length || !b?.top?.length) return null
    return { blend: true, a: a.top.map((t) => ({ ...t, date })), b: b.top.map((t) => ({ ...t, date })) }
  }
  if (st.source === 'dual-tilt') {
    const a = loadShadow(reg.sources.A, date)
    const b = loadShadow(reg.sources.B, date)
    if (!a?.top?.length || !b?.top?.length) return null
    const tilt = Number(a.regime?.tilt ?? b.regime?.tilt ?? 0)
    const useA = tilt >= st.tilt
    return { picks: (useA ? a : b).top.map((t) => ({ ...t, date })), style: useA ? '沪深300' : '创业板指' }
  }
  return null
}

const results = []
for (const st of reg.strategies) {
  const rule = reg.holdRules[st.hold]
  if (!rule) continue
  const trades = []
  const days = []
  for (const d of dates) {
    const got = await picksFor(st, d)
    if (!got) continue
    if (got.blend) {
      const ta = (await Promise.all(got.a.map((x) => oneTrade(x, '沪深300', rule)))).filter(Boolean)
      const tb = (await Promise.all(got.b.map((x) => oneTrade(x, '创业板指', rule)))).filter(Boolean)
      if (!ta.length || !tb.length) continue
      const r = 0.5 * mean(ta.map((x) => x.ret)) + 0.5 * mean(tb.map((x) => x.ret))
      const ba = mean(ta.map((x) => x.bret).filter((v) => v != null))
      const bb = mean(tb.map((x) => x.bret).filter((v) => v != null))
      const b = 0.5 * ba + 0.5 * bb
      days.push({ date: d, ret: r, excess: r - b })
      trades.push({ date: d, ret: r, bret: b, excess: r - b })
    } else {
      const ts = (await Promise.all(got.picks.map((x) => oneTrade(x, got.style, rule)))).filter(Boolean)
      if (!ts.length) continue
      days.push({ date: d, ret: mean(ts.map((x) => x.ret)), excess: mean(ts.map((x) => x.excess).filter((v) => v != null)) })
      trades.push(...ts)
    }
  }
  if (!trades.length) continue
  const rets = trades.map((t) => t.ret)
  const exs = trades.map((t) => t.excess).filter((v) => v != null)
  results.push({
    id: st.id, source: st.source, hold: st.hold, control: !!st.control,
    n: trades.length, days: days.length,
    mean: mean(rets), median: median(rets), excess: mean(exs),
    win: exs.length ? exs.filter((v) => v > 0).length / exs.length : null,
    ci: bootstrapCI(exs), cost30: mean(costAdjust(exs, 15)),
    dayMean: mean(days.map((d) => d.ret)), dayExcess: mean(days.map((d) => d.excess)),
  })
}
results.sort((a, b) => (b.excess ?? -9) - (a.excess ?? -9))
const lines = []
lines.push(`# 多策略前瞻排行榜（${FROM} ~ ${TO}）`)
lines.push('')
lines.push(`> 数据：\`/data/shadow/{A,B,dual}\` 每日快照；持有规则评估时逐票应用。线上 A/B/dual 不动。`)
lines.push(`> 日期数：${dates.length}；策略数：${results.length}；生成：${new Date().toISOString()}。`)
if (dates.length < 5) lines.push('')
if (dates.length < 5) lines.push('> ⚠️ 前瞻样本不足 5 天，当前排名**不可用**；12 月再跑。')
lines.push('')
lines.push('| # | 策略 | 来源 | 持有 | 笔数 | 均收益 | 均超额 | 胜率 | 95%CI(超额) | 成本0.3% | 日均收益 | 日均超额 |')
lines.push('|---:|---|---|---|---:|---:|---:|---:|---|---:|---:|---:|')
results.forEach((r, i) => {
  lines.push(`| ${i + 1} | ${r.id}${r.control ? ' *(control)*' : ''} | ${r.source} | ${r.hold} | ${r.n} | ${pct(r.mean)} | ${pct(r.excess)} | ${r.win == null ? '—' : (r.win * 100).toFixed(0) + '%'} | ${r.ci ? `[${pct(r.ci.lo)}, ${pct(r.ci.hi)}]` : '—'} | ${pct(r.cost30)} | ${pct(r.dayMean)} | ${pct(r.dayExcess)} |`)
})
lines.push('')
lines.push('## 口径/限制')
lines.push('')
lines.push('- 买入=生效日开盘；fixed/llm 卖出=第 N 个交易日开盘；trail 卖出=回撤触发日收盘；基准同窗口。')
lines.push('- 未计：涨跌停/停牌、整手、资金约束、分红；成本仅敏感性（单边 bps × 2）。')
lines.push('- `live-*` 是近似对照（用 `aiHoldDays`，未完全复刻 AI 提前终止/延长）。')
lines.push('- 一个月前瞻 + 23 个候选 → 存在多重检验；排名要结合 bootstrap CI、前视验证和 Deflated Sharpe（sidecar）。')
lines.push('- 不要用这段前瞻结果回头改策略再重评同一段；下一轮用新的一段。')
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, `${lines.join('\n')}\n`)
fs.mkdirSync(path.join(REPO, 'research/reports'), { recursive: true })
fs.writeFileSync(path.join(REPO, 'research/reports/leaderboard.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), from: FROM, to: TO, dates: dates.length, results }, null, 2)}\n`)
console.log(`wrote ${OUT} (${results.length} strategies, ${dates.length} dates)`)
for (const r of results.slice(0, 8)) console.log(`${r.id.padEnd(18)} n=${String(r.n).padStart(3)} mean=${pct(r.mean)} excess=${pct(r.excess)} win=${r.win == null ? '—' : (r.win * 100).toFixed(0) + '%'}`)
