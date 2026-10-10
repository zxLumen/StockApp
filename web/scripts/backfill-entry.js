// 一次性维护：为**已存在的** B / dual(B 日) 活跃持仓回填 `entryDefer` + `entryApproved`（+ ai/pickPrice），
// 让「入口臣服」对历史仓同样生效（decideActions 靠这两个字段跳过提前终止）。
//   docker exec docker-stock-1 node scripts/backfill-entry.js
//   docker exec docker-stock-1 node scripts/backfill-entry.js --dry-run
//
// 以**持仓**为主：逐条读其 recDate 的 payload，判定当日是否 B（或 dual 在 B 日）→ entryDefer；
// entryApproved = 该 code 在当日 top 里且未被 veto。A / dual(A 日) 一律不动（不臣服）。
import path from 'node:path'
import { DATA_DIR } from '../lib/scope.js'
import { CHAIN_SUBDIR, bjDate, ACTIONS_FILE } from '../lib/recommend.js'
import { readJson, writeJson } from '../lib/store.js'

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const today = bjDate()

const actions = await readJson(path.join(DATA_DIR, ACTIONS_FILE), { version: 1, positions: {} })
if (!actions.positions || typeof actions.positions !== 'object') actions.positions = {}

const payloadCache = new Map()
const payloadOf = async (chain, recDate) => {
  const k = `${chain}:${recDate}`
  if (payloadCache.has(k)) return payloadCache.get(k)
  const p = await readJson(path.join(DATA_DIR, CHAIN_SUBDIR[chain] || 'recommend', `${recDate}.json`), null)
  payloadCache.set(k, p)
  return p
}

let changed = 0
const byChain = {}
for (const [key, pos] of Object.entries(actions.positions)) {
  if (!pos || pos.exited) continue
  const chain = pos.chain
  if (chain !== 'B' && chain !== 'dual') continue // A 不臣服
  const payload = await payloadOf(chain, pos.recDate)
  const isDefer = chain === 'B' || (chain === 'dual' && payload?.regime?.chain === 'B')
  if (!isDefer) continue
  const inTop = (payload?.top || []).find((s) => s.code === pos.code)
  const approved = !!(inTop && inTop.ai && inTop.ai.veto !== true)
  if (pos.entryDefer === true && pos.entryApproved === approved) continue // 已是目标值
  if (dryRun) {
    console.log(`[backfill] ${key} → entryDefer=true entryApproved=${approved}（dry-run）`)
    continue
  }
  pos.entryDefer = true
  pos.entryApproved = approved
  if (inTop?.ai && !pos.ai) pos.ai = inTop.ai
  if (pos.pickPrice == null && inTop?.price != null) pos.pickPrice = inTop.price
  pos.updatedAt = new Date().toISOString()
  changed += 1
  byChain[chain] = (byChain[chain] || 0) + 1
}

if (!dryRun && changed) await writeJson(path.join(DATA_DIR, ACTIONS_FILE), actions)
console.log(
  `[backfill] ${today}｜回填 ${changed} 笔${
    Object.keys(byChain).length ? `（${Object.entries(byChain).map(([k, v]) => `${k}:${v}`).join('，')}）` : ''
  }${dryRun ? '｜--dry-run 不落盘' : ''}`,
)
process.exit(0)
