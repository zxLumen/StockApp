// 重刷 10 月：**不换选股**，只在该月既有推荐上"追加新筛选"（B 的 AI veto + 交叉票联合仲裁）。
//   node scripts/refresh-oct.js --dry-run                 # 只打印每天 tilt/选链，不写、不调 AI
//   node scripts/refresh-oct.js                            # 真正重刷（B 按同参时点重跑：含 AI 解读+veto，回填票带 AI 周期）
//   node scripts/refresh-oct.js --from 2026-10-08 --to 2026-10-12
//
// 口径：
//   - B / dual(B 日)：按该生成日**同参时点重跑 runRecommendDaily（factors）**——确定性因子选股 + AI 解读 + veto，
//     产出带 AI 周期的完整 payload（回填票也有 holdDays/summary），再写回 B 与 dual。
//   - A / dual(A 日)：**保留已存选中的股票**（已含 AI 解读），不重选。
//   - 最后对 dual/A/B 逐日做交叉票联合仲裁。
import path from 'node:path'
import { DATA_DIR } from '../lib/scope.js'
import { aiConfig } from '../lib/settings.js'
import { readJson, writeJson } from '../lib/store.js'
import { cachedKline } from '../lib/kline-cache.js'
import { mapLimit } from '../lib/rank.js'
import { tiltThreshold, eventWindowDays } from '../lib/model-config.js'
import { prevTradingDay, isTradingDay } from '../lib/trading-days.js'
import { eventScores } from '../lib/ann-factor.js'
import {
  runRecommendDaily,
  resolveTilt,
  pickChain,
  reconcileCross,
  nextTradingDay,
  BENCH_SECID,
} from '../lib/recommend.js'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (n, d) => (argv.indexOf(n) >= 0 ? argv[argv.indexOf(n) + 1] : d)
const FROM = val('--from', '2026-10-08')
const TO = val('--to', '2026-10-12')
const DRYRUN = has('--dry-run')
const VETO_POOL = Number(val('--pool-size', 30)) || 30

