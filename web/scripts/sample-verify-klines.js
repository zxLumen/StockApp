// 抽样核对：均匀抽 N 只宇宙股票，把本地日K缓存与新浪接口逐条比对「日期 + 收盘价」。
//   node scripts/sample-verify-klines.js
//   node scripts/sample-verify-klines.js --n 20 --out ../docs/runs/KLINE-SAMPLE-2026-11-15.md
//
// 直接打新浪接口，不经过 lib/http 的进程内缓存，避免拿缓存自证。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DATA_DIR } from '../lib/scope.js'

const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf(n)
  const v = i >= 0 ? Number(argv[i + 1]) : NaN
  return Number.isFinite(v) ? v : d
}
const N = opt('--n', 20)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = path.resolve(ROOT, (() => {
  const i = argv.indexOf('--out')
  return i >= 0 && argv[i + 1] ? argv[i + 1] : 'docs/runs/KLINE-SAMPLE-2026-11-15.md'
})())
const DIR = path.join(DATA_DIR, 'kline-cache')
const HOST = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData'

const readJson = (f, d = null) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return d
  }
}
const day = (t) => String(t || '').slice(0, 10)
const toSinaCode = (secid) => {
  const [m, code = ''] = String(secid).split('.')
  if (m === '1') return `sh${code}`
  if (m === '0') return `sz${code}`
  return null
}

const universe = new Map()
for (const f of ['universe-stable.json', 'universe-amount-10.json']) {
  for (const x of readJson(path.join(DIR, f), [])) if (x?.secid) universe.set(x.secid, x.name || '')
}
const secids = [...universe.keys()].filter((s) => toSinaCode(s)).sort()
if (!secids.length) throw new Error('宇宙为空')
const usable = secids.filter((s) => (readJson(path.join(DIR, `${s}.json`), {})?.bars?.length || 0) >= 1000)
const pool = usable.length >= N ? usable : secids
const step = Math.max(1, Math.floor(pool.length / N))
const sample = []
for (let i = 0; i < N; i += 1) {
  const s = pool[Math.min(pool.length - 1, i * step)]
  if (!sample.includes(s)) sample.push(s)
}

const rows = []
let totalCompared = 0
let totalMismatch = 0
for (const secid of sample) {
  const local = readJson(path.join(DIR, `${secid}.json`), {})
  const localBars = local?.bars || []
  const url = `${HOST}?symbol=${encodeURIComponent(toSinaCode(secid))}&scale=240&ma=no&datalen=1023`
  const res = await fetch(url, { headers: { Referer: 'https://finance.sina.com.cn' } })
  if (!res.ok) throw new Error(`${secid} 新浪 HTTP ${res.status}`)
  const remote = await res.json()
  const remoteBars = (Array.isArray(remote) ? remote : []).map((b) => ({ t: day(b.day), c: Number(b.close) }))
  const byDate = new Map(remoteBars.map((b) => [b.t, b.c]))
  let mismatch = 0
  const samples = []
  for (const b of localBars) {
    const t = day(b.time)
    const c = Number(b.close)
    const rc = byDate.get(t)
    if (rc === undefined) {
      mismatch += 1
      if (samples.length < 3) samples.push(`${t} 新浪无此日`)
      continue
    }
    if (rc !== c) {
      mismatch += 1
      if (samples.length < 3) samples.push(`${t} 本地 ${c} ≠ 新浪 ${rc}`)
    }
  }
  // 新浪有、本地无（只比本地首末日之间，避免把“新浪更早的历史”算成本地缺失）
  const localSet = new Set(localBars.map((x) => day(x.time)))
  const first = day(localBars[0]?.time)
  const last = day(localBars.at(-1)?.time)
  const remoteOnly = remoteBars.filter((b) => b.t >= first && b.t <= last && !localSet.has(b.t)).length
  if (remoteOnly) {
    mismatch += remoteOnly
    if (samples.length < 3) samples.push(`新浪多 ${remoteOnly} 根`)
  }
  totalCompared += localBars.length
  totalMismatch += mismatch
  rows.push({
    secid,
    name: universe.get(secid) || '',
    bars: localBars.length,
    first: day(localBars[0]?.time),
    last: day(localBars.at(-1)?.time),
    mismatch,
    samples,
  })
  console.log(`[verify] ${secid} ${universe.get(secid) || ''} ${localBars.length} 根，差异 ${mismatch}`)
  await new Promise((r) => setTimeout(r, 200))
}

const lines = []
lines.push('# 日K缓存抽样核对（2026-11-15）', '')
lines.push(`- 抽样方式：宇宙并集中 bars≥1000 的 ${pool.length} 只按 secid 排序后等距抽 ${rows.length} 只`)
lines.push(`- 核对口径：新浪 \`CN_MarketData.getKLineData\`（scale=240, datalen=1023）逐条比对**日期 + 收盘价**，不走本地 HTTP 缓存`)
lines.push(`- 结果：共比对 **${totalCompared}** 条，差异 **${totalMismatch}** 条`)
lines.push('', '| # | secid | 名称 | 本地 bars | 首日 | 末日 | 比对条数 | 差异 | 差异样例 |')
lines.push('| ---: | --- | --- | ---: | --- | --- | ---: | ---: | --- |')
rows.forEach((r, i) => {
  lines.push(`| ${i + 1} | ${r.secid} | ${r.name} | ${r.bars} | ${r.first} | ${r.last} | ${r.bars} | ${r.mismatch} | ${r.samples.join('；') || '—'} |`)
})
lines.push('')
lines.push(`**结论：${totalMismatch === 0 ? '0 差异，通过' : `${totalMismatch} 条差异，未通过`}。**`)
lines.push('')

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, lines.join('\n'))
fs.writeFileSync(OUT.replace(/\.md$/, '.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), compared: totalCompared, mismatch: totalMismatch, rows }, null, 2)}\n`)
console.log(`[verify] 合计 ${totalCompared} 条，差异 ${totalMismatch}；写出 ${path.relative(ROOT, OUT)}`)
if (totalMismatch) process.exitCode = 1
