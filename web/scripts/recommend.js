// 每日推荐批处理入口。服务器 cron 在收盘后跑：
//   docker exec docker-stock-1 node scripts/recommend.js
// 或本地：npm run recommend -- --dry-run
//
// 产物：DATA_DIR/recommend/<YYYY-MM-DD>.json（前端「推荐」页签读它）。
import { DATA_DIR } from '../lib/scope.js'
import { aiConfig } from '../lib/settings.js'
import { runRecommendDaily } from '../lib/recommend.js'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const opt = (name, dflt) => {
  const i = argv.indexOf(name)
  if (i < 0) return dflt
  const n = Number(argv[i + 1])
  return Number.isFinite(n) ? n : dflt
}

const dryRun = has('--dry-run')
const cfg = await aiConfig(DATA_DIR)
if (!cfg?.apiKey) {
  console.error('[recommend] AI 未配置 API Key —— 先在站内 ⚙ 设置里配好 provider / Key')
  process.exit(1)
}

console.log(`[recommend] 数据目录 ${DATA_DIR} | 模型 ${cfg.model}`)
try {
  const payload = await runRecommendDaily({
    dataDir: DATA_DIR,
    cfg,
    poolPages: opt('--pool-pages', 5),
    objTarget: opt('--obj-target', 200),
    topCandidates: opt('--top', 100),
    finalPicks: opt('--final', 10),
    concurrency: opt('--concurrency', 4),
    dryRun,
    onLog: (m) => console.log('[recommend]', m),
  })
  if (dryRun) {
    console.log(
      JSON.stringify(
        payload.top.map((t) => ({
          code: t.code,
          name: t.name,
          monthPct: t.monthPct,
          buyScore: t.ai?.buyScore ?? null,
          reason: t.reason,
        })),
        null,
        2,
      ),
    )
  }
  process.exit(0)
} catch (err) {
  console.error('[recommend] 失败：', err instanceof Error ? err.message : String(err))
  process.exit(1)
}
