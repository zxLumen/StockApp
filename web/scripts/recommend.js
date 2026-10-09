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
import { runRecommendDaily, runRecommendRegime, decideActions, bjDate } from '../lib/recommend.js'
import { isTradingDay } from '../lib/trading-days.js'
import { eventScores } from '../lib/ann-factor.js'
import { tiltThreshold, objectiveConfig, selectConfig } from '../lib/model-config.js'

// 策略参数来自可训练配置（web/config/model.json）；代码不写死。
const SEL = selectConfig()
const OBJ = objectiveConfig()

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const opt = (name, dflt) => {
  const i = argv.indexOf(name)
  if (i < 0) return dflt
  const n = Number(argv[i + 1])
  return Number.isFinite(n) ? n : dflt
}

const dryRun = has('--dry-run')
// 非交易日直接跳过：cron 只按周一~周五触发（不认节假日），假期跑会用陈旧数据生成"幽灵推荐"
// （basisDate 落在非交易日、生效日却是节后第一天）。--force 可强制生成。
if (!isTradingDay(bjDate()) && !has('--force')) {
  console.log('[recommend] 今日非 A 股交易日，跳过生成（如需强制用 --force）')
  process.exit(0)
}
// 默认 regime 双链路（两条都跑、按 tilt 择一）；`--single-chain` 回退单链路。
const dualChain = !has('--single-chain')
const dualThr = opt('--dual-thr', tiltThreshold())
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
    poolPages: opt('--pool-pages', SEL.poolPages),
    objTarget: opt('--obj-target', OBJ.target),
    finalPicks: opt('--final', SEL.finalPicks),
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
        topCandidates: opt('--top', strategy === 'factors' ? SEL.finalPicks : SEL.topCandidates),
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
  // AI 动态调整：对三条链路的**活跃持仓**（未到期、未终止）逐日决定 继续/延长/提前终止。
  // 提前终止带硬护栏（跌幅 ≤ −8% 且已持有 ≥ min(3, ⌊周期/2⌋) 日才生效，见 decideActions）。
  // 生成失败不阻断（上面的 try 已处理）；这里再各自兜底，任一链路失败不影响其它。
  if (!dryRun) {
    for (const chain of ['dual', 'A', 'B']) {
      try {
        await decideActions(DATA_DIR, cfg, { chain, onLog: (m) => console.log('[exit]', m) })
      } catch (e) {
        console.warn(`[exit] ${chain} 决策失败（忽略）：${e instanceof Error ? e.message : e}`)
      }
    }
  }
  process.exit(0)
} catch (err) {
  console.error('[recommend] 失败：', err instanceof Error ? err.message : String(err))
  process.exit(1)
}
