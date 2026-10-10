// LLM 逐股打分（选股信号）：逐日取「因子 TopK」，对每只用点时上下文调 LLM，输出 buyScore。
//   node scripts/score-candidates.js --from 2026-07-01 --to 2026-08-31 [--k 30] [--force] [--concurrency 6]
// 产物：DATA_DIR/llm-rank/<day>.json = { "<code>": { buyScore, holdDays, factorScore } }
//
// 无未来数据：K线/财务/公告/新闻全部只用 ≤ 当日 D 的归档；LLM 只喂这些。
import crypto from 'node:crypto'
import path from 'node:path'

import { DATA_DIR } from '../lib/scope.js'
import { aiConfig } from '../lib/settings.js'
import { streamChat } from '../lib/llm.js'
import { readJson, writeJson } from '../lib/store.js'
import { cachedKline } from '../lib/kline-cache.js'
import { objectiveFilter, mapLimit } from '../lib/rank.js'
import {
  selectByFactors,
  stockContext,
  parseJsonLoose,
  INTERPRET_SYSTEM,
  interpretUser,
  BENCH_SECID,
} from '../lib/recommend.js'
import { financeFactors } from '../lib/finance.js'
import { regimeTilt } from '../lib/factors.js'
import { eventWindowDays } from '../lib/model-config.js'
import { eventScores } from '../lib/ann-factor.js'
import { buildNameIndex, buildDailyInfo } from '../lib/news-factor.js'

const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf(n)
  const v = i >= 0 ? Number(argv[i + 1]) : NaN
  return Number.isFinite(v) ? v : d
}
const has = (f) => argv.includes(f)
const FROM = has('--from') ? argv[argv.indexOf('--from') + 1] : '2026-07-01'
const TO = has('--to') ? argv[argv.indexOf('--to') + 1] : '2026-08-31'
const K = opt('--k', 30)
const CONCURRENCY = opt('--concurrency', 6)
const FORCE = has('--force')
// `--regime`：用 regime 条件化 prompt（上涨市评趋势延续、下跌市评超跌反转），输出到独立目录。
const REGIME = has('--regime')
const OUTDIR = has('--out') ? argv[argv.indexOf('--out') + 1] : REGIME ? 'llm-rank-regime' : 'llm-rank'
const INDEX = '1.000300'
const DEV_LO = Number(process.env.RECOMMEND_DEV_LO) || 15
const DEV_HI = Number(process.env.RECOMMEND_DEV_HI) || 40

const slice = (bars, D) => bars.filter((b) => b.time <= D)

async function chatOnce(cfg, messages) {
  const r = await streamChat({
    config: cfg,
    messages,
    sessionId: crypto.randomUUID(),
    noThinking: true,
  })
  return r.text
}

async function loadUniverse() {
  const cached = await readJson(path.join(DATA_DIR, 'kline-cache', 'universe-stable.json'), null)
  if (Array.isArray(cached) && cached.length) return cached
  const { stablePool } = await import('../lib/rank.js')
  return (await stablePool()).map((x) => ({ secid: x.secid, code: x.code, name: x.name }))
}

function poolAt(universe, allBars, D) {
  const pool = []
  for (const s of universe) {
    const bars = allBars.get(s.secid)
    if (!bars) continue
    const at = [...bars].reverse().find((b) => b.time <= D)
    if (!at || at.close == null) continue
    pool.push({
      secid: s.secid,
      code: s.code,
      name: s.name,
      price: at.close,
      changePct: at.changePct ?? null,
      amount: (at.volume || 0) * at.close,
      turnover: null,
      mktcap: null,
      floatCap: null,
    })
  }
  pool.sort((a, b) => b.amount - a.amount)
  return pool
}

/** 市场状态块：把 regime 明确喂给 LLM，并按其分档给出评分导向。 */
function regimeBlock(tilt, idxBars, D) {
  const b = idxBars.filter((x) => x.time <= D)
  const n = b.length
  const closes = b.map((x) => x.close)
  const ma20 = n >= 20 ? closes.slice(-20).reduce((a, c) => a + c, 0) / 20 : null
  const mom20 = n >= 21 && closes[n - 21] ? closes[n - 1] / closes[n - 21] - 1 : null
  const above = ma20 != null ? closes[n - 1] > ma20 : null
  const state = tilt >= 0.6 ? '上涨/强势市' : tilt <= 0.33 ? '下跌/弱势市' : '震荡市'
  const guide =
    tilt >= 0.6
      ? '重点评估**趋势延续与弹性**（相对强度、量能、题材催化、是否领涨）；不要因为「偏离 MA20 较高」或「近5日涨幅较大」就一味扣分——强势市里强者恒强。'
      : tilt <= 0.33
        ? '重点评估**超跌反转与防御性**（缩量回踩、支撑位、低估值、业绩确定性）；回避趋势破位与高位补跌股。'
        : '兼顾超跌反转与趋势，控制追高风险。'
  return (
    `\n\n市场状态：${state}（tilt=${tilt.toFixed(2)}，指数近20日 ${mom20 == null ? 'NA' : (mom20 * 100).toFixed(1) + '%'}，${above == null ? 'NA' : above ? '站上' : '低于'} MA20）。\n` +
    `评分导向（当前市场状态）：${guide}\n`
  )
}

