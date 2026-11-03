// 新 B 选股（shadow）：候选权重 = 2025-07/08 网格最优 lowVol .3 + upShadow .4。
// 只读 universe/kline；写 /data/shadow/Btuned；不碰线上。
import fs from 'node:fs'
import path from 'node:path'
import { poolFromUniverse, objectiveFilter, mapLimit } from '../lib/rank.js'
import { computeFactors, compositeScores, DEFAULT_WEIGHTS } from '../lib/factors.js'
import { cachedKline } from '../lib/kline-cache.js'

const DATA = process.env.STOCK_DATA_DIR || '/data'
const argv = process.argv.slice(2)
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d }
const FORCE = argv.includes('--force')
const log = (m) => console.log(`[btuned] ${m}`)
const listDates = (dir) => {
  const abs = path.join(DATA, dir)
  if (!fs.existsSync(abs)) return []
  return fs.readdirSync(abs).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort()
}
const date = opt('--date', '') || listDates('shadow/dual').at(-1)
if (!date) { log('没有 shadow/dual 日期，退出'); process.exit(0) }
const dual = JSON.parse(fs.readFileSync(path.join(DATA, 'shadow/dual', `${date}.json`), 'utf8'))
const basisDate = dual.basisDate
if (!basisDate) { log('缺少 basisDate，退出'); process.exit(0) }
const outFile = path.join(DATA, 'shadow/Btuned', `${date}.json`)
if (fs.existsSync(outFile) && !FORCE) { log(`已存在 ${outFile}，跳过`); process.exit(0) }
log(`日期 ${date} basis ${basisDate}；计算候选权重…`)

const kline = (sid) => cachedKline(sid)
const universe = JSON.parse(fs.readFileSync(path.join(DATA, 'kline-cache/universe-stable.json'), 'utf8'))
const pool = await poolFromUniverse(universe, { basisDate, kline, onLog: log })
const filtered = await objectiveFilter(pool, { target: 200, kline, onLog: log })
const idxBars = (await kline('1.000300')).bars.filter((b) => b.time <= basisDate)
const idxClose = new Map(idxBars.map((b) => [b.time, b.close]))
const items = await mapLimit(filtered, 12, async (c) => {
  const bars = (await kline(c.secid))?.bars || []
  const cut = bars.filter((b) => b.time <= basisDate)
  if (cut.length < 21) return null
  const feat = computeFactors(cut, idxClose, null)
  return feat ? { ...c, feat } : null
})
const valid = items.filter(Boolean)
const Z = Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map((k) => [k, 0]))
const weights = { ...Z, lowVol: 0.3, upShadow: 0.4 }
const scores = compositeScores(valid.map((x) => x.feat), weights)
const top = valid.map((x, i) => ({ ...x, score: scores[i] })).sort((a, b) => b.score - a.score).slice(0, 10)
if (!top.length) { log('无有效候选，退出'); process.exit(0) }
const out = {
  version: 1, candidate: 'Btuned-lowVol.3-upShadow.4', chain: 'Btuned',
  date, basisDate, holdDays: null, source: 'weights:lowVol.3+upShadow.4 (2025-07/08 grid best)',
  generatedAt: new Date().toISOString(),
  top: top.map((t) => ({ secid: t.secid, code: t.code, name: t.name, price: t.price ?? null, aiHoldDays: null, holdDays: null, score: Number(t.score.toFixed(4)), sector: null })),
}
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`)
log(`写入 ${outFile}（候选 ${valid.length} → Top${top.length}）`)
