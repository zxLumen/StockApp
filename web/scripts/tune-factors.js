// 因子调参流水线：对同一批「每日特征」快速试多组权重，训练集=7月、验证集=8月。
//   node scripts/tune-factors.js
// 只做横截面选股（与 selectByFactors 一致：因子分降序取前 10）。行业分散在本地因东财
// f127 不可用而失效，这里同样忽略。所有数据只用 ≤D 的日K，无未来数据。
import { DATA_DIR } from '../lib/scope.js'
import { readJson } from '../lib/store.js'
import { cachedKline } from '../lib/kline-cache.js'
import { objectiveFilter, mapLimit } from '../lib/rank.js'
import { computeFactors, compositeScores, zscore } from '../lib/factors.js'

const TRAIN = { from: '2026-07-01', to: '2026-07-31', label: '训练(7月)' }
const VAL = { from: '2026-08-01', to: '2026-08-31', label: '验证(8月)' }
const INDEX = '1.000300'
const FINAL = 10
const HORIZONS = [3, 5, 10, 20]
// 全 0 基准：调参时把权重当「绝对」值，避免继承 DEFAULT_WEIGHTS。
const Z = {
  lowVol: 0,
  ampMean: 0,
  upShadow: 0,
  reversal: 0,
  midRev: 0,
  proximity: 0,
  liquidity: 0,
  turnStd: 0,
  revScaled: 0,
  lottery: 0,
  ivol: 0,
  info: 0, // 资讯/公告 LLM 情绪（-100~100，截面 z 后加权）
}

const BASE = { lowVol: 0.45, upShadow: 0.45, reversal: 0.1 }
const CONFIGS = [
  ['base(vol.45+sh.45+rev.1)', BASE],
  ['base+ivol.15', { ...BASE, ivol: 0.15 }],
  ['base+ivol.3', { ...BASE, ivol: 0.3 }],
  ['base+ivol.5', { ...BASE, ivol: 0.5 }],
  ['ivolOnly', { ivol: 1 }],
  ['vol.5+sh.5', { lowVol: 0.5, upShadow: 0.5 }],
  ['vol.4+sh.4+ivol.4', { lowVol: 0.4, upShadow: 0.4, ivol: 0.4 }],
  ['ivol.7+rev.3', { ivol: 0.7, reversal: 0.3 }],
]

const slice = (bars, D) => bars.filter((b) => b.time <= D)
const closeAt = (bars, t) => bars.find((b) => b.time === t)?.close ?? null
function barAfter(bars, t, n) {
  const i = bars.findIndex((b) => b.time === t)
  return i >= 0 && i + n < bars.length ? bars[i + n] : null
}

async function loadUniverse() {
  const cached = await readJson(`${DATA_DIR}/kline-cache/universe-stable.json`, null)
  if (Array.isArray(cached) && cached.length) return cached
  const { stablePool } = await import('../lib/rank.js')
  return (await stablePool()).map((x) => ({ secid: x.secid, code: x.code, name: x.name }))
}

function poolAt(universe, allBars, D) {
  const pool = []
  for (const s of universe) {
    const bars = allBars.get(s.secid)
    if (!bars) continue
    const at = [...bars].reverse().find((b) => b.time <= D)
    if (!at || at.close == null) continue
    pool.push({
      secid: s.secid,
      code: s.code,
      name: s.name,
      price: at.close,
      changePct: at.changePct ?? null,
      amount: (at.volume || 0) * at.close,
      turnover: null,
      mktcap: null,
      floatCap: null,
    })
  }
  pool.sort((a, b) => b.amount - a.amount)
  return pool
}

/** 训练/验证各天预计算一次：初筛后的候选 + 因子特征。 */
async function featuresByDay(universe, allBars, days, idxClose) {
  const out = new Map()
  for (const D of days) {
    const pool = poolAt(universe, allBars, D)
    const filtered = await objectiveFilter(pool, {
      target: 200,
      kline: (secid) => ({ bars: slice(allBars.get(secid) || [], D) }),
    })
    const feats = filtered
      .map((c) => ({ c, feat: computeFactors(slice(allBars.get(c.secid) || [], D), idxClose) }))
      .filter((x) => x.feat)
    out.set(D, feats)
  }
  return out
}

