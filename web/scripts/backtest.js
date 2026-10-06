// 回测：用「历史某天为止的数据」按当前方案跑出那天的 Top10，写进 recommend/<生效日>.json
// （与实盘同格式，推荐页历史下拉即可查看）。
//   node scripts/backtest.js --days 30 [--concurrency 4] [--top 100] [--force]
//
// 口径：
//   - 候选宇宙 = 当前活跃股（约1000只，成交额 Top1000），逐只取日 K；
//   - 某天 D 的「成交额」用该日 volume×close 近似（新浪榜不可回溯），重排取前 500；
//   - K线/均线/涨幅/连板 全部截断到 D；资讯只取 ≤D 的归档（data/news-archive）；
//   - 生成日 = D，文件名 = D 的下一交易日（与实盘一致）；已存在则跳过（除非 --force）。
import path from 'node:path'
import { DATA_DIR } from '../lib/scope.js'
import { aiConfig } from '../lib/settings.js'
import { readJson, writeJson } from '../lib/store.js'
import { cachedKline } from '../lib/kline-cache.js'
import { fetchJson } from '../lib/http.js'
import { runRecommendDaily, nextTradingDay, bjDate, BENCH_SECID } from '../lib/recommend.js'
import { eventScores } from '../lib/ann-factor.js'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const opt = (n, d) => {
  const i = argv.indexOf(n)
  const v = i >= 0 ? Number(argv[i + 1]) : NaN
  return Number.isFinite(v) ? v : d
}
const DAYS = opt('--days', 30)
const CONCURRENCY = opt('--concurrency', 4)
const TOP = opt('--top', 100)
const FROM = (argv.indexOf('--from') >= 0 ? argv[argv.indexOf('--from') + 1] : '') || ''
const TO = (argv.indexOf('--to') >= 0 ? argv[argv.indexOf('--to') + 1] : '') || ''
const FORCE = has('--force')
const UNIVERSE_PAGES = opt('--universe', 10) // 每页100 → 1000 只
const POOL = (argv.indexOf('--pool') >= 0 ? argv[argv.indexOf('--pool') + 1] : '') || 'amount'
// 选股链路：'ai'=模型初筛+评分（旧）；'factors'=客观多因子（AI 只解读）。
const STRATEGY = (argv.indexOf('--strategy') >= 0 ? argv[argv.indexOf('--strategy') + 1] : '') || 'ai'
// 快速试错：跳过 AI 调用（需配 --strategy factors），买入评分留空、持有周期默认 5 日。
const BARE = has('--bare')
// 公告事件因子：回看窗口天数；`--no-event` 则完全不注入（作基线对照）。
const EVT_WINDOW = opt('--event-window', 5)
const NO_EVENT = has('--no-event')
// 产物子目录。**默认 recommend-bt，不是 recommend** —— 回测产物与实盘推荐同格式，
// 写进 recommend/ 会把真实推荐历史顶掉（推荐页历史下拉会混进回测结果）。
// 只有明确要覆盖 recommend 时才手工传 `--out recommend`。
const OUT = (argv.indexOf('--out') >= 0 ? argv[argv.indexOf('--out') + 1] : '') || 'recommend-bt'

const LIST_API =
  'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData'
