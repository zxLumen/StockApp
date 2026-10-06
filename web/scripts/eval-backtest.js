// 评估回测产出的每日 Top10：按每只**AI 给的建议持有周期**算收益，并对标沪深300。
//   node scripts/eval-backtest.js --from 2026-08-20 --to 2026-08-28 [--fixed 3,5,10,20]
// 输出：逐日明细 + 逐月汇总（均/最差月/正超额月数）。
// 只用日 K 回算；基准=回测日(basisDate)收盘买入，卖出=其后第 holdDays 个交易日收盘。
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../lib/scope.js'
import { cachedKline } from '../lib/kline-cache.js'

const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf(n)
  return i >= 0 ? argv[i + 1] : d
}
const FROM = opt('--from', '0000-00-00')
const TO = opt('--to', '9999-99-99')
const FIXED = String(opt('--fixed', '3,5,10,20')).split(',').map(Number).filter(Boolean)
const INDEX = opt('--index', '1.000300') // 沪深300
const DIR = (argv.indexOf('--dir') >= 0 ? argv[argv.indexOf('--dir') + 1] : '') || 'recommend'

const cache = new Map()
async function getBars(secid) {
  if (!cache.has(secid)) {
    const k = await cachedKline(secid).catch(() => null)
    cache.set(secid, k?.bars || [])
  }
  return cache.get(secid)
}

/** 在 bars 里找「日期 t 之后第 n 个交易日」的那根（t 本身是第 0 个）。 */
function barAfter(bars, t, n) {
  const idx = bars.findIndex((b) => b.time === t)
  if (idx < 0) return null
  const j = idx + n
  return j < bars.length ? bars[j] : null
}
const closeAt = (bars, t) => bars.find((b) => b.time === t)?.close ?? null

