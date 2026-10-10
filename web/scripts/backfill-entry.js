// 一次性维护：为**已存在的、未退出的** B / dual(B 日) 持仓回填「入口臣服」标记
// （`entryDefer` + `entryApproved`），让 decideActions 对其跳过提前终止。
//   docker exec docker-stock-1 node scripts/backfill-entry.js
//   docker exec docker-stock-1 node scripts/backfill-entry.js --dry-run
//
// 只处理未退出（exited=false）的仓；已终止的是终态，需先用 rerun-exits 重开再回填。
// A / dual(A 日) 不臣服，函数会直接跳过。
import { DATA_DIR } from '../lib/scope.js'
import { backfillEntryFlags } from '../lib/recommend.js'

if (process.argv.includes('--dry-run')) {
  console.log('[backfill] --dry-run 仅提示：本脚本改动以行为单位，dry-run 下不写盘（如需预演请用 rerun-exits --dry-run）')
  process.exit(0)
}

const r = await backfillEntryFlags(DATA_DIR, { onLog: (m) => console.log(m) })
console.log(`[backfill] 完成｜回填 ${r.changed} 笔`)
process.exit(0)
