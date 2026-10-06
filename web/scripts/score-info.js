// 用 LLM 给「个股×日」的资讯/公告打情绪分，按日落盘缓存。只喂 ≤ 当天的归目标题（无未来）。
//   node scripts/score-info.js --from 2026-07-01 --to 2026-08-31 [--force] [--all]
// 产物：DATA_DIR/info-sent/<YYYY-MM-DD>.json = { "<code>": { score, label, n } }
//
// 默认只给「当天客观初筛后的候选池」里、且有资讯的股票打分（省调用）；`--all` 给全universe打分。
import crypto from 'node:crypto'
import path from 'node:path'

import { DATA_DIR } from '../lib/scope.js'
import { aiConfig } from '../lib/settings.js'
import { streamChat, isOpenCode } from '../lib/llm.js'
import { readJson, writeJson } from '../lib/store.js'
import { cachedKline } from '../lib/kline-cache.js'
import { objectiveFilter, mapLimit } from '../lib/rank.js'
import { parseJsonLoose } from '../lib/recommend.js'
import { buildNameIndex, buildDailyInfo } from '../lib/news-factor.js'

const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf(n)
  return i >= 0 ? argv[i + 1] : d
}
const has = (f) => argv.includes(f)
const FROM = opt('--from', '2026-07-01')
const TO = opt('--to', '2026-08-31')
const FORCE = has('--force')
const ALL = has('--all')
const CONCURRENCY = Number(opt('--concurrency', 8)) || 8

const SYSTEM =
  '你是财经资讯情绪分析师。只依据给定的标题，判断它们对个股**短期（1-5 个交易日）股价**的综合影响。' +
  '只输出一个 JSON 对象，不要多余文字、不要代码块。'
const userMsg = (name, day, info) => {
  const ann = info.ann.slice(0, 6)
  const news = info.news.slice(0, 6)
  return (
    `股票：${name}\n日期：${day}\n` +
    (ann.length ? `相关公告：\n${ann.map((t) => `- ${t}`).join('\n')}\n` : '') +
    (news.length ? `相关新闻：\n${news.map((t) => `- ${t}`).join('\n')}\n` : '') +
    '\n综合以上，输出：{"score": -100到100的整数（正=偏利好，负=偏利空，0=中性或无关）, ' +
    '"label": "利好|利空|中性"}。只输出 JSON。'
  )
}

async function chatOnce(cfg, messages) {
  const r = await streamChat({
    config: cfg,
    messages,
    sessionId: crypto.randomUUID(),
    noThinking: isOpenCode(cfg.baseURL),
  })
  return r.text
}

async function loadUniverse() {
  const cached = await readJson(path.join(DATA_DIR, 'kline-cache', 'universe-stable.json'), null)
  if (Array.isArray(cached) && cached.length) return cached
  const { stablePool } = await import('../lib/rank.js')
  return (await stablePool()).map((x) => ({ secid: x.secid, code: x.code, name: x.name }))
}

const slice = (bars, D) => bars.filter((b) => b.time <= D)

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

async function main() {
  const cfg = await aiConfig(DATA_DIR)
  if (!cfg?.apiKey) {
    console.error('[score-info] AI 未配置 API Key')
    process.exit(1)
  }
  const universe = await loadUniverse()
  const nameIndex = buildNameIndex(universe)
  const nameOf = new Map(universe.map((s) => [s.code, s.name]))
  const allBars = new Map()
  if (!ALL) {
    console.log('[score-info] 载入日K（用于算候选池）…')
    const pairs = await mapLimit(universe, 12, async (s) => {
      const k = await cachedKline(s.secid).catch(() => null)
      return [s.secid, k?.bars || []]
    })
    for (const [secid, bars] of pairs) if (bars.length) allBars.set(secid, bars)
  }

  const days = []
  const d0 = new Date(`${FROM}T00:00:00Z`)
  const d1 = new Date(`${TO}T00:00:00Z`)
  for (let d = new Date(d0); d <= d1; d = new Date(d.getTime() + 86_400_000)) {
    const day = d.toISOString().slice(0, 10)
    if (new Date(`${day}T00:00:00Z`).getUTCDay() % 6 === 0) continue
    days.push(day)
  }

  let done = 0
  for (const day of days) {
    const outFile = path.join(DATA_DIR, 'info-sent', `${day}.json`)
    if (!FORCE && (await readJson(outFile, null))) {
      console.log(`[score-info] ${day} 已存在，跳过`)
      continue
    }
    const info = await buildDailyInfo(DATA_DIR, day, nameIndex)
    let targets = [...info.keys()]
    if (!ALL) {
      const pool = poolAt(universe, allBars, day)
      const filtered = await objectiveFilter(pool, {
        target: 200,
        kline: (secid) => ({ bars: slice(allBars.get(secid) || [], day) }),
      })
      const inPool = new Set(filtered.map((c) => c.code))
      targets = targets.filter((c) => inPool.has(c))
    }
    if (!targets.length) {
      await writeJson(outFile, {})
      console.log(`[score-info] ${day}: 0 只有资讯候选`)
      continue
    }
    const rows = await mapLimit(targets, CONCURRENCY, async (code) => {
      const e = info.get(code)
      const text = await chatOnce(cfg, [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userMsg(nameOf.get(code) || code, day, e) },
      ])
      const j = parseJsonLoose(text) || {}
      let score = Number(j.score)
      if (!Number.isFinite(score)) score = 0
      score = Math.max(-100, Math.min(100, Math.round(score)))
      return [code, { score, label: String(j.label || ''), n: e.ann.length + e.news.length }]
    })
    const out = {}
    for (const r of rows) if (r) out[r[0]] = r[1]
    await writeJson(outFile, out)
    done += 1
    console.log(`[score-info] ${day}: ${Object.keys(out).length} 只（累计 ${done} 天）`)
  }
  console.log('[score-info] 完成')
}

main().catch((e) => {
  console.error('[score-info] 失败：', e)
  process.exit(1)
})
