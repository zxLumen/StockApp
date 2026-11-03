// 研究：逐票持有规则搜索（只读历史 A/B 归档 + 日K）。
// 比较固定持有、LLM 持有、波动率/ATR 缩放、移动止盈、MA20 破位、动量衰减。
// 用法：node scripts/research/hold-search.js --dir derived/recommend-ai-ab --from ... --to ...
import { DATA_DIR } from '../../lib/scope.js'
import { readJson } from '../../lib/store.js'
import { cachedKline } from '../../lib/kline-cache.js'

const argv = process.argv.slice(2)
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d }
const DIR = opt('--dir', 'derived/recommend-ai-ab')
const FROM = opt('--from', '0000-00-00')
const TO = opt('--to', '9999-99-99')
const MAXH = Number(opt('--max-hold', 60))
const cache = new Map()
const bars = async (sid) => { if (!cache.has(sid)) cache.set(sid, (await cachedKline(sid).catch(() => null))?.bars || []); return cache.get(sid) }
const closeAt = (bs, t) => bs.find((b) => b.time === t)?.close ?? null
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(2)}%`)
const idx = await bars('1.000300')
const files = (await import('node:fs')).readdirSync(`${DATA_DIR}/${DIR}`).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().filter((f) => f.slice(0, 10) >= FROM && f.slice(0, 10) <= TO)

const RULES = []
for (const n of [3, 5, 10, 20, 30]) RULES.push({ id: `fixed${n}`, fn: () => n })
RULES.push({ id: 'llm', fn: (t) => Number(t.ai?.holdDays ?? t.holdDays ?? 10) })
for (const tv of [0.05, 0.1, 0.15, 0.2]) RULES.push({ id: `vol${tv}`, fn: (t, vol) => (vol > 0 ? Math.max(3, Math.min(30, Math.round(tv / vol))) : 10) })
for (const ta of [0.1, 0.2, 0.3]) RULES.push({ id: `atr${ta}`, fn: (t, vol, atr) => (atr > 0 ? Math.max(3, Math.min(30, Math.round(ta / atr))) : 10) })
for (const tr of [5, 8, 10, 12, 15]) RULES.push({ id: `trail${tr}`, trail: tr / 100 })
RULES.push({ id: 'ma20', ma: true })
RULES.push({ id: 'mom', mom: true })

const out = Object.fromEntries(RULES.map((r) => [r.id, { r: [], e: [] }]))
for (const f of files) {
  const p = await readJson(`${DATA_DIR}/${DIR}/${f}`)
  const basis = p.basisDate
  const ib = closeAt(idx, basis)
  if (!ib) continue
  for (const t of p.top || []) {
    const bs = await bars(t.secid)
    const i = bs.findIndex((b) => b.time >= basis)
    if (i < 0) continue
    const entry = bs[i].close
    if (!entry) continue
    const win = bs.slice(i, i + MAXH + 1)
    if (win.length < 2) continue
    // 波动率/ATR（basis 之前）
    const pre = bs.slice(Math.max(0, i - 20), i)
    const rets = pre.slice(1).map((b, k) => b.close / pre[k].close - 1)
    const vol = rets.length ? Math.sqrt(rets.reduce((a, r) => a + r * r, 0) / rets.length) : null
    const atrBars = bs.slice(Math.max(0, i - 14), i)
    const atr = atrBars.length ? atrBars.reduce((a, b) => a + Math.abs(b.high - b.low) / b.close, 0) / atrBars.length : null
    // MA20 at each win day
    const ma20At = (k) => { const s = bs.slice(Math.max(0, i + k - 19), i + k + 1); return s.length >= 20 ? s.reduce((a, b) => a + b.close, 0) / s.length : null }
    for (const rule of RULES) {
      let exit = win.at(-1)
      if (rule.trail) {
        let peak = entry
        for (const b of win) { if (b.close > peak) peak = b.close; if (b.close / peak - 1 <= -rule.trail) { exit = b; break } }
      } else if (rule.ma) {
        for (let k = 3; k < win.length; k += 1) { const m = ma20At(k); if (m && win[k].close < m) { exit = win[k]; break } }
      } else if (rule.mom) {
        for (let k = 5; k < win.length; k += 1) { if (win[k].close / win[k - 5].close - 1 < 0) { exit = win[k]; break } }
      } else {
        const n = rule.fn(t, vol, atr)
        exit = win[Math.min(Math.max(1, n), win.length - 1)]
      }
      const r = exit.close / entry - 1
      const is = closeAt(idx, exit.time)
      out[rule.id].r.push(r)
      if (is) out[rule.id].e.push(r - (is / ib - 1))
    }
  }
}
const rows = Object.entries(out).map(([id, x]) => ({ id, n: x.r.length, mean: mean(x.r), excess: mean(x.e), win: x.e.length ? x.e.filter((v) => v > 0).length / x.e.length : null }))
rows.sort((a, b) => (b.excess ?? -9) - (a.excess ?? -9))
for (const r of rows) console.log(`${r.id.padEnd(10)} n=${String(r.n).padStart(4)} mean=${pct(r.mean)} excess=${pct(r.excess)} win=${r.win == null ? '—' : (r.win * 100).toFixed(0) + '%'}`)
