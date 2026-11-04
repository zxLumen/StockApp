// 实验室独立选股（不读线上选股）：labA=hs300 质量/低波/价值；labB=稳健池 动量。
// 只读 universe/kline/finance；写 /data/lab/{A,B}/<生效日>.json；不碰线上。
import fs from 'node:fs'
import path from 'node:path'
import { poolFromUniverse, objectiveFilter, mapLimit, stablePool } from '../lib/rank.js'
import { computeFactors, compositeScores, DEFAULT_WEIGHTS } from '../lib/factors.js'
import { cachedKline } from '../lib/kline-cache.js'
import { financeFactors } from '../lib/finance.js'

const DATA = process.env.STOCK_DATA_DIR || '/data'
const argv = process.argv.slice(2)
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d }
const FORCE = argv.includes('--force')
const SOURCE = opt('--source', 'labB')
const log = (m) => console.log(`[lab] ${m}`)
const liveDates = fs.readdirSync(path.join(DATA, 'recommend')).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()
const date = opt('--date', '') || liveDates.at(-1)
if (!date) { log('没有线上生效日'); process.exit(0) }
const live = JSON.parse(fs.readFileSync(path.join(DATA, 'recommend', `${date}.json`), 'utf8'))
const basisDate = live.basisDate || date
const outFile = path.join(DATA, 'lab', SOURCE === 'labA' ? 'A' : 'B', `${date}.json`)
if (fs.existsSync(outFile) && !FORCE) { log(`已存在 ${outFile}，跳过`); process.exit(0) }
const kline = (sid) => cachedKline(sid)
const idxBars = ((await cachedKline('1.000300')).bars || []).filter((b) => b.time <= basisDate)
const idxClose = new Map(idxBars.map((b) => [b.time, b.close]))
const Z = Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map((k) => [k, 0]))

async function select({ universe, weights, useFinance }) {
  const pool = await poolFromUniverse(universe, { basisDate, kline, onLog: log })
  const filtered = await objectiveFilter(pool, { target: 200, kline, onLog: log })
  const items = await mapLimit(filtered, 12, async (c) => {
    const bars = (await kline(c.secid))?.bars || []
    const cut = bars.filter((b) => b.time <= basisDate)
    if (cut.length < 21) return null
    let fin = null
    if (useFinance) { try { fin = await financeFactors(c.secid, basisDate, { dataDir: DATA }) } catch { fin = null } }
    const feat = computeFactors(cut, idxClose, fin)
    return feat ? { ...c, feat } : null
  })
  const valid = items.filter(Boolean)
  const scores = compositeScores(valid.map((x) => x.feat), weights)
  return valid.map((x, i) => ({ ...x, score: Number(scores[i].toFixed(4)) })).sort((a, b) => b.score - a.score).slice(0, 10)
}

let top = []
if (SOURCE === 'labB') {
  const universe = JSON.parse(fs.readFileSync(path.join(DATA, 'kline-cache/universe-stable.json'), 'utf8'))
  log(`labB 稳健池 ${universe.length} 只；动量权重`)
  top = await select({ universe, weights: { ...Z, reversal: 0.4, midRev: 0.2, lowVol: 0.2, tilt: 1 }, useFinance: false })
} else {
  const uf = path.join(DATA, 'lab/universe-hs300.json')
  let universe = null
  if (fs.existsSync(uf)) { try { universe = JSON.parse(fs.readFileSync(uf, 'utf8')) } catch {} }
  if (!universe?.length) {
    log('拉取沪深300成分…')
    universe = await stablePool({ nodes: ['hs300'] })
    fs.mkdirSync(path.dirname(uf), { recursive: true })
    fs.writeFileSync(uf, JSON.stringify(universe))
  }
  log(`labA 沪深300 ${universe.length} 只；质量/低波/价值权重`)
  top = await select({ universe, weights: { ...Z, lowVol: 0.4, q: 0.3, ep: 0.2, ivol: 0.1 }, useFinance: true })
}
if (!top.length) { log('无候选'); process.exit(0) }
const out = {
  version: 1, candidate: SOURCE === 'labA' ? 'labA-quant-v1' : 'labB-mom-v1', chain: SOURCE,
  date, basisDate, holdDays: null,
  rule: SOURCE === 'labA' ? 'hs300 + lowVol.4+q.3+ep.2+ivol.1' : 'stable + momentum (reversal/midRev tilt=1) + lowVol.2',
  generatedAt: new Date().toISOString(),
  top: top.map((t) => ({ secid: t.secid, code: t.code, name: t.name, price: t.price ?? null, aiHoldDays: null, holdDays: null, score: t.score, sector: null })),
}
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`)
log(`写入 ${outFile}（Top${top.length}）`)