const REFERER = { Referer: 'https://finance.sina.com.cn' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 候选宇宙：默认「成交额 Top N」；`--pool stable` 用沪深300+创业板+科创板成分。 */
async function loadUniverse() {
  // 成分/榜单接口在本地反复跑时会被新浪限流 → 结果落盘缓存，回测离线可复现。
  const cacheFile = path.join(
    DATA_DIR,
    'kline-cache',
    POOL === 'stable' ? 'universe-stable.json' : `universe-amount-${UNIVERSE_PAGES}.json`,
  )
  const cachedList = await readJson(cacheFile, null)
  if (Array.isArray(cachedList) && cachedList.length) return cachedList

  if (POOL === 'stable') {
    const { stablePool } = await import('../lib/rank.js')
    const list = (await stablePool()).map((x) => ({ secid: x.secid, code: x.code, name: x.name }))
    if (list.length) await writeJson(cacheFile, list).catch(() => {})
    return list
  }
  const out = []
  const seen = new Set()
  for (let p = 1; p <= UNIVERSE_PAGES; p += 1) {
    let rows
    try {
      rows = await fetchJson(`${LIST_API}?page=${p}&num=100&sort=amount&asc=0&node=hs_a&symbol=`, {
        headers: REFERER,
      })
    } catch {
      break
    }
    if (!Array.isArray(rows) || !rows.length) break
    for (const r of rows) {
      const m = /^(sh|sz)(\d{6})$/i.exec(String(r.symbol || ''))
      if (!m) continue
      const secid = `${m[1].toLowerCase() === 'sh' ? 1 : 0}.${m[2]}`
      if (seen.has(secid)) continue
      seen.add(secid)
      out.push({ secid, code: String(r.code || ''), name: String(r.name || '').trim() })
    }
    await sleep(150)
  }
  if (out.length) await writeJson(cacheFile, out).catch(() => {})
  return out
}

/** 逐只取全量日 K（近 ~260 根），缓存起来供各天切片（走磁盘缓存避免限流）。 */
async function loadKlines(universe, onLog) {
  const map = new Map()
  let done = 0
  const queue = universe.slice()
  const worker = async () => {
    for (;;) {
      const s = queue.shift()
      if (!s) return
      try {
        const k = await cachedKline(s.secid)
        if (k?.bars?.length) map.set(s.secid, k.bars)
      } catch {
        /* 单只失败忽略 */
      }
      done += 1
      if (done % 100 === 0) onLog(`  日K ${done}/${universe.length}`)
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker))
  return map
}

/** 某天的交易日列表（从基准股的日 K 日期集合里取，倒序取近 DAYS 天，不含今天）。
 *  给了 --from/--to 就取该区间。 */
function tradingDays(barsBySecid, days, from, to) {
  const set = new Set()
  for (const bars of barsBySecid.values()) for (const b of bars) set.add(b.time)
  const all = [...set].sort()
  if (from || to) {
    return all.filter((d) => (!from || d >= from) && (!to || d <= to))
  }
  const today = bjDate()
  return all.filter((d) => d < today).slice(-days)
}

/** 把 bars 截断到 ≤ asOf。未来的K线由 runRecommendDaily 入口统一断言（见 lib/recommend.js
 *  的 `klineOf` 包装）—— 之前这里在 `filter` 之后再查 `time > asOf`，永远不会触发，等于没检查。 */
function sliceBars(bars, asOf) {
  return bars.filter((b) => b.time <= asOf)
}

async function main() {
  const cfg = await aiConfig(DATA_DIR)
  if (BARE) {
    if (STRATEGY !== 'factors') {
      console.error('[backtest] --bare 只能配 --strategy factors')
      process.exit(1)
    }
  } else if (!cfg?.apiKey) {
    console.error('[backtest] AI 未配置 API Key（快速试错请加 --bare --strategy factors）')
    process.exit(1)
  }
  console.log(
    `[backtest] 近 ${DAYS} 天 | 并发 ${CONCURRENCY} | 每只精评 ${TOP} | 池 ${POOL} | 选股 ${STRATEGY}` +
      ` | 出 ${OUT}${BARE ? ' | bare(不调 AI)' : ` | 模型 ${cfg.model}`}`,
  )

  console.log('[backtest] 载入活跃股宇宙…')
  const universe = await loadUniverse()
  console.log(`  宇宙 ${universe.length} 只`)
  console.log('[backtest] 拉全量日K（用于切片）…')
  const klines = await loadKlines(universe, (m) => console.log('[backtest]', m))
  console.log(`  日K 覆盖 ${klines.size} 只`)
  // 沪深300 日K：供 regimeTilt 逐日判定市场状态（与 optimize-factors 同口径）。
  const idxBars = (await cachedKline(BENCH_SECID).catch(() => null))?.bars || []

  const days = tradingDays(klines, DAYS, FROM, TO)
  console.log(`[backtest] 回测交易日 ${days.length} 天：${days[0]} … ${days[days.length - 1]}`)
  console.log(`[backtest] 产物目录 ${DATA_DIR}/${OUT}/（评测请用 --dir ${OUT}）`)

  let n = 0
  for (const D of days) {
    n += 1
    const effective = nextTradingDay(D)
    const outFile = path.join(DATA_DIR, OUT, `${effective}.json`)
    if (!FORCE && (await readJson(outFile, null))) {
      console.log(`[backtest] (${n}/${days.length}) ${D} → ${effective} 已存在，跳过`)
      continue
    }
    const t0 = Date.now()
    console.log(`[backtest] (${n}/${days.length}) 回测 ${D}（生效日 ${effective}）…`)

    // 该天的候选池：宇宙股在 D 的成交额≈volume×close，取前 500
    const pool = []
    for (const s of universe) {
      const bars = klines.get(s.secid)
      if (!bars) continue
      const at = [...bars].reverse().find((b) => b.time <= D)
      if (!at || at.close == null) continue
      pool.push({
        secid: s.secid,
        code: s.code,
        name: s.name,
        price: at.close,
        changePct: at.changePct ?? null,
        amount: (at.volume || 0) * at.close, // 近似成交额
        turnover: null, // 历史拿不到
        mktcap: null,
        floatCap: null,
      })
    }
    pool.sort((a, b) => b.amount - a.amount)
    // stable 池本身已精选（1451 只），全用；amount 池取前 500
    const pool500 = POOL === 'stable' ? pool : pool.slice(0, 500)

    // 资讯归档（按天），回测时只取 ≤D
    const newsArchive = new Map()
    const loadNews = async (day) => {
      if (!newsArchive.has(day)) {
        newsArchive.set(day, await readJson(path.join(DATA_DIR, 'news-archive', `${day}.json`), []))
      }
      return newsArchive.get(day)
    }
    const newsFor = async (stock) => {
      // 简单起见：从「D 当天」归档里按个股名/代码匹配（够用，不做跨天累积）
      const dayNews = await loadNews(D)
      // 红线：归档资讯时间戳必须 ≤ 回测日 D（东财 time 为 epoch 毫秒）。
      const dayEnd = Date.parse(`${D}T23:59:59+08:00`)
      for (const x of dayNews || []) {
        if (x?.time && x.time > dayEnd) throw new Error(`未来数据泄漏：资讯 ${x.time} > ${D}`)
      }
      const kw = [stock.name, stock.code].filter(Boolean)
      const hit = (dayNews || []).filter((x) => {
        const hay = `${x.title} ${x.summary || ''}`
        return kw.some((k) => k && k.length >= 2 && hay.includes(k))
      })
      return { items: hit.slice(0, 8) }
    }

    // 公告事件净分（≤ D，回看 EVT_WINDOW 天）：只读 ann-archive，无未来数据。
    const evtMap = NO_EVENT
      ? null
      : await eventScores(DATA_DIR, D, { windowDays: EVT_WINDOW }).catch((e) => {
          console.warn(`[backtest]   ✗ ${D} 事件分计算失败：${e instanceof Error ? e.message : e}`)
          return null
        })

    try {
      await runRecommendDaily({
        dataDir: DATA_DIR,
        cfg,
        topCandidates: TOP,
        selectMode: STRATEGY,
        interpretAi: !BARE,
        outSubdir: OUT,
        concurrency: CONCURRENCY,
        deps: {
          pool: async () => pool500,
          kline: (secid) => {
            const bars = klines.get(secid)
            return bars ? { bars: sliceBars(bars, D) } : null
          },
          news: newsFor,
          event: evtMap ? (c) => evtMap.get(c.code) ?? null : undefined,
          // 指数切片 ≤ D：供 regimeTilt 判定市场状态（走强→动量倾斜）。截断防未来泄漏。
          indexBars: (idxBars ?? []).filter((b) => b.time <= D),
          basisDate: D,
          effectiveDate: effective,
        },
        onLog: (m) => console.log('[backtest]  ', m),
      })
      console.log(`[backtest]   ✓ ${D} 完成，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`)
    } catch (err) {
      console.error(`[backtest]   ✗ ${D} 失败：${err instanceof Error ? err.message : err}`)
    }
  }
  console.log('[backtest] 全部完成')
}

main().catch((e) => {
  console.error('[backtest] 致命错误：', e)
  process.exit(1)
})
