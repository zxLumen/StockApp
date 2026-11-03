// 研究探针：按「决策日沪深300 vs MA20」分组，看 A/B 的持有期收益是否依赖趋势。
// 只读历史 A/B 归档 + 日K；不改生产。
import { DATA_DIR } from '../../lib/scope.js'
import { readJson } from '../../lib/store.js'
import { cachedKline } from '../../lib/kline-cache.js'

const argv = process.argv.slice(2)
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d }
const A = opt('--a', 'derived/recommend-ai-ab')
const B = opt('--b', 'derived/recommend-factors-ab')
const FROM = opt('--from', '0000-00-00')
const TO = opt('--to', '9999-99-99')
const HOLD = Number(opt('--hold', 20))
const cache = new Map()
const bars = async (sid) => { if (!cache.has(sid)) cache.set(sid, (await cachedKline(sid).catch(() => null))?.bars || []); return cache.get(sid) }
const closeAt = (bs, t) => bs.find((b) => b.time === t)?.close ?? null
const barAfter = (bs, t, n) => { const i = bs.findIndex((b) => b.time === t); return i >= 0 && i + n < bs.length ? bs[i + n] : null }
const ma20 = (bs, t) => { const i = bs.findIndex((b) => b.time >= t); if (i < 20) return null; return bs.slice(i - 20, i).reduce((a, b) => a + b.close, 0) / 20 }
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(2)}%`)

const idx = await bars('1.000300')
const files = (await import('node:fs')).readdirSync(`${DATA_DIR}/${A}`).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().filter((f) => f.slice(0, 10) >= FROM && f.slice(0, 10) <= TO)
const groups = { A: { on: [], off: [] }, B: { on: [], off: [] }, DUAL: { on: [], off: [] } }
for (const f of files) {
  const a = await readJson(`${DATA_DIR}/${A}/${f}`)
  const b = await readJson(`${DATA_DIR}/${B}/${f}`)
  const basis = a.basisDate || b.basisDate
  const m = ma20(idx, basis)
  const c = closeAt(idx, basis)
  if (!m || !c) continue
  const riskOn = c >= m
  const one = async (p, hold, defaultHold) => {
    const rets = [], bens = []
    for (const t of p.top || []) {
      const bs = await bars(t.secid)
      const base = closeAt(bs, basis)
      const h = hold === 'ai' ? Number(t.ai?.holdDays ?? defaultHold) : hold
      const sell = barAfter(bs, basis, h)
      if (!base || !sell?.close) continue
      rets.push(sell.close / base - 1)
      const ib = closeAt(idx, basis), is = closeAt(idx, sell.time)
      if (ib && is) bens.push(is / ib - 1)
    }
    return rets.length ? { r: mean(rets), e: mean(rets) - mean(bens), n: rets.length } : null
  }
  const ra = await one(a, 'ai', 15)
  const rb = await one(b, HOLD, HOLD)
  const key = riskOn ? 'on' : 'off'
  if (ra) groups.A[key].push(ra)
  if (rb) groups.B[key].push(rb)
  if (ra && rb) groups.DUAL[key].push(riskOn ? rb : ra)
}
for (const [name, g] of Object.entries(groups)) {
  for (const k of ['on', 'off']) {
    const xs = g[k]
    console.log(`${name} ${k === 'on' ? 'riskOn ' : 'riskOff'} n=${xs.length} mean=${pct(mean(xs.map((x) => x.r)))} excess=${pct(mean(xs.map((x) => x.e)))} win=${xs.length ? ((xs.filter((x) => x.e > 0).length / xs.length) * 100).toFixed(0) : '—'}%`)
  }
}
