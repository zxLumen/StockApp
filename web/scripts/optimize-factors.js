// 稳健因子优化：逐月评估，优先「最差月份也不差」的配置。
//   node scripts/optimize-factors.js         # 按最差月排序，看 8 个月
//   node scripts/optimize-factors.js --cv    # 留一月交叉验证（判断「调参」本身有没有正价值）
//
// 无未来数据：价量特征只用截至 D 的日K；财务只用 `NOTICE_DATE <= D` 的报告期（lib/finance.js）。
//
// ⚠️ 默认窗口从 2026-07/08/09 扩到 **2026-02~09**。原窗口只有三个月，而且那次搜索把同一三个月
// 既当训练集又当报告集 —— 报出来的「7 月 +2.9%、8 月 +4.4%、9 月 +2.8%」是训练集内成绩。
// 复核后训练-测试相关系数 -0.833、训练集第一名在验证集排 #571/728。窗口越宽，越能看出一个配置
// 是不是只在某几个月成立。
import { DATA_DIR } from '../lib/scope.js'
import { readJson } from '../lib/store.js'
import { cachedKline } from '../lib/kline-cache.js'
import { objectiveFilter, mapLimit } from '../lib/rank.js'
import { computeFactors, compositeScores, DEFAULT_WEIGHTS, regimeTilt } from '../lib/factors.js'
import { financeFactors } from '../lib/finance.js'
import { eventScores } from '../lib/ann-factor.js'

const CV = process.argv.includes('--cv')
// 公告事件回看窗口天数：`--event-window=10`（默认 5）。用于做窗口稳健性检查。
const EVW = Number((process.argv.find((a) => a.startsWith('--event-window=')) || '').split('=')[1]) || 5
// 单配置快速评估：`--weights '{"midRev":0.3,"q":0.5}'` 跳过网格、只评这个配置（避免网格过拟合）。
const WI = process.argv.indexOf('--weights')
const FIXED_W = WI >= 0 ? JSON.parse(process.argv[WI + 1]) : null
// `--narrow`：只搜 midRev/upShadow/turnStd 的小网格，看跨月稳健点。
const NARROW = process.argv.includes('--narrow')
const RANGES = [
  { key: 'Feb', from: '2026-02-01', to: '2026-02-28' },
  { key: 'Mar', from: '2026-03-01', to: '2026-03-31' },
  { key: 'Apr', from: '2026-04-01', to: '2026-04-30' },
  { key: 'May', from: '2026-05-01', to: '2026-05-31' },
  { key: 'Jun', from: '2026-06-01', to: '2026-06-30' },
  { key: 'Jul', from: '2026-07-01', to: '2026-07-31' },
  { key: 'Aug', from: '2026-08-01', to: '2026-08-31' },
  { key: 'Sep', from: '2026-09-01', to: '2026-09-30' },
]
// 报告「训练→验证」用：7-9 月调参、3-6 月检验。
const TRAIN_KEYS = ['Jul', 'Aug', 'Sep']
const HOLD_KEYS = ['Mar', 'Apr', 'May', 'Jun']
const INDEX = '1.000300'
const FINAL = Number(process.env.RECOMMEND_FINAL) || 10
const HORIZONS = [5, 10, 20]
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
  q: 0,
  ep: 0,
  event: 0,
}

/** 某个结果在若干月上的 T+`h` 超额均值。 */
function avgOf(r, keys, h) {
  const xs = keys.map((k) => r.per[k]?.ex[h]).filter(Number.isFinite)
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN
}