const pad2 = (n) => String(n).padStart(2, '0')
const dateMinus = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d - n))
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`
}
const sliceTo = (bars, D) => (Array.isArray(bars) ? bars.filter((b) => b.time <= D) : [])

async function main() {
  console.log(`[refresh-oct] 区间 ${FROM}~${TO}｜dry-run=${DRYRUN}`)
  const cfg = DRYRUN ? null : await aiConfig(DATA_DIR)
  if (!DRYRUN && !cfg?.apiKey) {
    console.error('[refresh-oct] AI 未配置 API Key，中止（未改动任何文件）。')
    process.exit(1)
  }
  const universe = await readJson(path.join(DATA_DIR, 'kline-cache', 'universe-stable.json'), null)
  if (!Array.isArray(universe) || !universe.length) throw new Error('缺少 universe-stable.json（先跑一次 backtest）')
  const amountUniverse = (await readJson(path.join(DATA_DIR, 'kline-cache', 'universe-amount-10.json'), [])) || []
  const allSecids = new Map()
  for (const s of [...universe, ...amountUniverse]) if (s?.secid) allSecids.set(s.secid, s)
  console.log(`  稳健宇宙 ${universe.length} 只｜成交额池 ${amountUniverse.length} 只，载入日K…`)
  const klines = new Map()
  await mapLimit([...allSecids.values()], 12, async (s) => {
    const k = await cachedKline(s.secid).catch(() => null)
    if (k?.bars?.length) klines.set(s.secid, k.bars)
  })
  const allIdx = (await cachedKline(BENCH_SECID).catch(() => null))?.bars || []

  const effs = []
  for (let d = FROM; d <= TO; d = nextTradingDay(d)) if (isTradingDay(d)) effs.push(d)
  console.log(`  生效日: ${effs.join(' ')}`)

  for (const E of effs) {
    // 生成日 = E 的**前一交易日**（prevTradingDay 含自身，须先退回一天再对齐）。
    const D = prevTradingDay(dateMinus(E, 1))
    const idxBars = sliceTo(allIdx, D)
    const { tilt } = await resolveTilt({ indexBars: idxBars }, D)
    const chain = pickChain(tilt, tiltThreshold())
    console.log(`\n[${E}] 生成日 ${D} tilt=${tilt.toFixed(2)} → 当日选链 ${chain}`)
    if (DRYRUN) continue

    const klineOf = async (secid) => {
      const b = klines.get(secid)
      return b ? { bars: sliceTo(b, D) } : null
    }
    const dayNews = await readJson(path.join(DATA_DIR, 'news-archive', `${D}.json`), [])
    const newsFor = async (stock) => {
      const kw = [stock.name, stock.code].filter(Boolean)
      const hit = (dayNews || []).filter((x) => {
        const hay = `${x.title} ${x.summary || ''}`
        return kw.some((k) => k && k.length >= 2 && hay.includes(k))
      })
      return { items: hit.slice(0, 8) }
    }
    const evtMap = await eventScores(DATA_DIR, D, { windowDays: eventWindowDays() }).catch(() => null)
    const poolOf = (list) => {
      const out = []
      for (const s of list) {
        const bars = klines.get(s.secid)
        if (!bars) continue
        const at = [...bars].reverse().find((b) => b.time <= D)
        if (!at || at.close == null) continue
        out.push({ secid: s.secid, code: s.code, name: s.name, price: at.close, changePct: at.changePct ?? null, amount: (at.volume || 0) * at.close })
      }
      return out
    }
    const depsOf = (pool) => ({
      pool: async () => pool,
      kline: klineOf,
      news: newsFor,
      event: evtMap ? (c) => evtMap.get(c.code) ?? null : undefined,
      indexBars: idxBars,
      basisDate: D,
      effectiveDate: E,
    })

    if (chain === 'B') {
      const payloadB = await runRecommendDaily({
        dataDir: DATA_DIR,
        cfg,
        selectMode: 'factors',
        topCandidates: VETO_POOL,
        finalPicks: 10,
        interpretAi: true,
        outSubdir: 'recommend-factors-fwd',
        concurrency: 4,
        deps: depsOf(poolOf(universe)),
        onLog: (m) => console.log('[B]', m),
      })
      const bRegime = { tilt: Number(tilt.toFixed(4)), thr: tiltThreshold(), chain: 'B' }
      await writeJson(path.join(DATA_DIR, 'recommend-factors-fwd', `${E}.json`), { ...payloadB, regime: bRegime }) // 前瞻归档补 regime（与生产一致）
      await writeJson(path.join(DATA_DIR, 'recommend', `${E}.json`), { ...payloadB, regime: bRegime }) // 当日 dual = B
      console.log(`  ✓ B(+dual) 重跑完成：top ${payloadB.top.length} 只，候选 ${(payloadB.candidates || []).length}`)
    }

    // A：当日选链为 A，或已存 A payload 为空（历史某次解读全失败）→ 用成交额池重跑补齐。
    const aExist = await readJson(path.join(DATA_DIR, 'recommend-ai-fwd', `${E}.json`), null)
    if (chain === 'A' || !(aExist?.top || []).length) {
      const payloadA = await runRecommendDaily({
        dataDir: DATA_DIR,
        cfg,
        selectMode: 'ai',
        topCandidates: 100,
        finalPicks: 10,
        interpretAi: true,
        outSubdir: 'recommend-ai-fwd',
        concurrency: 4,
        deps: depsOf(poolOf(amountUniverse)),
        onLog: (m) => console.log('[A]', m),
      })
      const aRegime = { tilt: Number(tilt.toFixed(4)), thr: tiltThreshold(), chain: 'A' }
      await writeJson(path.join(DATA_DIR, 'recommend-ai-fwd', `${E}.json`), { ...payloadA, regime: aRegime }) // 前瞻归档补 regime
      if (chain === 'A') await writeJson(path.join(DATA_DIR, 'recommend', `${E}.json`), { ...payloadA, regime: aRegime }) // 当日 dual = A
      console.log(`  ✓ A 重跑完成：top ${payloadA.top.length} 只`)
    } else {
      console.log(`  A 已有数据（top ${(aExist.top || []).length}），保留不重选`)
    }
  }

  // 逐日交叉票联合仲裁（dual/A/B）
  for (const E of effs) {
    for (const chain of ['dual', 'A', 'B']) {
      try {
        await reconcileCross(DATA_DIR, cfg, { chain, effective: E, onLog: (m) => console.log('[cross]', m) })
      } catch (e) {
        console.warn(`[refresh-oct] ${chain}@${E} 交叉仲裁失败：${e instanceof Error ? e.message : e}`)
      }
    }
  }
  console.log('\n[refresh-oct] 完成')
}

main().catch((e) => {
  console.error('[refresh-oct] 失败：', e instanceof Error ? e.message : e)
  process.exit(1)
})
