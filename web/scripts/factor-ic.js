// 因子 IC 诊断（研究用，不落盘）：在指定窗口上，算每个**原始因子**与「未来 T+N 相对
// 沪深300超额」的**逐日截面相关**，再汇总均值 / IR / 命中率。用来判断某个因子在窗口里
// 到底有没有预测力、方向如何 —— 调权重前先看这个，避免盲目试权重。
//
//   node scripts/factor-ic.js --from 2026-02-01 --to 2026-09-30 [--h 10] [--target 200]
//
// 无未来数据：因子只用 ≤D 的日K/财务/公告；收益用 D 之后第 N 个交易日。
import { DATA_DIR } from '../lib/scope.js'
import { readJson } from '../lib/store.js'
import { cachedKline } from '../lib/kline-cache.js'
import { objectiveFilter, mapLimit } from '../lib/rank.js'
import { computeFactors } from '../lib/factors.js'
import { financeFactors } from '../lib/finance.js'
import { eventScores } from '../lib/ann-factor.js'
import { buildNameIndex, buildDailyInfo, scoreNewsTitle } from '../lib/news-factor.js'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const opt = (n, d) => {
  const i = argv.indexOf(n)
  const v = i >= 0 ? Number(argv[i + 1]) : NaN
  return Number.isFinite(v) ? v : d
}
const FROM = has('--from') ? argv[argv.indexOf('--from') + 1] : '2026-02-01'
const TO = has('--to') ? argv[argv.indexOf('--to') + 1] : '2026-09-30'
const H = opt('--h', 10)
const TARGET = opt('--target', 200)
const INDEX = '1.000300'
const EVW = opt('--event-window', 5)

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

/** 皮尔逊相关（秩相关由调用方先转秩，故这里只实现皮尔逊）。 */
function pearson(xs, ys) {
  const pairs = []
  for (let i = 0; i < xs.length; i += 1) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) pairs.push([xs[i], ys[i]])
  }
  const n = pairs.length
  if (n < 5) return NaN
  const mx = pairs.reduce((s, p) => s + p[0], 0) / n
  const my = pairs.reduce((s, p) => s + p[1], 0) / n
  let cov = 0
  let vx = 0
  let vy = 0
  for (const [x, y] of pairs) {
    cov += (x - mx) * (y - my)
    vx += (x - mx) ** 2
    vy += (y - my) ** 2
  }
  return vx && vy ? cov / Math.sqrt(vx * vy) : NaN
}

/** 秩（平均秩，处理并列）。 */
function rank(a) {
  const idx = a.map((v, i) => [v, i]).filter(([v]) => Number.isFinite(v))
  idx.sort((p, q) => p[0] - q[0])
  const r = new Array(a.length).fill(NaN)
  let i = 0
  while (i < idx.length) {
    let j = i
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j += 1
    const avg = (i + j) / 2
    for (let k = i; k <= j; k += 1) r[idx[k][1]] = avg
    i = j + 1
  }
  return r
}

const FACTORS = [
  'vol',
  'chg5',
  'chg20',
  'dev',
  'avgAmt',
  'turnStd',
  'maxRet5',
  'ampMean',
  'upShadowStd',
  'ivol',
  'relStr',
  'mom60',
  'relMom20',
  'beta',
  'volSurge',
  'nearHigh',
  'roeAnnual',
  'revYoy',
  'profitYoy',
  'grossMargin',
  'bps',
  'event',
  'newsSent',
]