/** 皮尔逊相关系数。训练-验证相关性越接近 0 越好；**负值说明「按训练集选优」是反向的**。 */
function pearson(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
  const n = pairs.length
  if (n < 2) return NaN
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

async function featuresByDay(universe, allBars, days, idxClose, idxBars) {
  const out = new Map()
  // regime 自适应偏离上限：跌市收紧（15%）、涨市放宽（40%），让上涨市能纳入强势领涨股。
  const DEV_LO = Number(process.env.RECOMMEND_DEV_LO) || 15
  const DEV_HI = Number(process.env.RECOMMEND_DEV_HI) || 40
  for (const D of days) {
    const pool = poolAt(universe, allBars, D)
    const tilt = regimeTilt((idxBars || []).filter((b) => b.time <= D))
    const maxDeviation = DEV_LO + tilt * (DEV_HI - DEV_LO)
    const filtered = await objectiveFilter(pool, {
      target: 200,
      kline: (secid) => ({ bars: slice(allBars.get(secid) || [], D) }),
      maxDeviation,
    })
    // 公告事件净分（≤ D，回看 5 天）：仅读 ann-archive，无未来数据。
    const evtMap = await eventScores(DATA_DIR, D, { windowDays: EVW }).catch(() => null)
    const rows = []
    for (const c of filtered) {
      const fin = await financeFactors(c.secid, D, { dataDir: DATA_DIR }).catch(() => null)
      const feat = computeFactors(slice(allBars.get(c.secid) || [], D), idxClose, fin)
      if (!feat) continue
      const ev = evtMap?.get(c.code)
      if (ev != null) feat.event = ev
      rows.push({ c, feat })
    }
    out.set(D, rows)
  }
  return out
}

function metrics(days, featsByDay, allBars, idxBars, weights) {
  const rets = new Map(HORIZONS.map((n) => [n, []]))
  const excs = new Map(HORIZONS.map((n) => [n, []]))
  // regime 倾斜：weights.tiltMode 为真时，按「≤D 的指数序列」逐日算 regimeTilt；
  // 否则用固定 weights.tilt（默认 0）。这样固定权重与自适应在同一框架下可对比。
  for (const D of days) {
    const items = featsByDay.get(D) || []
    if (!items.length) continue
    // tiltGain：把 regimeTilt 的输出按系数放大/缩小后再夹到 [0,1]（训练集标定"倾斜强度"）。
    const rawTilt = weights.tiltMode
      ? regimeTilt(idxBars.filter((b) => b.time <= D))
      : Number.isFinite(weights.tilt)
        ? weights.tilt
        : 0
    const tilt = weights.tiltGain ? Math.max(0, Math.min(1, rawTilt * weights.tiltGain)) : rawTilt
    const scores = compositeScores(items.map((x) => x.feat), { ...Z, ...weights, tilt })
    const ranked = items
      .map((x, i) => [x.c, scores[i]])
      .sort((a, b) => b[1] - a[1])
      .slice(0, FINAL)
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

async function main() {
  console.log('[opt] 载入 universe + 日K…')
  const universe = await loadUniverse()
  const pairs = await mapLimit(universe, 12, async (s) => {
    const k = await cachedKline(s.secid).catch(() => null)
    return [s.secid, k?.bars || []]
  })
  const allBars = new Map(pairs.filter(([, b]) => b.length))
  const idxBars = (await cachedKline(INDEX).catch(() => null))?.bars || []
  const idxClose = new Map(idxBars.map((b) => [b.time, b.close]))
  const union = [...new Set([...allBars.values()].flatMap((bars) => bars.map((b) => b.time)))].sort()

  const months = {}
  for (const r of RANGES) {
    const days = union.filter((d) => d >= r.from && d <= r.to)
    console.log(`[opt] 预计算 ${r.key}：${days.length} 天…`)
    months[r.key] = { days, feats: await featuresByDay(universe, allBars, days, idxClose, idxBars) }
  }

  // 网格：低波/上影线/振幅/反转（反转允许负向，即偏好近期涨）+ 年化ROE / 价值。
  // 步长刻意取粗（0.1~0.2）：网格越密越容易在训练集上过拟合，实测 11615 个配置的
  // 训练-测试相关系数 -0.783，比粗网格更糟。
  const grid = []
  if (NARROW) {
    // 窄网格：只动 IC 最强的三项（midRev）与最可疑的两项（upShadow / turnStd），
    // reversal/q/event 固定在生产值。用于看是否存在跨月稳健点。
    for (const sh of [0, 0.2, 0.4])
      for (const mr of [0.1, 0.2, 0.3, 0.35, 0.4])
        for (const ts of [0, 0.3, 0.5]) grid.push({ reversal: 0.2, upShadow: sh, midRev: mr, q: 0.3, event: 0.3, turnStd: ts, tiltMode: true })
  } else {
    for (const lv of [0, 0.2, 0.4]) {
      for (const sh of [0, 0.2, 0.4]) {
        for (const rv of [-0.2, 0, 0.2, 0.4]) {
          for (const mr of [0, 0.2, 0.35, 0.4]) {
            for (const q of [0, 0.3, 0.5]) {
              for (const ep of [0, 0.3]) {
                // event：公告事件净分权重（lib/ann-factor.js），0=不启用。
                for (const ev of [0, 0.3, 0.6]) {
                  if (lv + sh + Math.abs(rv) + mr + q + ep + ev === 0) continue
                  grid.push({ lowVol: lv, upShadow: sh, reversal: rv, midRev: mr, q, ep, event: ev, tiltMode: true })
                }
              }
            }
          }
        }
      }
    }
  }
  console.log(`[opt] 评估 ${grid.length} 个配置 × ${RANGES.length} 月 × ${HORIZONS.length} 周期…`)

  const n3 = (x) => (Number.isFinite(x) ? x.toFixed(2) : ' NA')
  const tagOf = (w) =>
    `rv${w.reversal} mr${w.midRev || 0} sh${w.upShadow || 0} lv${w.lowVol || 0} q${w.q || 0} ep${w.ep || 0} ev${w.event || 0} ts${w.turnStd || 0} lt${w.lottery || 0}`
  if (FIXED_W) {
    for (const cfgw of Array.isArray(FIXED_W) ? FIXED_W : [FIXED_W]) {
      const w = { ...Z, ...cfgw }
      const per = {}
      for (const r of RANGES) {
        const m = metrics(months[r.key].days, months[r.key].feats, allBars, idxBars, w)
        per[r.key] = {
          ex: Object.fromEntries(HORIZONS.map((n) => [n, m.avg(m.excs.get(n))])),
          win: Object.fromEntries(HORIZONS.map((n) => [n, m.win(m.rets.get(n)) * 100])),
        }
      }
      const ex10 = RANGES.map((r) => per[r.key].ex[10])
      console.log(`\n[--weights] ${tagOf(w)}`)
      console.log(`  各月 T+10 超额: ${RANGES.map((r) => `${r.key} ${n3(per[r.key].ex[10])}`).join('  ')}`)
      console.log(
        `  全月均 ${n3(ex10.reduce((a, b) => a + b, 0) / ex10.length)} / 训练均 ${n3(avgOf({ per }, TRAIN_KEYS, 10))} / ` +
          `验证均 ${n3(avgOf({ per }, HOLD_KEYS, 10))} / 最差月 ${n3(Math.min(...ex10))}`,
      )
    }
    return
  }
  // `--tiltScan`：**训练集标定** regime 倾斜强度 tiltGain，**验证集判定**。
  // 只搜一个参数（tiltGain），符合「训练调参、验证定最终」，过拟合面最小。
  if (process.argv.includes('--tiltScan')) {
    console.log('\n=== tiltGain 扫描：训练集(Jul/Aug/Sep)选优，验证集(Mar/Apr/May/Jun)判定 ===')
    const rows = []
    for (const g of [0, 0.5, 0.75, 1, 1.25, 1.5, 2]) {
      const w = { ...Z, ...DEFAULT_WEIGHTS, tiltMode: true, tiltGain: g }
      const per = {}
      for (const r of RANGES) per[r.key] = metrics(months[r.key].days, months[r.key].feats, allBars, idxBars, w)
      const ex = (k) => per[k].avg(per[k].excs.get(10))
      const tr = TRAIN_KEYS.map(ex).filter(Number.isFinite)
      const ho = HOLD_KEYS.map(ex).filter(Number.isFinite)
      const av = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN)
      const worst = Math.min(...RANGES.map((r) => ex(r.key)).filter(Number.isFinite))
      rows.push({ g, tr: av(tr), ho: av(ho), worst, all: av(RANGES.map((r) => ex(r.key)).filter(Number.isFinite)) })
    }
    for (const r of rows)
      console.log(
        `  gain=${String(r.g).padEnd(5)} 训练均 ${n3(r.tr)} / 验证均 ${n3(r.ho)} / 全月均 ${n3(r.all)} / 最差月 ${n3(r.worst)}`,
      )
    const bestTr = rows.reduce((a, b) => (b.tr > a.tr ? b : a))
    console.log(`  训练集最优 gain=${bestTr.g} → 其验证均 ${n3(bestTr.ho)}（这是唯一诚实的最终口径）`)
    return
  }

  // `--paramScan key=a,b,c`：**单参数扫描**，训练集选优、验证集判定。符合「训练调参、验证定最终」。
  if (process.argv.some((a) => a.startsWith('--paramScan'))) {
    const arg = process.argv.find((a) => a.startsWith('--paramScan=')) || ''
    const [key, valsStr] = arg.slice('--paramScan='.length).split('=')
    const vals = valsStr.split(',').map(Number).filter(Number.isFinite)
    console.log(`\n=== 单参数扫描 ${key} ∈ [${vals}]：训练集(Jul/Aug/Sep)选优，验证集判定 ===`)
    const rows = []
    for (const v of vals) {
      const w = { ...Z, ...DEFAULT_WEIGHTS, tiltMode: true, [key]: v }
      const per = {}
      for (const r of RANGES) per[r.key] = metrics(months[r.key].days, months[r.key].feats, allBars, idxBars, w)
      const ex = (k) => per[k].avg(per[k].excs.get(10))
      const av = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN)
      const tr = av(TRAIN_KEYS.map(ex).filter(Number.isFinite))
      const ho = av(HOLD_KEYS.map(ex).filter(Number.isFinite))
      const worst = Math.min(...RANGES.map((r) => ex(r.key)).filter(Number.isFinite))
      rows.push({ v, tr, ho, all: av(RANGES.map((r) => ex(r.key)).filter(Number.isFinite)), worst })
    }
    for (const r of rows)
      console.log(`  ${key}=${String(r.v).padEnd(5)} 训练均 ${n3(r.tr)} / 验证均 ${n3(r.ho)} / 全月均 ${n3(r.all)} / 最差月 ${n3(r.worst)}`)
    const bestTr = rows.reduce((a, b) => (b.tr > a.tr ? b : a))
    console.log(`  训练集最优 ${key}=${bestTr.v} → 验证均 ${n3(bestTr.ho)}`)
    return
  }

  // `--paramCV=key=v1,v2`：**留一月 CV** 选单参数（每月留出、其余 7 月选值，看留出月表现）。
  // 比「固定 Jul-Sep 训练 / Mar-Jun 验证」更用满样本，且避免单窗口 regime 分布不均的问题。
  if (process.argv.some((a) => a.startsWith('--paramCV'))) {
    const arg = process.argv.find((a) => a.startsWith('--paramCV=')) || ''
    const [key, valsStr] = arg.slice('--paramCV='.length).split('=')
    const vals = valsStr.split(',').map(Number).filter(Number.isFinite)
    console.log(`\n=== 单参数 CV ${key} ∈ [${vals}]：留一月、其余 7 月选优 ===`)
    const table = {}
    for (const v of vals) {
      const w = { ...Z, ...DEFAULT_WEIGHTS, tiltMode: true, [key]: v }
      for (const r of RANGES) {
        const m = metrics(months[r.key].days, months[r.key].feats, allBars, idxBars, w)
        ;(table[r.key] = table[r.key] || {})[v] = m.avg(m.excs.get(10))
      }
    }
    const av = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN)
    const perKey = {}
    for (const held of RANGES) {
      const others = RANGES.map((r) => r.key).filter((k) => k !== held.key)
      let best = null
      let bv = -Infinity
      for (const v of vals) {
        const m = av(others.map((k) => table[k][v]).filter(Number.isFinite))
        if (m > bv) {
          bv = m
          best = v
        }
      }
      const ex = table[held.key][best]
      console.log(`  留出 ${held.key}: 选 ${key}=${best} → ${n3(ex)}`)
      perKey[best] = perKey[best] || []
      if (Number.isFinite(ex)) perKey[best].push(ex)
    }
    const allHeld = RANGES.map((r) => table[r.key]).flatMap((t) => [t[0]])
    console.log(`  CV 留出月均（选参后）${n3(av(RANGES.map((r) => {
      const others = RANGES.map((x) => x.key).filter((k) => k !== r.key)
      let best = null
      let bv = -Infinity
      for (const v of vals) {
        const m = av(others.map((k) => table[k][v]).filter(Number.isFinite))
        if (m > bv) { bv = m; best = v }
      }
      return table[r.key][best]
    }).filter(Number.isFinite)))}`)
    console.log(`  对照：固定 ${key}=0 的留出月均 ${n3(av(RANGES.map((r) => table[r.key][0]).filter(Number.isFinite)))}`)
    return
  }

  const results = []
  // `robust` = 所有月 T+10 超额的最小值（最差月也要好）。
  // 注意是「全窗口最差月」，不是只挑训练窗口 —— 只看训练窗口的最差月，等于按训练集选优。
  for (const w of grid) {
    const per = {}
    for (const r of RANGES) {
      const m = metrics(months[r.key].days, months[r.key].feats, allBars, idxBars, w)
      per[r.key] = {
        ex: Object.fromEntries(HORIZONS.map((n) => [n, m.avg(m.excs.get(n))])),
        win: Object.fromEntries(HORIZONS.map((n) => [n, m.win(m.rets.get(n)) * 100])),
      }
    }
    const ex10 = RANGES.map((r) => per[r.key].ex[10])
    const ex5 = RANGES.map((r) => per[r.key].ex[5])
    results.push({ w, per, robust: Math.min(...ex10), robust5: Math.min(...ex5) })
  }
  results.sort((a, b) => b.robust - a.robust)

  const row = (r, h) => {
    const line = RANGES.map((x) => n3(r.per[x.key].ex[h])).join(' ')
    const tr = RANGES.filter((x) => TRAIN_KEYS.includes(x.key)).map((x) => r.per[x.key].ex[h])
    const ho = RANGES.filter((x) => HOLD_KEYS.includes(x.key)).map((x) => r.per[x.key].ex[h])
    const av = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN)
    return (
      `${tagOf(r.w).padEnd(30)} | ${line}` +
      ` | 训${n3(av(tr))} 验${n3(av(ho))} 验最差${n3(Math.min(...ho))}`
    )
  }

  console.log(`\n窗口 ${RANGES.map((r) => r.key).join(' ')}（T+10 相对沪深300超额 %）`)
  console.log('按「全窗口最差月 T+10 超额」排序 Top15：')
  for (const r of results.slice(0, 15)) console.log(row(r, 10))
  console.log('\n按「全窗口最差月 T+5 超额」排序 Top15：')
  for (const r of [...results].sort((a, b) => b.robust5 - a.robust5).slice(0, 15)) console.log(row(r, 5))

  // 固定配置基线：与 lib/factors.js 的生产默认权重一致（逐月抽出来做对照）
  const fixed = results.find((r) => tagOf(r.w) === tagOf(DEFAULT_WEIGHTS)) || results[0]

  // 训练→验证：用 TRAIN_KEYS 选出最差月最优配置，看它在 HOLD_KEYS 上表现如何。
  // 取代原来那段「约束：Aug 达标 → 再最大化 Sep」——后者是在**训练集**上二次选优，
  // 报出来的 Sep 数字已经不是样本外了。
  // `keys` 为空时 Math.min() 是 -Infinity，会把「全零配置」排到第一；空集直接回落固定配置。
  const pick = (keys) => {
    if (!keys.length) return fixed
    return [...results].sort(
      (a, b) =>
        Math.min(...keys.map((k) => b.per[k].ex[10])) - Math.min(...keys.map((k) => a.per[k].ex[10])),
    )[0]
  }
  const best = pick(TRAIN_KEYS)
  console.log(
    `\n训练(${TRAIN_KEYS.join('/')})最差月最优 → 验证(${HOLD_KEYS.join('/')})：` +
      `\n  配置 ${tagOf(best.w)}` +
      `\n  训练均 ${n3(avgOf(best, TRAIN_KEYS, 10))} / 验证均 ${n3(avgOf(best, HOLD_KEYS, 10))}` +
      ` / 验证最差月 ${n3(Math.min(...HOLD_KEYS.map((k) => best.per[k].ex[10])))}`,
  )
  const corr = pearson(
    results.map((r) => r.robust),
    results.map((r) => avgOf(r, HOLD_KEYS, 10)),
  )
  console.log(`  训练最差月 vs 验证均 的相关系数：${Number.isFinite(corr) ? corr.toFixed(3) : 'NA'}` +
    `（越接近 0 越说明「按训练集最差月选优」不可信；负值意味着越优化越糟）`)

  // 单参数检验：**固定生产权重**，只改 event 权重。相比全网格搜索（相关 -0.217、CV 更差），
  // 只动一个参数过拟合面小得多，是判断「事件因子本身有没有增量」的干净口径。
  const fixedFamily = results
    .filter(
      (r) =>
        r.w.reversal === DEFAULT_WEIGHTS.reversal &&
        r.w.midRev === DEFAULT_WEIGHTS.midRev &&
        r.w.upShadow === DEFAULT_WEIGHTS.upShadow &&
        r.w.lowVol === DEFAULT_WEIGHTS.lowVol &&
        r.w.q === DEFAULT_WEIGHTS.q &&
        r.w.ep === DEFAULT_WEIGHTS.ep,
    )
    .sort((a, b) => (a.w.event || 0) - (b.w.event || 0))
  console.log('\n固定生产权重、仅调 event（T+10 超额 %）：')
  for (const r of fixedFamily) {
    console.log(
      `  ev${r.w.event || 0}: 全月均 ${n3(avgOf(r, RANGES.map((x) => x.key), 10))} / ` +
        `训练均 ${n3(avgOf(r, TRAIN_KEYS, 10))} / 验证均 ${n3(avgOf(r, HOLD_KEYS, 10))} / ` +
        `最差月 ${n3(r.robust)}\n    ${RANGES.map((x) => n3(r.per[x.key].ex[10])).join(' ')}`,
    )
  }

  if (!CV) return
  // 留一月交叉验证：每次留一月、其余 7 月选最优，看留出月的表现。
  // 这是判断「调参」本身有没有正价值的唯一诚实口径 —— 上一版留一月 CV 全期 -1.49%。
  console.log(`\n=== 留一月交叉验证（每次留一月、其余 ${RANGES.length - 1} 月选最优）===`)
  let sum = 0
  let cnt = 0
  for (const held of RANGES) {
    const keys = RANGES.map((r) => r.key).filter((k) => k !== held.key)
    const chosen = pick(keys)
    const w = chosen.w // pick 返回的是整条结果；tagOf 要的是权重对象
    const ex = chosen.per[held.key].ex[10]
    const exFixed = fixed.per[held.key].ex[10]
    console.log(
      `  留出 ${held.key}: 选出 ${tagOf(w).padEnd(28)} → ${n3(ex)}` +
        `   （固定配置 ${n3(exFixed)}）`,
    )
    if (Number.isFinite(ex)) {
      sum += ex
      cnt += 1
    }
  }
  console.log(`  留出月均超额 ${n3(cnt ? sum / cnt : NaN)} / 固定配置 ${n3(avgOf(fixed, RANGES.map((r) => r.key), 10))}`)
}

main().catch((e) => {
  console.error('[opt] 失败：', e)
  process.exit(1)
})
