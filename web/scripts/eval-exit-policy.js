// 退出策略回测（确定性、不调 LLM）：对比「AI 提前终止」在加硬护栏前后的效果。
//   node scripts/eval-exit-policy.js [--dirs recommend-factors-2025,...] [--stop 8] [--min-hold 3] [--from 2025-01-01] [--to 2026-10-09]
//
// 数据：data/recommend-factors-*（B/因子链路的逐日推荐，含 secid/basisDate/price/ai.holdDays）
//       + data/kline-cache/<secid>.json（日K，仅交易日 → 相邻两根即 1 个交易日）。
//
// 三种退出策略（同一批持仓、同一份价格，逐笔模拟）：
//   OLD  近似现状：只要「自推荐涨幅 < 0」就当天终止（贴合实测的"一跌就砍"最激进假设）。
//   NEW  方案 C 硬护栏：仅当「跌幅 ≤ −stop%」且「已持有 ≥ min(minHold, ⌊周期/2⌋) 日」才终止，否则持有到期。
//   HOLD 基准：不提前终止，持满周期。
// 另统计「NEW 拦下的 OLD 终止」的实际结局（拦截是对是错）。
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../lib/scope.js'
import { readJson } from '../lib/store.js'

const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf(n)
  return i >= 0 ? argv[i + 1] : d
}
const STOP = Number(opt('--stop', 8)) || 8
const MIN_HOLD_ARG = Number(opt('--min-hold', 3)) || 3
const FROM = opt('--from', '')
const TO = opt('--to', '')
const DIRS = (opt('--dirs', 'recommend-factors-2025,recommend-factors-2026,recommend-factors-oos') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const cacheOf = async (secid) => {
  const j = await readJson(path.join(DATA_DIR, 'kline-cache', `${secid}.json`), null)
  return Array.isArray(j?.bars) && j.bars.length ? j.bars : null
}

const listDates = (dir) => {
  const abs = path.join(DATA_DIR, dir)
  try {
    return fs
      .readdirSync(abs)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.slice(0, 10))
      .filter((d) => (!FROM || d >= FROM) && (!TO || d <= TO))
      .sort()
  } catch {
    return []
  }
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)
const pct = (x) => `${(x * 100).toFixed(1)}%`
const s2 = (x) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(2)}%` : 'NA')

/** 单笔：返回 { old, new, hold, blocked, delta }（各自实现收益 %）。 */
function simulate(bars, entryIdx, holdDays) {
  const entry = bars[entryIdx].close
  const need = Math.min(MIN_HOLD_ARG, Math.max(1, Math.floor(holdDays / 2)))
  let rets = []
  for (let k = 1; k <= holdDays; k += 1) {
    const b = bars[entryIdx + k]
    if (!b || b.close == null) break
    rets.push({ k, ret: (b.close / entry - 1) * 100 })
  }
  if (!rets.length) return null
  const last = rets[rets.length - 1]
  const old = rets.find((r) => r.ret < 0)?.ret ?? last.ret
  const newHit = rets.find((r) => r.ret <= -STOP && r.k >= need)
  const neu = newHit ? newHit.ret : last.ret
  return { old, new: neu, hold: last.ret, blocked: !newHit && !!rets.find((r) => r.ret < 0) }
}

async function run() {
  const rows = []
  let skipped = 0
  let files = 0
  for (const dir of DIRS) {
    for (const d of listDates(dir)) {
      const payload = await readJson(path.join(DATA_DIR, dir, `${d}.json`), null)
      if (!payload || !Array.isArray(payload.top)) continue
      files += 1
      const basis = payload.basisDate || payload.date || d
      for (const s of payload.top) {
        const holdDays = Math.max(1, Math.round(Number(s.ai?.holdDays) || 0))
        if (!s.secid || !holdDays) continue
        const bars = await cacheOf(s.secid)
        if (!bars) {
          skipped += 1
          continue
        }
        let entryIdx = -1
        for (let i = bars.length - 1; i >= 0; i -= 1) {
          if (bars[i].time <= basis) {
            entryIdx = i
            break
          }
        }
        if (entryIdx < 0) {
          skipped += 1
          continue
        }
        const sim = simulate(bars, entryIdx, holdDays)
        if (!sim) {
          skipped += 1
          continue
        }
        rows.push({ dir, ...sim })
      }
    }
  }

  const stats = (key) => {
    const vals = rows.map((r) => r[key]).filter(Number.isFinite)
    return {
      n: vals.length,
      exits: rows.filter((r) => r[key] !== r.hold).length,
      mean: mean(vals),
      win: vals.filter((v) => v > 0).length / (vals.length || 1),
    }
  }
  const oldS = stats('old')
  const newS = stats('new')
  const holdS = stats('hold')
  const blocked = rows.filter((r) => r.blocked)

  console.log(`\n退出策略回测（B / 因子链路）  目录: ${DIRS.join(', ')}`)
  console.log(`参数: 止损 −${STOP}%  最小持有 min(${MIN_HOLD_ARG}, ⌊周期/2⌋)  区间: ${FROM || '不限'}~${TO || '不限'}`)
  console.log(`样本: ${files} 个推荐日 / ${rows.length} 笔可回放（跳过 ${skipped} 笔：缺K线或数据不足）\n`)
  const line = (name, s) =>
    `  ${name.padEnd(16)} 终止 ${String(s.exits).padStart(5)}  ${pct(s.exits / (s.n || 1)).padStart(6)}   平均 ${s2(s.mean).padStart(8)}   胜率 ${pct(s.win).padStart(6)}`
  console.log('策略              终止笔数   终止率     平均收益      胜率')
  console.log(line('OLD(一跌就止)', oldS))
  console.log(line(`NEW(护栏 −${STOP}%)`, newS))
  console.log(line('HOLD(持满周期)', holdS))
  console.log(
    `\n护栏拦下 OLD 的终止: ${blocked.length} 笔；这些被拦笔上 NEW 相对 OLD 的平均收益差 ${s2(mean(blocked.map((r) => r.new - r.old)))}（正=拦对了，少亏/多赚）`,
  )
  const improve = blocked.filter((r) => r.new > r.old).length
  console.log(`其中 NEW 更好 ${improve} 笔 / 更差 ${blocked.length - improve} 笔`)

  // 按目录再拆一份，便于看不同年份
  console.log('\n按目录:')
  for (const dir of DIRS) {
    const sub = rows.filter((r) => r.dir === dir)
    if (!sub.length) continue
    const eOld = sub.filter((r) => r.old !== r.hold).length
    const eNew = sub.filter((r) => r.new !== r.hold).length
    console.log(
      `  ${dir.padEnd(28)} 样本 ${String(sub.length).padStart(5)}  OLD 终止率 ${pct(eOld / sub.length).padStart(6)}  NEW 终止率 ${pct(eNew / sub.length).padStart(6)}`,
    )
  }
  console.log('')
}

run().catch((e) => {
  console.error('回测失败:', e instanceof Error ? e.message : e)
  process.exit(1)
})