function runRange(days, featsByDay, allBars, idxBars, weights, sent, final = FINAL) {
  const rets = new Map(HORIZONS.map((n) => [n, []]))
  const excs = new Map(HORIZONS.map((n) => [n, []]))
  for (const D of days) {
    const items = featsByDay.get(D) || []
    if (!items.length) continue
    const scores = compositeScores(
      items.map((x) => x.feat),
      { ...Z, ...weights },
    )
    const infoW = weights.info || 0
    if (infoW && sent?.has(D)) {
      const day = sent.get(D)
      const z = zscore(items.map((x) => (day.get(x.c.code) ?? 0) / 100))
      for (let i = 0; i < scores.length; i += 1) scores[i] += infoW * z[i]
    }
    const ranked = items
      .map((x, i) => [x.c, scores[i]])
      .sort((a, b) => b[1] - a[1])
      .slice(0, final)
    const idxBase = closeAt(idxBars, D)
    for (const [c] of ranked) {
      const bars = allBars.get(c.secid)
      const base = closeAt(bars, D)
      if (!base) continue
      for (const n of HORIZONS) {
        const b = barAfter(bars, D, n)
        if (!b?.close) continue
        const r = (b.close / base - 1) * 100
        rets.get(n).push(r)
        const idxSell = closeAt(idxBars, b.time)
        if (idxBase && idxSell) excs.get(n).push(r - (idxSell / idxBase - 1) * 100)
      }
    }
  }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN)
  const win = (a) => (a.length ? a.filter((x) => x > 0).length / a.length : NaN)
  return { avg, win, rets, excs }
}

/** 按日切换权重（市场状态自适应）：isDown[D] 为真用 downW，否则 upW。 */
function runRegime(days, featsByDay, allBars, idxBars, upW, downW, isDown, sent, final = FINAL) {
  const rets = new Map(HORIZONS.map((n) => [n, []]))
  const excs = new Map(HORIZONS.map((n) => [n, []]))
  for (const D of days) {
    const items = featsByDay.get(D) || []
    if (!items.length) continue
    const w = { ...Z, ...(isDown.get(D) ? downW : upW) }
    const scores = compositeScores(
      items.map((x) => x.feat),
      w,
    )
    const infoW = (isDown.get(D) ? downW : upW).info || 0
    if (infoW && sent?.has(D)) {
      const day = sent.get(D)
      const z = zscore(items.map((x) => (day.get(x.c.code) ?? 0) / 100))
      for (let i = 0; i < scores.length; i += 1) scores[i] += infoW * z[i]
    }
    const ranked = items
      .map((x, i) => [x.c, scores[i]])
      .sort((a, b) => b[1] - a[1])
      .slice(0, final)
    const idxBase = closeAt(idxBars, D)
    for (const [c] of ranked) {
      const bars = allBars.get(c.secid)
      const base = closeAt(bars, D)
      if (!base) continue
      for (const n of HORIZONS) {
        const b = barAfter(bars, D, n)
        if (!b?.close) continue
        const r = (b.close / base - 1) * 100
        rets.get(n).push(r)
        const idxSell = closeAt(idxBars, b.time)
        if (idxBase && idxSell) excs.get(n).push(r - (idxSell / idxBase - 1) * 100)
      }
    }
  }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN)
  const win = (a) => (a.length ? a.filter((x) => x > 0).length / a.length : NaN)
  return { avg, win, rets, excs }
}

function loadAllKlines(universe) {
  return mapLimit(universe, 12, async (s) => {
    const k = await cachedKline(s.secid).catch(() => null)
    return [s.secid, k?.bars || []]
  })
}

/** 载入每日「个股情绪分」：day → Map<code, score -100..100>。缺则为空（不参与）。 */
async function loadSent(days) {
  const m = new Map()
  for (const d of days) {
    const j = await readJson(`${DATA_DIR}/info-sent/${d}.json`, null)
    if (j) m.set(d, new Map(Object.entries(j).map(([c, v]) => [c, Number(v?.score) || 0])))
  }
  return m
}

