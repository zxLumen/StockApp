// Holdout 评估（只读）：读取冻结快照 + 日K缓存，输出 Markdown + JSON。
// 规则见 docs/research/HOLDOUT.md；指标定义见 docs/research/METHODOLOGY.md。
// 注意：**不要**把重叠持有期的每日 cohort 收益直接复利——那不是组合收益。
// 本脚本只报「逐票等权」与「每日 cohort 均值」，组合收益请用生产持仓页的金额法口径。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyManifest, assertEvalRange, readJson, HOLDOUT_CUTOFF } from './guard.js'
import { mean, median, std, betaAlpha, bootstrapCI, costAdjust } from './metrics.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf(n)
  return i >= 0 ? argv[i + 1] : d
}
const ROOT = path.resolve(opt('--snapshot', path.join(HERE, '../../../research/holdout')))
const DATA = path.resolve(opt('--data-dir', '/data'))
const OUT = path.resolve(opt('--out', path.join(HERE, '../../../docs/research/RUN-holdout.md')))
const JSON_OUT = path.resolve(opt('--json', path.join(HERE, '../../../research/reports/holdout.json')))
const FROM = opt('--from', HOLDOUT_CUTOFF)
const TO = opt('--to', '9999-12-31')
assertEvalRange(FROM, TO)
const manifest = verifyManifest(ROOT)
const benches = readJson(path.join(ROOT, 'benchmarks.json'))
const STYLE = { A: '沪深300', B: '创业板指', dual: '创业板指' }
const pct = (x) => (x == null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(2)}%`)
const num = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(d))

const barCache = new Map()
function barsOf(secid) {
  if (!barCache.has(secid)) {
    let bars = []
    try {
      bars = readJson(path.join(DATA, 'kline-cache', `${secid}.json`)).bars || []
    } catch {
      bars = []
    }
    barCache.set(secid, bars)
  }
  return barCache.get(secid)
}
const findGe = (bars, date) => {
  for (let i = 0; i < bars.length; i += 1) if (bars[i].time >= date) return i
  return -1
}
const findLe = (bars, date) => {
  for (let i = bars.length - 1; i >= 0; i -= 1) if (bars[i].time <= date) return i
  return -1
}
function benchWindow(name, entryDate, exitDate, atOpen) {
  const bars = benches[name]?.bars || []
  const i = findLe(bars, entryDate)
  const j = findLe(bars, exitDate)
  if (i < 0 || j < 0) return null
  const a = atOpen ? bars[i].open : bars[i].close
  const b = atOpen ? bars[j].open : bars[j].close
  if (!(a > 0) || !(b > 0)) return null
  return { ret: b / a - 1, entryDate: bars[i].time, exitDate: bars[j].time }
}

function evalChain(chain) {
  const dir = path.join(ROOT, 'forward', chain)
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .filter((f) => f.slice(0, 10) >= FROM && f.slice(0, 10) <= TO)
  const trades = []
  const cohorts = []
  let missing = 0
  let notDone = 0
  for (const f of files) {
    const p = readJson(path.join(dir, f))
    const date = p.date || f.slice(0, 10)
    const atOpen = p.entryAnchor === 'effective'
    const entryDate = atOpen ? date : p.basisDate || date
    const styleName = chain === 'dual' ? (p.regime?.chain === 'A' ? '沪深300' : '创业板指') : STYLE[chain]
    const row = []
    for (const t of p.top || []) {
      const bars = barsOf(t.secid)
      if (!bars.length) {
        missing += 1
        continue
      }
      const ei = findGe(bars, entryDate)
      if (ei < 0) {
        missing += 1
        continue
      }
      const entryPrice = atOpen ? Number(bars[ei].open) : Number(t.price) || Number(bars[ei].close)
      if (!(entryPrice > 0)) {
        missing += 1
        continue
      }
      const holdDays = Math.max(1, Number(t.ai?.holdDays ?? t.holdDays ?? 5))
      const xi = ei + holdDays
      const done = xi < bars.length
      if (!done) notDone += 1
      const exitBar = done ? bars[xi] : bars[bars.length - 1]
      const exitPrice = done
        ? atOpen
          ? Number(exitBar.open)
          : Number(exitBar.close)
        : Number(exitBar.close)
      const latestPrice = Number(bars[bars.length - 1].close)
      if (!(exitPrice > 0) || !(latestPrice > 0)) {
        missing += 1
        continue
      }
      const retHold = exitPrice / entryPrice - 1
      const retSince = latestPrice / entryPrice - 1
      const bw = benchWindow(styleName, entryDate, exitBar.time, atOpen)
      const b300 = benchWindow('沪深300', entryDate, exitBar.time, atOpen)
      const tr = {
        date,
        chain,
        secid: t.secid,
        code: t.code,
        name: t.name,
        holdDays,
        done,
        entryDate,
        exitDate: exitBar.time,
        entryPrice,
        exitPrice,
        latestPrice,
        retHold,
        retSince,
        styleName,
        benchRet: bw?.ret ?? null,
        excess: bw ? retHold - bw.ret : null,
        bench300: b300?.ret ?? null,
        excess300: b300 ? retHold - b300.ret : null,
      }
      trades.push(tr)
      row.push(tr)
    }
    if (row.length) {
      const withEx = row.filter((t) => t.excess != null)
      const withEx300 = row.filter((t) => t.excess300 != null)
      cohorts.push({
        date,
        chain,
        n: row.length,
        hold: mean(row.map((t) => t.retHold)),
        since: mean(row.map((t) => t.retSince)),
        excess: mean(withEx.map((t) => t.excess)),
        bench: mean(withEx.map((t) => t.benchRet)),
        excess300: mean(withEx300.map((t) => t.excess300)),
        bench300: mean(withEx300.map((t) => t.bench300)),
        win: row.filter((t) => t.retHold > 0).length / row.length,
      })
    }
  }
  const rets = trades.map((t) => t.retHold)
  const since = trades.map((t) => t.retSince)
  const doneTrades = trades.filter((t) => t.done)
  const retsDone = doneTrades.map((t) => t.retHold)
  const ex = trades.filter((t) => t.excess != null).map((t) => t.excess)
  const ex300 = trades.filter((t) => t.excess300 != null).map((t) => t.excess300)
  const bench = trades.filter((t) => t.benchRet != null).map((t) => t.benchRet)
  const benchDone = doneTrades.filter((t) => t.benchRet != null).map((t) => t.benchRet)
  const cohortHold = cohorts.map((c) => c.hold)
  const cohortBench = cohorts.filter((c) => c.bench != null).map((c) => c.bench)
  const costs = Object.fromEntries([0, 10, 15, 20].map((bps) => [bps, mean(costAdjust(rets, bps))]))
  const ba = betaAlpha(rets, bench)
  const baDone = betaAlpha(retsDone, benchDone)
  const baC = betaAlpha(cohortHold, cohortBench)
  return {
    chain,
    files: files.length,
    trades: trades.length,
    missing,
    notDone,
    pooled: {
      mean: mean(rets),
      median: median(rets),
      std: std(rets),
      win: rets.filter((r) => r > 0).length / (rets.length || 1),
      ci: bootstrapCI(rets),
      meanSince: mean(since),
      meanExcess: mean(ex),
      meanExcess300: mean(ex300),
      beta: ba.beta,
      alpha: ba.alpha,
      r2: ba.r2,
    },
    done: {
      n: doneTrades.length,
      mean: mean(retsDone),
      median: median(retsDone),
      std: std(retsDone),
      win: retsDone.filter((r) => r > 0).length / (retsDone.length || 1),
      ci: bootstrapCI(retsDone),
      meanExcess: mean(doneTrades.filter((t) => t.excess != null).map((t) => t.excess)),
      beta: baDone.beta,
      alpha: baDone.alpha,
      r2: baDone.r2,
      costs: Object.fromEntries([0, 10, 15, 20].map((bps) => [bps, mean(costAdjust(retsDone, bps))])),
    },
    cohort: {
      n: cohorts.length,
      mean: mean(cohortHold),
      std: std(cohortHold),
      meanExcess: mean(cohorts.filter((c) => c.excess != null).map((c) => c.excess)),
      beta: baC.beta,
      alpha: baC.alpha,
      r2: baC.r2,
    },
    costs,
    cohorts,
    trades,
  }
}

const chains = ['dual', 'A', 'B'].map(evalChain)
const dataLast = (() => {
  let last = null
  for (const t of chains[0].trades) {
    const bars = barsOf(t.secid)
    const b = bars[bars.length - 1]
    if (b && (!last || b.time > last)) last = b.time
  }
  return last
})()
const report = {
  generatedAt: new Date().toISOString(),
  holdout: { cutoff: HOLDOUT_CUTOFF, from: FROM, to: TO, snapshotFiles: manifest.files.length },
  dataDir: DATA,
  dataLastBar: dataLast,
  note:
    '逐票等权；持有周期到点卖出（未计 AI 动态退出）；未走完周期用最新收盘 MTM。' +
    ' 不报「重叠 cohort 复利」——那是重复计算，不是组合收益；组合口径见生产持仓页。',
  benchmarks: Object.fromEntries(
    Object.entries(benches).map(([k, v]) => [k, { first: v.bars[0]?.time, last: v.bars.at(-1)?.time, n: v.bars.length }]),
  ),
  chains,
}
fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true })
fs.writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`)