async function main() {
  console.log(`[ic] 加载 universe + 日K…`)
  const universe = await loadUniverse()
  const pairs = await mapLimit(universe, 12, async (s) => {
    const k = await cachedKline(s.secid).catch(() => null)
    return [s.secid, k?.bars || []]
  })
  const allBars = new Map(pairs.filter(([, b]) => b.length))
  const idxBars = (await cachedKline(INDEX).catch(() => null))?.bars || []
  const idxClose = new Map(idxBars.map((b) => [b.time, b.close]))
  const nameIndex = buildNameIndex(universe)
  const union = [...new Set([...allBars.values()].flatMap((bars) => bars.map((b) => b.time)))].sort()
  const days = union.filter((d) => d >= FROM && d <= TO)
  console.log(`[ic] 窗口 ${FROM} ~ ${TO}，${days.length} 个交易日，未来 T+${H}，初筛 ${TARGET}`)

  const icByDay = new Map(FACTORS.map((f) => [f, []]))
  const dayIcByDay = new Map(FACTORS.map((f) => [f, []]))
  for (const D of days) {
    const pool = poolAt(universe, allBars, D)
    const filtered = await objectiveFilter(pool, {
      target: TARGET,
      kline: (secid) => ({ bars: slice(allBars.get(secid) || [], D) }),
    })
    const evtMap = await eventScores(DATA_DIR, D, { windowDays: EVW }).catch(() => null)
    // 新闻关键词情绪：读当日 news-archive（≤D），按股票名匹配。
    const info = await buildDailyInfo(DATA_DIR, D, nameIndex).catch(() => new Map())
    const idxBase = closeAt(idxBars, D)
    if (!idxBase) continue
    const feats = []
    const fwd = []
    for (const c of filtered) {
      const bars = allBars.get(c.secid) || []
      const fin = await financeFactors(c.secid, D, { dataDir: DATA_DIR }).catch(() => null)
      const feat = computeFactors(slice(bars, D), idxClose, fin)
      if (!feat) continue
      const ev = evtMap?.get(c.code)
      if (ev != null) feat.event = ev
      const titles = info.get(c.code)?.news || []
      feat.newsSent = titles.length ? titles.reduce((a, t) => a + scoreNewsTitle(t), 0) : null
      const sell = barAfter(bars, D, H)
      if (!sell?.close) continue
      const base = closeAt(bars, D)
      const idxSell = closeAt(idxBars, sell.time)
      if (!base || !idxSell) continue
      feats.push(feat)
      fwd.push((sell.close / base - 1) * 100 - (idxSell / idxBase - 1) * 100)
    }
    if (feats.length < 10) continue
    for (const f of FACTORS) {
      const raw = feats.map((x) => {
        if (f === 'avgAmt') return x.avgAmt ? Math.log(x.avgAmt) : NaN
        return Number.isFinite(x[f]) ? x[f] : NaN
      })
      const ic = pearson(rank(raw), rank(fwd)) // Spearman = 对秩求 Pearson
      if (Number.isFinite(ic)) {
        icByDay.get(f).push(ic)
        dayIcByDay.get(f).push([D, ic])
      }
    }
  }

  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN)
  const sd = (a) => {
    if (a.length < 2) return NaN
    const m = avg(a)
    return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length)
  }

  // 逐月 IC：看因子的预测方向是否随月份/市场风格切换（用于 regime 设想）。
  if (process.argv.includes('--by-month')) {
    const months = [...new Set(days.map((d) => d.slice(0, 7)))].sort()
    const keys = ['chg20', 'mom60', 'relStr', 'beta', 'upShadowStd', 'roeAnnual', 'revYoy', 'profitYoy', 'grossMargin', 'bps', 'event']
    console.log(`\n逐月平均IC（T+${H}）：`)
    console.log(`  ${'月份'.padEnd(9)}${keys.map((k) => k.slice(0, 9).padStart(10)).join('')}`)
    for (const m of months) {
      const cells = keys.map((k) => {
        const a = dayIcByDay.get(k).filter(([d]) => d.slice(0, 7) === m).map(([, v]) => v)
        const v = avg(a)
        return (Number.isFinite(v) ? (v > 0 ? '+' : '') + v.toFixed(3) : '  NA').padStart(10)
      })
      console.log(`  ${m.padEnd(9)}${cells.join('')}`)
    }
  }
  const rows = FACTORS.map((f) => {
    const a = icByDay.get(f)
    const m = avg(a)
    const s = sd(a)
    return { f, n: a.length, ic: m, ir: s ? m / s : NaN, hit: a.length ? a.filter((x) => x > 0).length / a.length : NaN }
  }).sort((x, y) => Math.abs(y.ic) - Math.abs(x.ic))
  console.log(`\n因子 | 天数 | 平均IC(Spearman) | IR=IC/σ | 正IC占比`)
  for (const r of rows) {
    const n3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : ' NA ')
    console.log(`  ${r.f.padEnd(12)} ${String(r.n).padStart(3)} ${n3(r.ic).padStart(8)} ${n3(r.ir).padStart(8)} ${n3(r.hit).padStart(7)}`)
  }
  console.log('\n说明：IC>0 表示该因子值越大、未来超额越高（因子已按需取负/取对数）。')
}

main().catch((e) => {
  console.error('[ic] 失败：', e)
  process.exit(1)
})