async function main() {
  const dir = path.join(DATA_DIR, DIR)
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .filter((f) => {
      const d = f.slice(0, 10)
      return d >= FROM && d <= TO
    })

  const idxBars = await getBars(INDEX)
  const fixed = new Map(FIXED.map((n) => [n, []]))
  const fixedEx = new Map(FIXED.map((n) => [n, []]))
  const rows = []

  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
    const basis = data.basisDate
    if (!basis) continue
    const tops = data.top || []
    const per = { file: f, basis, n: tops.length, ai: [], byHold: {}, fixed: {}, fixedEx: {} }

    for (const t of tops) {
      const bars = await getBars(t.secid)
      const base = closeAt(bars, basis) ?? t.price
      if (!base) continue
      const hold = t.ai?.holdDays || 5
      const sellBar = barAfter(bars, basis, hold)
      const ret = sellBar?.close ? ((sellBar.close / base - 1) * 100) : null
      if (ret != null) per.ai.push(ret)
      // 同期沪深300 收益 → 超额
      const idxBase = closeAt(idxBars, basis)
      const idxSell = sellBar ? closeAt(idxBars, sellBar.time) : null
      if (ret != null && idxBase && idxSell) {
        const idxRet = (idxSell / idxBase - 1) * 100
        per.excess = per.excess || []
        per.excess.push(ret - idxRet)
      }

      // 固定周期对照（收益 + 同期沪深300超额）
      for (const n of FIXED) {
        const b = barAfter(bars, basis, n)
        if (b?.close) {
          const ret = (b.close / base - 1) * 100
          if (!per.fixed[n]) per.fixed[n] = []
          per.fixed[n].push(ret)
          fixed.get(n).push(ret)
          const idxB = closeAt(idxBars, b.time)
          if (idxBase && idxB) {
            const ex = ret - (idxB / idxBase - 1) * 100
            if (!per.fixedEx[n]) per.fixedEx[n] = []
            per.fixedEx[n].push(ex)
            fixedEx.get(n).push(ex)
          }
        }
      }
    }

    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)
    const win = (a) => (a.length ? a.filter((x) => x > 0).length / a.length : null)
    per.avgAi = avg(per.ai)
    per.winAi = win(per.ai)
    per.avgEx = avg(per.excess || [])
    rows.push(per)
  }

  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)
  const win = (a) => (a.length ? a.filter((x) => x > 0).length / a.length : null)
  const n2 = (x) => (Number.isFinite(x) ? `${x > 0 ? '+' : ''}${x.toFixed(2)}` : ' NA ')

  console.log(`\n=== 评估 ${FROM} ~ ${TO}（${rows.length} 天）===`)
  console.log('日期(生效日) 基准日 | AI周期 均收益/胜率/超额 | 固定T+5 均收益')
  for (const r of rows) {
    const t5 = r.fixed[5] || []
    console.log(
      `${r.file.slice(0, 10)} ${r.basis} | ` +
        `${r.avgAi == null ? ' NA ' : r.avgAi.toFixed(1) + '%'} ` +
        `${r.winAi == null ? '' : (r.winAi * 100).toFixed(0) + '%'} ` +
        `${r.avgEx == null ? '' : (r.avgEx > 0 ? '+' : '') + r.avgEx.toFixed(1) + '%'} | ` +
        `${t5.length ? avg(t5).toFixed(1) + '%' : '-'}`,
    )
  }
  const allAi = rows.flatMap((r) => r.ai)
  const allEx = rows.flatMap((r) => r.excess || [])
  console.log(
    `\n综合：AI周期 均${avg(allAi)?.toFixed(2)}% 胜${(win(allAi) * 100).toFixed(0)}% ` +
      `超额${avg(allEx)?.toFixed(2)}%（正超额天数 ${allEx.filter((x) => x > 0).length}/${allEx.length}） | ` +
      FIXED.map(
        (n) =>
          `T+${n} ${avg(fixed.get(n))?.toFixed(2)}% 胜${(win(fixed.get(n)) * 100).toFixed(0)}% ` +
          `超额${avg(fixedEx.get(n))?.toFixed(2)}%`,
      ).join(' | '),
  )

  // ── 逐月汇总 ────────────────────────────────────────────────────────────
  // 逐日均值会骗人：某几个大牛股能把某一天拉成 +15%，而组合整体其实是亏的。
  // 「按月看均值 / 最差月 / 正超额月数」才看得出策略是否**跨月稳定**。
  // 之前调参只看训练窗口三个月的均值，所以训练集第一名在验证集排 #571/728 —— 均值被
  // 少数极端日主导是根因之一。
  console.log('\n=== 逐月汇总（T+N 相对沪深300超额 %）===')
  const byMonth = new Map()
  for (const r of rows) {
    const m = r.basis.slice(0, 7)
    if (!byMonth.has(m)) byMonth.set(m, new Map(FIXED.map((n) => [n, []])))
    const cell = byMonth.get(m)
    for (const n of FIXED) {
      const xs = r.fixedEx[n]
      // 逐值 push（原先 push(xs) 会得到嵌套数组，avg 作用其上恒为 NaN → 逐月永远 NA）
      if (xs && xs.length) for (const x of xs) cell.get(n).push(x)
    }
  }
  for (const n of FIXED) {
    const cells = [...byMonth.entries()]
      .map(([m, cell]) => ({ m, ex: cell.get(n) }))
      .filter((x) => x.ex && x.ex.length)
      .sort((a, b) => (a.m < b.m ? -1 : 1))
    if (!cells.length) continue
    const exs = cells.map((x) => x.ex)
    const mean = avg(exs.flat())
    const worst = Math.min(...cells.map((x) => avg(x.ex)))
    const posMonths = cells.filter((x) => avg(x.ex) > 0).length
    console.log(
      `\nT+${n}：${cells.length} 个月 | 均 ${n2(mean)}% | 最差月 ${n2(worst)}% ` +
        `| 正超额月 ${posMonths}/${cells.length} | ` +
        `月均范围 ${n2(Math.min(...exs.map(avg)))}% ~ ${n2(Math.max(...exs.map(avg)))}%`,
    )
    console.log('  ' + cells.map((x) => `${x.m.slice(5)} ${n2(avg(x.ex))}`).join(' | '))
  }

  // ── 稳健性提示 ──────────────────────────────────────────────────────────
  // 这些数字**含幸存者偏差**：universe 是当前成分股回溯历史，已退市的没进来。
  // 偏差方向大致让历史成绩偏好，所以不要把它当「未来也能赚这么多」的估计。
  console.log(
    '\n⚠️ 上述结果含幸存者偏差（universe 为当前成分股回溯），且样本期只有几个月；' +
      '月份少时「均/最差月」都很容易被少数极端日左右。',
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