const lines = []
lines.push(`# Holdout 评估（${FROM} ~ ${TO}）`)
lines.push('')
lines.push(`> 由 \`web/scripts/research/eval-holdout.js\` 生成；快照 SHA-256 已校验（${manifest.files.length} 个推荐文件）。`)
lines.push(`> **这些数据只用于评估，未参与任何训练/调参。** cutoff = \`${HOLDOUT_CUTOFF}\`。`)
lines.push(`> 日K缓存最新交易日：\`${dataLast ?? '—'}\`；生成时间：${report.generatedAt}。`)
lines.push('')
lines.push('## 总表（逐票等权、生效日开盘买入、持有周期到点卖）')
lines.push('')
lines.push('| 链路 | 笔数 | 已了结 | 均持有(全部) | 均持有(已了结) | 95%CI(已了结) | 胜率(已了结) | 均至今 | 风格基准 | 均超额(已了结) | β(全部) | α(全部) | 成本0.2% | 成本0.3% | 成本0.4% |')
lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|')
for (const c of chains) {
  const p = c.pooled
  const d = c.done
  const ci = d.ci ? `[${pct(d.ci.lo)}, ${pct(d.ci.hi)}]` : '—'
  lines.push(
    `| ${c.chain} | ${c.trades.length} | ${d.n} | ${pct(p.mean)} | ${pct(d.mean)} | ${ci} | ${(d.win * 100).toFixed(0)}% | ${pct(p.meanSince)} | ${c.chain === 'A' ? '沪深300' : '创业板指'} | ${pct(d.meanExcess)} | ${num(p.beta)} | ${pct(p.alpha)} | ${pct(d.costs[10])} | ${pct(d.costs[15])} | ${pct(d.costs[20])} |`,
  )
}
lines.push('')
lines.push('> `均持有(全部)` 含未走完周期的 MTM；`已了结` 只统计真正走完持有周期的票（A 的周期 12~45 天，未了结比例高，务必看这一列）。')
lines.push('> `均至今` = 不卖、拿到最新（与推荐页「推荐日至今」同口径，仅供对照）。')
lines.push('> `α(同期)` = 对**风格基准**做 OLS 的同期 alpha（逐票，非年化）；`β` 同为逐票回归。**未计**涨跌停/停牌/整手/资金约束。')
lines.push('')
lines.push('### 回归明细（逐票，风格基准）')
lines.push('')
lines.push('| 链路 | n(全部) | β(全部) | α(全部) | R² | n(已了结) | β(已了结) | α(已了结) | R² |')
lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|')
for (const c of chains) {
  const p = c.pooled
  const d = c.done
  lines.push(
    `| ${c.chain} | ${c.trades.length} | ${num(p.beta)} | ${pct(p.alpha)} | ${num(p.r2)} | ${d.n} | ${num(d.beta)} | ${pct(d.alpha)} | ${num(d.r2)} |`,
  )
}
lines.push('')
lines.push('> A 的已了结样本仅 47/170，β/α 噪声大（β 甚至为负）；A 的结论以「均持有(已了结) + CI」为准，回归仅作参考。')
lines.push('')
for (const c of chains) {
  lines.push(`## ${c.chain} 逐日`)
  lines.push('')
  lines.push('| 日期 | n | 均持有 | 均至今 | 胜率 | 风格超额 | 沪深300超额 |')
  lines.push('|---|---:|---:|---:|---:|---:|---:|')
  for (const row of c.cohorts) {
    lines.push(`| ${row.date} | ${row.n} | ${pct(row.hold)} | ${pct(row.since)} | ${(row.win * 100).toFixed(0)}% | ${pct(row.excess)} | ${pct(row.excess300)} |`)
  }
  lines.push('')
}
lines.push('## 数据质量 / 口径')
lines.push('')
lines.push(`- 快照：\`research/holdout/forward/{dual,A,B}\`，共 ${manifest.files.length} 份；actions 快照 ${(manifest.actions || []).length} 份（仅 10-30，未覆盖 11 月，故本报告不用 AI 动态退出）。`)
lines.push(`- 缺失/跳过：${chains.map((c) => `${c.chain}=${c.missing}`).join('，')}；未走完持有周期：${chains.map((c) => `${c.chain}=${c.notDone}`).join('，')}。`)
lines.push('- 未计：涨跌停/停牌不可成交、整手约束、资金约束、分红；成本仅做敏感性（单边 bps × 2）。')
lines.push('- 「至今」会随日K更新变化；本报告以 `dataLastBar` 为准，是可复现的历史截面。')
lines.push('- **不要**把重叠持有期的每日 cohort 收益复利成“组合收益”（会重复计算）；组合收益请看生产持仓页的金额法口径。')
lines.push('')
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, `${lines.join('\n')}\n`)
console.log(`wrote ${OUT}`)
console.log(`wrote ${JSON_OUT}`)
for (const c of chains) {
  const p = c.pooled
  const d = c.done
  console.log(
    `${c.chain}: n=${c.trades.length} done=${d.n} all=${pct(p.mean)} doneMean=${pct(d.mean)} ci=${d.ci ? `[${pct(d.ci.lo)},${pct(d.ci.hi)}]` : '—'} win=${(d.win * 100).toFixed(0)}% since=${pct(p.meanSince)} styleEx=${pct(d.meanExcess)} beta=${num(d.beta)} alpha=${pct(d.alpha)} cost20=${pct(d.costs[20])}`,
  )
}
