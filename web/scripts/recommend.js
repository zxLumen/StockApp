// 每日推荐批处理入口。服务器 cron 在收盘后跑：
//   docker exec docker-stock-1 node scripts/recommend.js
// 或本地：npm run recommend -- --dry-run
//
// 默认走 **regime 双链路**：两条都跑，按当日 tilt 择一落盘
//   tilt >= --dual-thr(0.6) → A（成交额池 + AI 选股，激进）
//   否则                      → B（稳健池 + 客观因子，保守）
// `--single-chain` 回退到单链路（默认「客观多因子」，`--strategy ai` 可退旧链路）。
//
// 产物：DATA_DIR/recommend/<YYYY-MM-DD>.json（前端「推荐」页签读它）。
import { DATA_DIR } from '../lib/scope.js'
import { aiConfig } from '../lib/settings.js'
import { runRecommendDaily, runRecommendRegime, bjDate } from '../lib/recommend.js'
import { eventScores } from '../lib/ann-factor.js'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const opt = (name, dflt) => {
  const i = argv.indexOf(name)
  if (i < 0) return dflt
  const n = Number(argv[i + 1])
  return Number.isFinite(n) ? n : dflt
}

const dryRun = has('--dry-run')
// 默认 regime 双链路（两条都跑、按 tilt 择一）；`--single-chain` 回退单链路。
const dualChain = !has('--single-chain')
const dualThr = opt('--dual-thr', 0.6)
// 单链路模式下的选股方式：默认「客观多因子」（低波+反转，AI 只解读）；`--strategy ai` 回退旧链路。
const strategy = (argv.indexOf('--strategy') >= 0 ? argv[argv.indexOf('--strategy') + 1] : '') || 'factors'
const cfg = await aiConfig(DATA_DIR)
if (!cfg?.apiKey) {
  console.error('[recommend] AI 未配置 API Key —— 先在站内 ⚙ 设置里配好 provider / Key')
  process.exit(1)
}

console.log(`[recommend] 数据目录 ${DATA_DIR} | 模型 ${cfg.model}`)
// 公告事件净分（≤ 今日，回看 5 天）：与回测同口径注入因子选股。
// 需当日 ann-archive 已归档；缺失则该项不贡献（不阻断）。
const basisDate = bjDate()
const evtMap = await eventScores(DATA_DIR, basisDate, { windowDays: 5 }).catch((e) => {
  console.warn(`[recommend] 事件分计算失败（忽略该因子）：${e instanceof Error ? e.message : e}`)
  return null
})
if (evtMap) console.log(`[recommend] 事件因子覆盖 ${evtMap.size} 只（回看 5 天）`)
try {
  // 双链路自己管 selectMode / topCandidates（A=100、B=final），这里只给公共参数。
  const shared = {
    dataDir: DATA_DIR,
    cfg,
    poolPages: opt('--pool-pages', 5),
    objTarget: opt('--obj-target', 200),
    finalPicks: opt('--final', 10),
    concurrency: opt('--concurrency', 4),
    outSubdir: (argv.indexOf('--out-subdir') >= 0 ? argv[argv.indexOf('--out-subdir') + 1] : '') || 'recommend',
    dryRun,
    deps: { basisDate, event: evtMap ? (c) => evtMap.get(c.code) ?? null : undefined },
    onLog: (m) => console.log('[recommend]', m),
  }
  const payload = dualChain
    ? await runRecommendRegime({ ...shared, thr: dualThr })
    : await runRecommendDaily({
        ...shared,
        selectMode: strategy,
        topCandidates: opt('--top', strategy === 'factors' ? 10 : 100),
      })
  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          regime: payload.regime ?? null,
          top: payload.top.map((t) => ({
            code: t.code,
            name: t.name,
            monthPct: t.monthPct,
            buyScore: t.ai?.buyScore ?? null,
            reason: t.reason,
          })),
        },
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
