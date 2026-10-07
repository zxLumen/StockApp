// A/B regime 组合评估：逐日按市场状态（regimeTilt）在 A、B 两个推荐目录间切换，
// 取该目录当天的 Top10，按每票自身持有周期（ai.holdDays）算绝对收益/相对沪深300超额/胜率。
//   node scripts/eval-ab-combo.js --a recommend-ai-ab --b recommend-factors-ab --from ... --to ... [--thr 0.5]
//   # 真实前瞻（每天双链路各归档一份，见 lib/recommend.js 的 runRecommendRegime）：
//   node scripts/eval-ab-combo.js --a recommend-ai-fwd --b recommend-factors-fwd
// 规则：tilt >= thr → 用 A（上涨市）；否则用 B（下跌/震荡市）。
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
const A = opt('--a', 'recommend-ai-ab')
const B = opt('--b', 'recommend-factors-ab')
const FROM = opt('--from', '0000-00-00')
const TO = opt('--to', '9999-99-99')
const THRS = String(opt('--thr', '0.3,0.4,0.5,0.6')).split(',').map(Number).filter(Number.isFinite)
const INDEX = '1.000300'
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

/** 读某目录某天的推荐 → 每日组合的 T+10 超额（基于该文件的 basisDate）。 */
async function dayExcess(dir, file, idxBars) {
  const d = await readJson(path.join(DATA_DIR, dir, file), null)
  if (!d?.top?.length || !d.basisDate) return null
  const basis = d.basisDate
  const idxBase = closeAt(idxBars, basis)
  if (!idxBase) return null
  const exs = []
  const rets = []
    for (const t of d.top) {
      const bars = await getBars(t.secid)
      const base = closeAt(bars, basis)
      // 逐票用各自的持有周期（A 链=模型给的 holdDays；B 链=factorHoldDays）；缺失回退 H。
      const hold = t.ai?.holdDays || H
      const sell = barAfter(bars, basis, hold)
      const idxSell = sell ? closeAt(idxBars, sell.time) : null
    if (base && sell?.close && idxSell) {
      const r = (sell.close / base - 1) * 100
      rets.push(r)
      exs.push(r - (idxSell / idxBase - 1) * 100)
    }
  }
  return exs.length ? { basis, exs, rets } : null
}

async function main() {
  const idxBars = await getBars(INDEX)
  // 以 A 目录的文件列表为准（A、B 日期集相同）
  const files = fs
    .readdirSync(path.join(DATA_DIR, A))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .filter((f) => {
      const d = f.slice(0, 10)
      return d >= FROM && d <= TO
    })

  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN)
  const modes = [{ label: 'A only' }, { label: 'B only' }, ...THRS.map((t) => ({ label: `thr${t}`, thr: t }))]
  const agg = modes.map((m) => ({ m, ex: [], rets: [], win: [], byMonth: new Map() }))

  for (const f of files) {
    // 用文件的 basisDate 算 tilt（A、B 同日 basisDate 相同）
    const aData = await readJson(path.join(DATA_DIR, A, f), null)
    const basis = aData?.basisDate
    if (!basis) continue
    // 前瞻归档里记了当天的 tilt，优先用它（regimeTilt 实现日后若变动，历史 tilt 不会跟着漂）；
    // 老回测目录没有 regime，回退到用当前实现重算。
    const tilt = aData?.regime?.tilt ?? regimeTilt(idxBars.filter((b) => b.time <= basis))
    const exA = await dayExcess(A, f, idxBars)
    const exB = await dayExcess(B, f, idxBars)
    if (!exA || !exB) continue
    const month = basis.slice(0, 7)
    for (const a of agg) {
      const useA = a.m.label === 'A only' ? true : a.m.label === 'B only' ? false : tilt >= a.m.thr
      const exs = useA ? exA.exs : exB.exs
      const rs = useA ? exA.rets : exB.rets
      for (const e of exs) a.ex.push(e)
      for (const r of rs) a.rets.push(r)
      a.win.push(avg(exs) > 0 ? 1 : 0)
      if (!a.byMonth.has(month)) a.byMonth.set(month, [])
      for (const e of exs) a.byMonth.get(month).push(e)
    }
  }

  console.log(`\n=== A/B regime 组合 ${FROM} ~ ${TO}（${files.length} 天，逐票持有周期） ===`)
  console.log('模式 | 均绝对(主) | 均超额(辅) | 日均胜率 | 最差月 | 正超额月 | 逐月均超额')
  for (const a of agg) {
    const byM = [...a.byMonth.entries()].sort()
    const monthly = byM.map(([m, xs]) => avg(xs))
    const worst = Math.min(...monthly)
    const posM = monthly.filter((x) => x > 0).length
    console.log(
      `${a.m.label.padEnd(8)} | ${avg(a.rets).toFixed(2).padStart(6)} | ${avg(a.ex).toFixed(2).padStart(6)} | ${(avg(a.win) * 100).toFixed(0).padStart(3)}% | ` +
        `${worst.toFixed(2).padStart(6)} | ${posM}/${byM.length} | ${byM.map(([m, xs]) => `${m.slice(5)} ${avg(xs).toFixed(2)}`).join('  ')}`,
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
