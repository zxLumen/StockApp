// 评估「因子 + LLM 分」混合选股：逐日对 llm-rank/<day>.json 里的候选按
//   score = z(因子分) + w·z(LLM分)  排序取 Top10，算 T+10 相对沪深300超额/胜率。
//   node scripts/eval-llm-rank.js --from 2026-07-01 --to 2026-08-31 [--w 0,0.5,1,2,3]
import fs from 'node:fs'
import path from 'node:path'

import { DATA_DIR } from '../lib/scope.js'
import { readJson } from '../lib/store.js'
import { cachedKline } from '../lib/kline-cache.js'
import { regimeTilt } from '../lib/factors.js'

const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf(n)
  return i >= 0 ? argv[i + 1] : d
}
const FROM = opt('--from', '0000-00-00')
const TO = opt('--to', '9999-99-99')
const WS = String(opt('--w', '0,0.5,1,2,3')).split(',').map(Number).filter(Number.isFinite)
// regime 门控 w：`--regime-w "whi,wlo"`（tilt>=0.5 用 whi，否则 wlo）。给了它则忽略 --w。
const RW = String(opt('--regime-w', ''))
  .split(',')
  .map(Number)
  .filter(Number.isFinite)
const DIR = opt('--dir', 'llm-rank')
const INDEX = '1.000300'
const FINAL = 10
const H = 10

const cache = new Map()
async function getBars(secid) {
  if (!cache.has(secid)) {
    const k = await cachedKline(secid).catch(() => null)
    cache.set(secid, k?.bars || [])
  }
  return cache.get(secid)
}
const closeAt = (bars, t) => bars.find((b) => b.time === t)?.close ?? null
function barAfter(bars, t, n) {
  const i = bars.findIndex((b) => b.time === t)
  return i >= 0 && i + n < bars.length ? bars[i + n] : null
}
function zscore(arr) {
  const vals = arr.filter((v) => v != null && Number.isFinite(v))
  if (vals.length < 2) return arr.map(() => 0)
  const m = vals.reduce((a, b) => a + b, 0) / vals.length
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length) || 1
  return arr.map((v) => (v == null || !Number.isFinite(v) ? 0 : (v - m) / sd))
}

async function main() {
  const universe = await readJson(`${DATA_DIR}/kline-cache/universe-stable.json`, [])
  const secidOf = new Map(universe.map((s) => [String(s.code), s.secid]))
  const idxBars = await getBars(INDEX)

  const dir = path.join(DATA_DIR, DIR)
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .filter((f) => {
      const d = f.slice(0, 10)
      return d >= FROM && d <= TO
    })

  // 评估模式：固定 w 列表 + （可选）regime 门控 w。
  const modes = WS.map((w) => ({ label: `w=${w}`, fn: (zf, zl) => zf + w * zl }))
  if (RW.length === 2)
    modes.push({ label: `regime hi${RW[0]}/lo${RW[1]}`, fn: (zf, zl, tilt) => zf + (tilt >= 0.5 ? RW[0] : RW[1]) * zl })
  const agg = modes.map((m) => ({ m, ex: [], win: [], byMonth: new Map() }))

  let daysUsed = 0
  for (const f of files) {
    const D = f.slice(0, 10)
    const data = await readJson(path.join(dir, f), null)
    if (!data) continue
    const idxBase = closeAt(idxBars, D)
    if (!idxBase) continue
    const codes = Object.keys(data)
    const zf = zscore(codes.map((c) => Number(data[c]?.factorScore)))
    const zl = zscore(codes.map((c) => (data[c]?.buyScore == null ? null : Number(data[c].buyScore))))
    const tilt = regimeTilt(idxBars.filter((b) => b.time <= D))
    const fwd = {}
    for (const c of codes) {
      const secid = secidOf.get(c)
      if (!secid) continue
      const bars = await getBars(secid)
      const base = closeAt(bars, D)
      const sell = barAfter(bars, D, H)
      const idxSell = sell ? closeAt(idxBars, sell.time) : null
      if (base && sell?.close && idxSell) fwd[c] = (sell.close / base - 1) * 100 - (idxSell / idxBase - 1) * 100
    }
    const month = D.slice(0, 7)
    for (const a of agg) {
      const ranked = codes
        .map((c, i) => [c, a.m.fn(zf[i], zl[i], tilt)])
        .filter(([c]) => fwd[c] != null)
        .sort((x, y) => y[1] - x[1])
        .slice(0, FINAL)
      if (!ranked.length) continue
      const exs = ranked.map(([c]) => fwd[c])
      for (const e of exs) a.ex.push(e)
      a.win.push(exs.reduce((x, y) => x + y, 0) / exs.length > 0 ? 1 : 0)
      if (!a.byMonth.has(month)) a.byMonth.set(month, [])
      for (const e of exs) a.byMonth.get(month).push(e)
    }
    daysUsed += 1
  }

  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN)
  console.log(`\n=== LLM 混合评估 dir=${DIR} ${FROM} ~ ${TO}（${daysUsed} 天）T+${H} 超额 ===`)
  console.log('模式 | 均超额 | 日均胜率(超额>0) | 逐月均超额')
  for (const a of agg) {
    const byM = [...a.byMonth.entries()].sort().map(([m, xs]) => `${m.slice(5)} ${avg(xs).toFixed(2)}`).join('  ')
    console.log(
      `${a.m.label.padEnd(18)} | ${avg(a.ex).toFixed(2).padStart(6)} | ${(avg(a.win) * 100).toFixed(0).padStart(3)}% | ${byM}`,
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