async function main() {
  console.log('[tune] 载入 universe + 日K…')
  const universe = await loadUniverse()
  const pairs = await loadAllKlines(universe)
  const allBars = new Map(pairs.filter(([, b]) => b.length))
  const idxBars = (await cachedKline(INDEX).catch(() => null))?.bars || []
  const union = [...new Set([...allBars.values()].flatMap((bars) => bars.map((b) => b.time)))].sort()
  const daysOf = (r) => union.filter((d) => d >= r.from && d <= r.to)
  const trainDays = daysOf(TRAIN)
  const valDays = daysOf(VAL)

  console.log(`[tune] 特征预计算：训练 ${trainDays.length} 天 / 验证 ${valDays.length} 天…`)
  const idxClose = new Map(idxBars.map((b) => [b.time, b.close]))
  const trainFeats = await featuresByDay(universe, allBars, trainDays, idxClose)
  const valFeats = await featuresByDay(universe, allBars, valDays, idxClose)
  const sent = await loadSent([...trainDays, ...valDays])
  console.log(`[tune] 情绪分覆盖 ${sent.size} 天`)

  const pct = (x) => (Number.isFinite(x) ? x.toFixed(2) : ' NA')
  console.log('\n配置 | [训练] T3超额 T5收益/超额 胜率 | [验证] T3超额 T5收益/超额 胜率 | T10超额 训/验')
  for (const [name, w] of CONFIGS) {
    const tr = runRange(trainDays, trainFeats, allBars, idxBars, w, sent)
    const va = runRange(valDays, valFeats, allBars, idxBars, w, sent)
    console.log(
      `${name.padEnd(34)} | ` +
        `${pct(tr.avg(tr.excs.get(3)))} ${pct(tr.avg(tr.rets.get(5)))}/${pct(tr.avg(tr.excs.get(5)))} ` +
        `${pct(tr.win(tr.rets.get(5)) * 100)}% | ` +
        `${pct(va.avg(va.excs.get(3)))} ${pct(va.avg(va.rets.get(5)))}/${pct(va.avg(va.excs.get(5)))} ` +
        `${pct(va.win(va.rets.get(5)) * 100)}% | ` +
        `${pct(tr.avg(tr.excs.get(10)))} / ${pct(va.avg(va.excs.get(10)))}`,
    )
  }

  // 网格搜索：低波/上影线/振幅/反转（特征已预计算，纯打分很快）
  console.log('\n网格搜索：按验证 T5 超额排序（找超额>1% 且胜率>60%）')
  const grid = []
  for (const lv of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
    for (const sh of [0, 0.2, 0.3, 0.4, 0.5, 0.6]) {
      for (const am of [0, 0.2, 0.4]) {
        for (const rv of [0, 0.1, 0.2]) {
          grid.push({ lowVol: lv, upShadow: sh, ampMean: am, reversal: rv })
        }
      }
    }
  }
  const scored = grid.map((w) => {
    const tr = runRange(trainDays, trainFeats, allBars, idxBars, w, sent)
    const va = runRange(valDays, valFeats, allBars, idxBars, w, sent)
    return { w, tr, va }
  })
  scored.sort((a, b) => b.va.avg(b.va.excs.get(5)) - a.va.avg(a.va.excs.get(5)))
  for (const { w, tr, va } of scored.slice(0, 12)) {
    const tag = `lv${w.lowVol} sh${w.upShadow} am${w.ampMean} rv${w.reversal}`
    console.log(
      `${tag.padEnd(34)} | 训 ${pct(tr.avg(tr.excs.get(5)))}/${pct(tr.win(tr.rets.get(5)) * 100)}% | ` +
        `验 ${pct(va.avg(va.excs.get(5)))}/${pct(va.win(va.rets.get(5)) * 100)}% | 验T10超额 ${pct(va.avg(va.excs.get(10)))}`,
    )
  }

  // 各周期收益/超额/胜率
  console.log('\n各周期（收益/超额/胜率）')
  for (const [cname, w] of [
    ['vol.3+sh.4 (grid best)', { lowVol: 0.3, upShadow: 0.4 }],
    ['vol.35+sh.45+am.2', { lowVol: 0.35, upShadow: 0.45, ampMean: 0.2 }],
    ['vol.4+sh.5', { lowVol: 0.4, upShadow: 0.5 }],
    ['vol.45+sh.45+rev.1', BASE],
    ['vol.5+sh.5', { lowVol: 0.5, upShadow: 0.5 }],
  ]) {
    const tr = runRange(trainDays, trainFeats, allBars, idxBars, w, sent)
    const va = runRange(valDays, valFeats, allBars, idxBars, w, sent)
    console.log(cname)
    for (const n of [3, 5, 10, 20]) {
      console.log(
        `  T+${n}  训 ${pct(tr.avg(tr.rets.get(n)))}/${pct(tr.avg(tr.excs.get(n)))}/${pct(tr.win(tr.rets.get(n)) * 100)}%` +
          `   验 ${pct(va.avg(va.rets.get(n)))}/${pct(va.avg(va.excs.get(n)))}/${pct(va.win(va.rets.get(n)) * 100)}%`,
      )
    }
  }

  // 不同推荐数（FINAL）
  console.log('\n不同推荐数 | [训练] T3超额/胜 T5超额/胜 | [验证] T3超额/胜 T5超额/胜')
  for (const [cname, w] of [
    ['vol.45+sh.45+rev.1', BASE],
    ['vol.5+sh.5', { lowVol: 0.5, upShadow: 0.5 }],
  ]) {
    for (const f of [5, 8, 10, 15, 20]) {
      const tr = runRange(trainDays, trainFeats, allBars, idxBars, w, sent, f)
      const va = runRange(valDays, valFeats, allBars, idxBars, w, sent, f)
      console.log(
        `${`${cname} N=${f}`.padEnd(26)} | ` +
          `${pct(tr.avg(tr.excs.get(3)))}/${pct(tr.win(tr.rets.get(3)) * 100)}% ` +
          `${pct(tr.avg(tr.excs.get(5)))}/${pct(tr.win(tr.rets.get(5)) * 100)}% | ` +
          `${pct(va.avg(va.excs.get(3)))}/${pct(va.win(va.rets.get(3)) * 100)}% ` +
          `${pct(va.avg(va.excs.get(5)))}/${pct(va.win(va.rets.get(5)) * 100)}%`,
      )
    }
  }

  // 市场状态自适应：沪深300 收盘 < MA20 视为下跌市（只用 ≤D 的指数日K）
  const isDown = new Map()
  for (let i = 19; i < idxBars.length; i += 1) {
    const ma = idxBars.slice(i - 19, i + 1).reduce((a, b) => a + b.close, 0) / 20
    isDown.set(idxBars[i].time, idxBars[i].close < ma)
  }
  const defW = { lowVol: 0.5, ampMean: 0.3, upShadow: 0.3, reversal: 0.15, proximity: 0.1 }
  const REG = [
    ['R: UP=def DOWN=+rev.4', defW, { lowVol: 0.4, ampMean: 0.2, upShadow: 0.2, reversal: 0.4, proximity: 0.1 }],
    ['R: UP=def DOWN=+rev.6', defW, { lowVol: 0.3, ampMean: 0.2, upShadow: 0.2, reversal: 0.6, proximity: 0.1 }],
    ['R: UP=def DOWN=revOnly', defW, { reversal: 1 }],
    ['R: UP=def DOWN=def+revScaled', defW, { ...defW, revScaled: 0.3 }],
  ]
  console.log('\n市场状态自适应（指数<MA20 用 DOWN 权重）')
  for (const [name, upW, downW] of REG) {
    const tr = runRegime(trainDays, trainFeats, allBars, idxBars, upW, downW, isDown, sent)
    const va = runRegime(valDays, valFeats, allBars, idxBars, upW, downW, isDown, sent)
    console.log(
      `${name.padEnd(34)} | ` +
        `${pct(tr.avg(tr.excs.get(3)))} ${pct(tr.avg(tr.rets.get(5)))}/${pct(tr.avg(tr.excs.get(5)))} ${pct(tr.win(tr.rets.get(5)) * 100)}% | ` +
        `${pct(va.avg(va.excs.get(3)))} ${pct(va.avg(va.rets.get(5)))}/${pct(va.avg(va.excs.get(5)))} ${pct(va.win(va.rets.get(5)) * 100)}% | ` +
        `${pct(tr.avg(tr.excs.get(10)))} / ${pct(va.avg(va.excs.get(10)))}`,
    )
  }
}

main().catch((e) => {
  console.error('[tune] 失败：', e)
  process.exit(1)
})
