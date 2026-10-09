// 重刷 10 月：**不换选股**，只在该月既有推荐上"追加新筛选"（B 的 AI veto + 交叉票联合仲裁）。
//   node scripts/refresh-oct.js --dry-run          # 只算 B 的确定性因子排名（扩池），不写、不调 AI
//   node scripts/refresh-oct.js                     # 真正重刷（会重算 B 排名扩池 + 跑 AI veto/交叉）
//   node scripts/refresh-oct.js --from 2026-10-08 --to 2026-10-12
//
// 口径：
//   - B / dual(B 日)：按该生成日**重算 B 的确定性因子排名**（无 AI、无随机 → 与已存 top 同序，前 10 不变），
//     扩出更靠后的候选做回填池；再用新代码重跑（含 AI veto）并做交叉仲裁。选股逻辑/参数未改。
//   - A / dual(A 日)：**保留已存选中的股票**，只用其已存 candidates 做交叉仲裁，不重选。
//   - 交叉仲裁用当前 actions 里 exit.date==生效日 的记录（本就是按日记录的，逐日正确）。
import path from 'node:path'
import { DATA_DIR } from '../lib/scope.js'
import { aiConfig } from '../lib/settings.js'
import { readJson, writeJson } from '../lib/store.js'
import { cachedKline } from '../lib/kline-cache.js'
import { mapLimit, objectiveFilter } from '../lib/rank.js'
import { prevTradingDay, isTradingDay } from '../lib/trading-days.js'
import { objectiveConfig, selectConfig } from '../lib/model-config.js'
import { eventScores } from '../lib/ann-factor.js'
import { financeFactors } from '../lib/finance.js'
import {
  selectByFactors,
  resolveTilt,
  reconcileCross,
  nextTradingDay,
  BENCH_SECID,
} from '../lib/recommend.js'

const OBJ = objectiveConfig()
const SEL = selectConfig()

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (n, d) => (argv.indexOf(n) >= 0 ? argv[argv.indexOf(n) + 1] : d)
const FROM = val('--from', '2026-10-08')
const TO = val('--to', '2026-10-12')
const DRYRUN = has('--dry-run')
const VETO_POOL = Number(val('--pool-size', 40)) || 40

