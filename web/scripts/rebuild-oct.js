// 一次性维护：清空 actions 后，用**最新策略**按区间逐日**回放**重建持仓。
//   docker exec docker-stock-1 node scripts/rebuild-oct.js --from 2026-10-08 --to 2026-10-12
//   docker exec docker-stock-1 node scripts/rebuild-oct.js --from ... --to ... --dry-run
//
// 逐日顺序（与生产每日 recommend.js 同构，保证时点正确）：
//   ① ensureEntryPositions(dual, B)：按当日推荐落库建仓（含入口臣服标记）
//   ② decideActions(dual, A, B)：以当日为 today 决策 继续/延长/提前终止
//   ③ reconcileCross(dual, A, B)：当日交叉票联合仲裁
//
// A 链路**不重选**（保留既有 recommend-ai-fwd），但会走 ②③ 重建其持仓/终止。
import path from 'node:path'

import { DATA_DIR } from '../lib/scope.js'
import { aiConfig } from '../lib/settings.js'
import { readJson } from '../lib/store.js'
import {
  ensureEntryPositions,
  decideActions,
  reconcileCross,
  CHAIN_SUBDIR,
} from '../lib/recommend.js'
import { isTradingDay, nextTradingDay } from '../lib/trading-days.js'

const argv = process.argv.slice(2)
const val = (n, d) => (argv.indexOf(n) >= 0 ? argv[argv.indexOf(n) + 1] : d)
const has = (f) => argv.includes(f)
const FROM = val('--from', '2026-10-08')
const TO = val('--to', '2026-10-12')
const DRYRUN = has('--dry-run')

const effs = []
for (let d = FROM; d <= TO; d = nextTradingDay(d)) if (isTradingDay(d)) effs.push(d)
console.log(`[rebuild] 区间 ${FROM}~${TO}｜交易日 ${effs.join(' ')}｜dry-run=${DRYRUN}`)

const cfg = DRYRUN ? null : await aiConfig(DATA_DIR)
if (!DRYRUN && !cfg?.apiKey) {
  console.error('[rebuild] AI 未配置 API Key，中止')
  process.exit(1)
}

for (const E of effs) {
  console.log(`\n[rebuild] ==== ${E} ====`)
  // ① 入口落库（dual 与 B；A 不建入口仓）
  for (const chain of ['dual', 'B']) {
    const p = await readJson(path.join(DATA_DIR, CHAIN_SUBDIR[chain], `${E}.json`), null)
    if (!p?.top?.length) {
      console.log(`[rebuild] ${chain}@${E} 无 top，跳过入口落库`)
      continue
    }
    if (DRYRUN) continue
    await ensureEntryPositions(DATA_DIR, {
      chain,
      recDate: E,
      basisDate: p.basisDate,
      top: p.top,
      onLog: (m) => console.log('[entry]', m),
    })
  }
  // ② 决策（dual / A / B）
  for (const chain of ['dual', 'A', 'B']) {
    if (DRYRUN) continue
    try {
      const r = await decideActions(DATA_DIR, cfg, { chain, today: E, onLog: (m) => console.log('[exit]', m) })
      console.log(`[rebuild] ${chain}@${E} 决策：活跃 ${r.decided}｜变更 ${r.changed}`)
    } catch (e) {
      console.warn(`[rebuild] ${chain}@${E} 决策失败（忽略）：${e instanceof Error ? e.message : e}`)
    }
  }
  // ③ 交叉仲裁（dual / A / B）
  for (const chain of ['dual', 'A', 'B']) {
    if (DRYRUN) continue
    try {
      await reconcileCross(DATA_DIR, cfg, { chain, effective: E, onLog: (m) => console.log('[cross]', m) })
    } catch (e) {
      console.warn(`[rebuild] ${chain}@${E} 交叉仲裁失败（忽略）：${e instanceof Error ? e.message : e}`)
    }
  }
}
console.log('\n[rebuild] 完成')
process.exit(0)
