// 一次性维护：重开最近 N 天内被"提前终止"的持仓，再用**新护栏**重跑 AI 决策（是否提前终止/延长）。
//   docker exec docker-stock-1 node scripts/rerun-exits.js --days 14
//   docker exec docker-stock-1 node scripts/rerun-exits.js --days 14 --dry-run
//
// 背景：decideActions 里 exit 是终态，一旦记录就永不再决策。旧策略把很多 B 链路的票在小幅回撤时
// 就终止了，加了硬护栏（跌幅 ≤ −8% 且已持有 ≥ min(3,⌊周期/2⌋) 日）后，需要把这些近期终止的
// 持仓"重开"（清 exited/exit），再让 AI 按新规则重新判断（继续持有 / 延长 / 提前终止）。
import path from 'node:path'
import { DATA_DIR } from '../lib/scope.js'
import { aiConfig } from '../lib/settings.js'
import { decideActions, bjDate, ACTIONS_FILE } from '../lib/recommend.js'
import { readJson, writeJson } from '../lib/store.js'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const opt = (name, dflt) => {
  const i = argv.indexOf(name)
  if (i < 0) return dflt
  const n = Number(argv[i + 1])
  return Number.isFinite(n) ? n : dflt
}
const days = opt('--days', 14)
const dryRun = has('--dry-run')
const chains = ((argv.indexOf('--chains') >= 0 ? argv[argv.indexOf('--chains') + 1] : '') || 'dual,A,B')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const pad2 = (n) => String(n).padStart(2, '0')
const dateMinus = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d - n))
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`
}

const today = bjDate()
const from = dateMinus(today, days)
const file = path.join(DATA_DIR, ACTIONS_FILE)
const actions = await readJson(file, { version: 1, positions: {} })
if (!actions.positions || typeof actions.positions !== 'object') actions.positions = {}

let reopened = 0
for (const pos of Object.values(actions.positions)) {
  if (!pos?.exited) continue
  const decidedOn = pos.exit?.basisDate || pos.exit?.date || pos.updatedAt?.slice(0, 10) || ''
  if (decidedOn && decidedOn < from) continue // 太老的终止不动
  pos.exited = false
  pos.exit = null
  if (!Array.isArray(pos.log)) pos.log = []
  pos.log.push({ date: today, action: 'reopened', note: `重开近 ${days} 天内终止，按新护栏重新决策` })
  pos.updatedAt = new Date().toISOString()
  reopened += 1
}
console.log(`[rerun] today=${today}｜重开窗口 ${from}~${today}｜重开 ${reopened} 笔`)
if (reopened === 0) console.log('[rerun] 没有需要重开的终止持仓')

if (dryRun) {
  console.log('[rerun] --dry-run：不落盘、不调 AI')
  process.exit(0)
}
if (reopened > 0) await writeJson(file, actions)

const cfg = await aiConfig(DATA_DIR)
if (!cfg?.apiKey) {
  console.error('[rerun] AI 未配置 API Key —— 先在站内 ⚙ 设置里配好 provider / Key')
  process.exit(1)
}
console.log(`[rerun] 模型 ${cfg.model}｜链路 ${chains.join(',')}`)

for (const chain of chains) {
  try {
    const r = await decideActions(DATA_DIR, cfg, { chain, today, onLog: (m) => console.log('[exit]', m) })
    console.log(`[rerun] ${chain}: 活跃 ${r.decided}｜变更 ${r.changed}｜护栏拦截 ${r.gated}`)
  } catch (e) {
    console.warn(`[rerun] ${chain} 决策失败（忽略）：${e instanceof Error ? e.message : e}`)
  }
}
console.log('[rerun] 完成')
process.exit(0)
