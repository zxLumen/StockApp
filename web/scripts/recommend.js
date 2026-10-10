// 每日推荐批处理入口。服务器 cron 在收盘后跑：
//   docker exec docker-stock-1 node scripts/recommend.js
// 或本地：npm run recommend -- --dry-run
//
// `--refresh`：**盘前刷新**（交易日 09:00，另一条 cron）。用最新公告（含隔夜/周末）重算**当天**
// 推荐并覆盖原文件；价格基准取**上一交易日**收盘（basisDate=prevTradingDay）；后置流程走
// 「方案甲」——替换当天建仓 + 重跑交叉，不跑 decideActions。
//   docker exec docker-stock-1 node scripts/recommend.js --refresh
//
// 默认走 **regime 双链路**：两条都跑，按当日 tilt 择一落盘
//   tilt >= --dual-thr(0.6) → A（成交额池 + AI 选股，激进）
//   否则                      → B（稳健池 + 客观因子，保守）
// `--single-chain` 回退到单链路（默认「客观多因子」，`--strategy ai` 可退旧链路）。
//
// 产物：DATA_DIR/recommend/<YYYY-MM-DD>.json（前端「推荐」页签读它）。
import { DATA_DIR } from '../lib/scope.js'
import { aiConfig } from '../lib/settings.js'
import { runRecommendDaily, runRecommendRegime, decideActions, reconcileCross, ensureEntryPositions, replaceEntryPositions, CHAIN_SUBDIR, bjDate } from '../lib/recommend.js'
import { readJson } from '../lib/store.js'
import path from 'node:path'
import { isTradingDay, prevTradingDay } from '../lib/trading-days.js'
import { eventScores } from '../lib/ann-factor.js'
import { archiveAnnouncements } from '../lib/archive-ann.js'
import { tiltThreshold, objectiveConfig, selectConfig, eventWindowDays } from '../lib/model-config.js'

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
// 盘前刷新：交易日 09:00 跑，用最新公告（含隔夜/周末）重算**当天**推荐，覆盖原文件；
// 价格基准仍取**上一交易日**收盘（basisDate=prevTradingDay）。见下方 --refresh 分支。
const refresh = has('--refresh')
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
// 价格基准日：日常=今天（收盘后跑）；盘前刷新=上一交易日（当天尚未收盘）。
// 事件因子 as-of：日常=基准日；盘前刷新=今天（窗口末端延伸到运行日，纳入隔夜/周末公告）。
// 公告归档（best-effort）：日常补当日；盘前刷新补 [基准日..今天]（含隔夜/周末）。
const asOf = bjDate()
const basisDate = refresh ? prevTradingDay(asOf) : asOf
await archiveAnnouncements({
  dataDir: DATA_DIR,
  from: basisDate,
  to: asOf,
  preload: false,
  maxPage: 20,
  log: (m) => console.log('[recommend]', m),
}).catch((e) => console.warn(`[recommend] 公告归档失败（忽略）：${e instanceof Error ? e.message : e}`))
const evtMap = await eventScores(DATA_DIR, refresh ? asOf : basisDate, { windowDays: eventWindowDays() }).catch((e) => {
  console.warn(`[recommend] 事件分计算失败（忽略该因子）：${e instanceof Error ? e.message : e}`)
  return null
})
if (evtMap) console.log(`[recommend] 事件因子覆盖 ${evtMap.size} 只（回看 ${eventWindowDays()} 个交易日）`)
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
    deps: { basisDate, event: evtMap ? (c) => evtMap.get(c.code) ?? null : undefined, effectiveDate: refresh ? asOf : undefined },
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
  if (!dryRun && refresh) {
    // 盘前刷新（方案甲）：**替换** E 的建仓（dual/B：清旧仓 → 按新 top 重建，重派生臣服标记），
    // 再重跑交叉裁决（让 E 的终止对齐刷新后的新 top）。**不跑 decideActions** —— 持仓的延长/终止
    // 交给正常收盘节奏（E 当晚那次）；A 的持仓同样交给收盘节奏。
    for (const chain of ['dual', 'B']) {
      try {
        const f = path.join(DATA_DIR, CHAIN_SUBDIR[chain] || 'recommend', `${payload.date}.json`)
        const p = await readJson(f, null)
        if (!p || !(p.top || []).length) continue
        await replaceEntryPositions(DATA_DIR, {
          chain,
          recDate: payload.date,
          basisDate: payload.basisDate,
          top: p.top,
          onLog: (m) => console.log('[replace]', m),
        })
      } catch (e) {
        console.warn(`[replace] ${chain} 失败（忽略）：${e instanceof Error ? e.message : e}`)
      }
    }
    for (const chain of ['dual', 'A', 'B']) {
      try {
        await reconcileCross(DATA_DIR, cfg, {
          chain,
          effective: payload.date,
          finalPicks: opt('--final', SEL.finalPicks),
          onLog: (m) => console.log('[cross]', m),
        })
      } catch (e) {
        console.warn(`[cross] ${chain} 裁决失败（忽略）：${e instanceof Error ? e.message : e}`)
      }
    }
  } else if (!dryRun) {
    // 当日新推荐"落库"：B / dual 在 B 日预写 actions（含 entryDefer + entryApproved），
    // 让 decideActions 立刻看到入口已批、放弃提前终止（臣服）。A / dual-A-day 不臣服，函数自动跳过。
    for (const chain of ['dual', 'A', 'B']) {
      try {
        const f = path.join(DATA_DIR, CHAIN_SUBDIR[chain] || 'recommend', `${payload.date}.json`)
        const p = await readJson(f, null)
        if (!p || !(p.top || []).length) continue
        await ensureEntryPositions(DATA_DIR, {
          chain,
          recDate: payload.date,
          basisDate: payload.basisDate,
          top: p.top,
          onLog: (m) => console.log('[entry]', m),
        })
      } catch (e) {
        console.warn(`[entry] ${chain} 落库失败（忽略）：${e instanceof Error ? e.message : e}`)
      }
    }
    for (const chain of ['dual', 'A', 'B']) {
      try {
        await decideActions(DATA_DIR, cfg, { chain, onLog: (m) => console.log('[exit]', m) })
      } catch (e) {
        console.warn(`[exit] ${chain} 决策失败（忽略）：${e instanceof Error ? e.message : e}`)
      }
    }
    // 交叉票联合裁决：同一只票既被提前终止、又进了当日推荐 → 一次 AI 二选一，保证不漏、不"既买又卖"。
    for (const chain of ['dual', 'A', 'B']) {
      try {
        await reconcileCross(DATA_DIR, cfg, {
          chain,
          effective: payload.date,
          finalPicks: opt('--final', SEL.finalPicks),
          onLog: (m) => console.log('[cross]', m),
        })
      } catch (e) {
        console.warn(`[cross] ${chain} 裁决失败（忽略）：${e instanceof Error ? e.message : e}`)
      }
    }
  }
  process.exit(0)
} catch (err) {
  console.error('[recommend] 失败：', err instanceof Error ? err.message : String(err))
  process.exit(1)
}