const sliceTo = (bars, D) => (Array.isArray(bars) ? bars.filter((b) => b.time <= D) : [])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  console.log(`[refresh-oct] 区间 ${FROM}~${TO}｜dry-run=${DRYRUN}`)
  const cfg = DRYRUN ? null : await aiConfig(DATA_DIR)
  if (!DRYRUN && !cfg?.apiKey) {
    console.error('[refresh-oct] AI 未配置 API Key → 无法做交叉仲裁（无 AI 会把交叉票全判为 sell）。中止，未改动任何文件。')
    process.exit(1)
  }
  // 用**已缓存的稳健宇宙**（避免走新浪网络挂起）：data/kline-cache/universe-stable.json
  const universe = await readJson(path.join(DATA_DIR, 'kline-cache', 'universe-stable.json'), null)
  if (!Array.isArray(universe) || !universe.length) throw new Error('缺少 universe-stable.json（请先跑一次 backtest）')
  console.log(`  稳健宇宙 ${universe.length} 只，载入日K…`)
  const klines = new Map()
  await mapLimit(universe, 12, async (s) => {
    const k = await cachedKline(s.secid).catch(() => null)
    if (k?.bars?.length) klines.set(s.secid, k.bars)
  })
  const allIdx = (await cachedKline(BENCH_SECID).catch(() => null))?.bars || []

  // 逐"生效日" E 处理（E 为交易日）
  const effs = []
  for (let d = FROM; d <= TO; d = nextTradingDay(d)) if (isTradingDay(d)) effs.push(d)
  console.log(`  生效日: ${effs.join(' ')}`)

  for (const E of effs) {
    const D = prevTradingDay(E)
    const idxBars = sliceTo(allIdx, D)
    const { tilt } = await resolveTilt({ indexBars: idxBars }, D)
    // 该日候选池：稳健宇宙在 D 的 价/额
    const pool = []
    for (const s of universe) {
      const bars = klines.get(s.secid)
      if (!bars) continue
      const at = [...bars].reverse().find((b) => b.time <= D)
      if (!at || at.close == null) continue
      pool.push({ secid: s.secid, code: s.code, name: s.name, price: at.close, changePct: at.changePct ?? null, amount: (at.volume || 0) * at.close })
    }
    const klineOf = async (secid) => {
      const b = klines.get(secid)
      return b ? { bars: sliceTo(b, D) } : null
    }
    const maxDev = OBJ.maxDeviation + tilt * ((Number(process.env.RECOMMEND_DEV_HI) || OBJ.devHi) - OBJ.maxDeviation)
    const filtered2 = await objectiveFilter(pool, { target: OBJ.target, maxDeviation: maxDev, kline: klineOf })
    const evtMapD = await eventScores(DATA_DIR, D, { windowDays: 5 }).catch(() => null)
    const rankedPro = await selectByFactors(filtered2, {
      kline: klineOf,
      finance: (secid) => financeFactors(secid, D, { dataDir: DATA_DIR }).catch(() => null),
      event: evtMapD ? (c) => evtMapD.get(c.code) ?? null : undefined,
      tilt,
      indexBars: idxBars,
      finalPicks: VETO_POOL,
      maxPerIndustry: SEL.maxPerIndustry,
    })
    const codes = rankedPro.map((c) => c.code)
    console.log(`\n[${E}] 生成日 ${D} tilt=${tilt.toFixed(2)}｜B 因子排名 ${codes.length} 只：${codes.slice(0, 15).join(' ')} …`)
    // 与已存 B payload 的 top 对比（应为前 10 一致）
    const existing = await readJson(path.join(DATA_DIR, 'recommend-factors-fwd', `${E}.json`), null)
    const et = (existing?.top || []).map((s) => s.code)
    const overlap = et.filter((c) => codes.includes(c)).length
    console.log(`  已存 B top10: ${et.join(' ')}｜与重算排名前10 重合 ${overlap}/10`)
    if (DRYRUN) continue

    // 扩池：写回 B 与（若当日 dual=B）dual 的 candidates
    const merged = [...(existing?.top || []), ...rankedPro]
    const seen = new Set()
    const cands = merged.filter((s) => s.code && !seen.has(s.code) && seen.add(s.code))
    for (const dir of ['recommend-factors-fwd', 'recommend']) {
      const f = path.join(DATA_DIR, dir, `${E}.json`)
      const j = await readJson(f, null)
      if (!j) continue
      const chain = dir === 'recommend' ? j.regime?.chain : 'B'
      if (chain !== 'B') continue // A 日用存量，不动
      j.candidates = cands
      await writeJson(f, j)
    }
    console.log(`  扩池：B(+dual) candidates 补到 ${cands.length} 只`)
    await sleep(200)
  }

  if (DRYRUN) {
    console.log('\n[refresh-oct] dry-run 完成（未写、未调 AI）')
    return
  }

  // 真正重刷：对 dual/A/B 各跑一遍交叉仲裁（B 的候选已在上面扩池）。
  for (const E of effs) {
    for (const chain of ['dual', 'A', 'B']) {
      try {
        await reconcileCross(DATA_DIR, cfg, { chain, effective: E, onLog: (m) => console.log('[cross]', m) })
      } catch (e) {
        console.warn(`[refresh-oct] ${chain}@${E} 交叉仲裁失败：${e instanceof Error ? e.message : e}`)
      }
    }
  }
  console.log('[refresh-oct] 完成')
}

main().catch((e) => {
  console.error('[refresh-oct] 失败：', e instanceof Error ? e.message : e)
  process.exit(1)
})