/** regime 条件化的用户消息（不复用写死「追高扣分」的 interpretUser）。 */
function regimeUser(ctx) {
  return (
    `以下是某只 A 股的行情、资讯与市场状态：\n\n${ctx}\n\n` +
    '请从「**当前价位是否值得买入**」的角度，结合**当前市场状态**综合判断，只输出 JSON、不要解释：\n' +
    '{\n' +
    ' "buyScore": 0到100的整数（100=现在买很值得，0=完全不值得/应回避）,\n' +
    ' "holdDays": 建议持有交易日数，必须是 3 / 5 / 10 / 20 之一,\n' +
    ' "summary": "一句话概括，40到60字",\n' +
    ' "catalysts": ["支撑逻辑，3到5条"],\n' +
    ' "risks": ["风险，2到3条"],\n' +
    ' "tags": ["题材或风格标签，3到5个"]\n' +
    '}\n' +
    '要求：评分必须拉开区分度（好买点 70-90，勉强 45-55，回避 0-40）；上涨市给强势/领涨股高分，下跌市给超跌反转/防御股高分。'
  )
}

async function main() {
  const cfg = await aiConfig(DATA_DIR)
  if (!cfg?.apiKey) {
    console.error('[score-candidates] AI 未配置 API Key')
    process.exit(1)
  }
  console.log(`[score-candidates] ${FROM} ~ ${TO} | TopK=${K} | 输出 ${OUTDIR} | ${REGIME ? 'regime prompt' : 'default prompt'} | 模型 ${cfg.model}`)
  const universe = await loadUniverse()
  const nameIndex = buildNameIndex(universe)
  const pairs = await mapLimit(universe, 12, async (s) => {
    const k = await cachedKline(s.secid).catch(() => null)
    return [s.secid, k?.bars || []]
  })
  const allBars = new Map(pairs.filter(([, b]) => b.length))
  const idxBars = (await cachedKline(INDEX).catch(() => null))?.bars || []
  const union = [...new Set([...allBars.values()].flatMap((bars) => bars.map((b) => b.time)))].sort()
  const days = union.filter((d) => d >= FROM && d <= TO)
  console.log(`[score-candidates] ${days.length} 个交易日`)

  let done = 0
  for (const D of days) {
    const outFile = path.join(DATA_DIR, OUTDIR, `${D}.json`)
    if (!FORCE && (await readJson(outFile, null))) {
      console.log(`[score-candidates] ${D} 已存在，跳过`)
      continue
    }
    const tilt = regimeTilt(idxBars.filter((b) => b.time <= D))
    const evtMap = await eventScores(DATA_DIR, D, { windowDays: eventWindowDays() }).catch(() => null)
    const info = await buildDailyInfo(DATA_DIR, D, nameIndex).catch(() => new Map())
    const klineOf = (secid) => ({ bars: slice(allBars.get(secid) || [], D) })
    const newsFor = (s) => {
      const e = info.get(s.code)
      return { items: (e?.news || []).slice(0, 8).map((t) => ({ title: t })) }
    }
    const pool = poolAt(universe, allBars, D)
    const maxDeviation = DEV_LO + tilt * (DEV_HI - DEV_LO)
    const filtered = await objectiveFilter(pool, { target: 200, kline: klineOf, maxDeviation })
    const candidates = await selectByFactors(filtered, {
      kline: klineOf,
      finance: (secid) => financeFactors(secid, D, { dataDir: DATA_DIR }).catch(() => null),
      event: evtMap ? (c) => evtMap.get(c.code) ?? null : undefined,
      tilt,
      indexBars: idxBars.filter((b) => b.time <= D),
      finalPicks: K,
      onLog: () => {},
    })

    const rows = await mapLimit(candidates, CONCURRENCY, async (c) => {
      const ctx0 = await stockContext(c, { kline: (s) => klineOf(s.secid), news: newsFor })
      const f = c.feat || {}
      const ann = (info.get(c.code)?.ann || []).slice(0, 6)
      const extra = [
        '',
        `因子分：${c.factorScore}  年化ROE：${fmtN(f.roeAnnual)}%  营收同比：${fmtN(f.revYoy)}%  净利同比：${fmtN(f.profitYoy)}%  毛利率：${fmtN(f.grossMargin)}%`,
        `公告事件净分：${fmtN(f.event, 0)}（正=利好/负=利空）  市场状态 tilt=${tilt.toFixed(2)}（0=弱市反转,1=强市动量）`,
        ...(ann.length ? ['近期相关公告：', ...ann.map((t, i) => `${i + 1}. ${t}`)] : []),
      ].join('\n')
      let buyScore = null
      let holdDays = null
      const userContent = REGIME
        ? regimeUser(ctx0 + extra + regimeBlock(tilt, idxBars, D))
        : interpretUser(ctx0 + extra)
      try {
        const text = await chatOnce(cfg, [
          { role: 'system', content: INTERPRET_SYSTEM },
          { role: 'user', content: userContent },
        ])
        const j = parseJsonLoose(text) || {}
        const s = Number(j.buyScore)
        buyScore = Number.isFinite(s) ? Math.max(0, Math.min(100, Math.round(s))) : null
        holdDays = Number.isFinite(Number(j.holdDays)) ? Number(j.holdDays) : null
      } catch (e) {
        console.warn(`  [${D}] ${c.code} LLM 失败：${e instanceof Error ? e.message : e}`)
      }
      return [c.code, { buyScore, holdDays, factorScore: c.factorScore }]
    })
    const out = {}
    for (const r of rows) if (r) out[r[0]] = r[1]
    await writeJson(outFile, out)
    done += 1
    const nOk = Object.values(out).filter((v) => v.buyScore != null).length
    console.log(`[score-candidates] ${D}: ${Object.keys(out).length} 只（成功 ${nOk}，累计 ${done} 天）`)
  }
  console.log('[score-candidates] 完成')
}

function fmtN(v, d = 1) {
  return v == null || !Number.isFinite(Number(v)) ? 'NA' : Number(v).toFixed(d)
}

main().catch((e) => {
  console.error('[score-candidates] 失败：', e)
  process.exit(1)
})
