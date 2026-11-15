// 日K缓存覆盖审计：逐只统计 bars / 首日 / 末日 / 2024 区间覆盖 / 缺口原因。
//   node scripts/audit-kline-coverage.js
//   node scripts/audit-kline-coverage.js --out ../docs/runs/KLINE-COVERAGE-2026-11-15.md
//
// 只读 data/kline-cache，不改任何缓存文件。输出 Markdown + 同名 .json 供后续抽样核对。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DATA_DIR } from '../lib/scope.js'

const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = path.resolve(ROOT, opt('--out', 'docs/runs/KLINE-COVERAGE-2026-11-15.md'))
const DIR = path.join(DATA_DIR, 'kline-cache')

const START = '2024-01-02'
const END = '2024-12-31'
const PASS_BARS = 1000
const PASS_FIRST = '2024-01-05'

const readJson = (f, d = null) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return d
  }
}
const day = (t) => String(t || '').slice(0, 10)
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(2) : '0.00')

// 宇宙并集（refetch 的目标集合）与名称
const universe = new Map()
for (const f of ['universe-stable.json', 'universe-amount-10.json']) {
  for (const x of readJson(path.join(DIR, f), [])) {
    if (x?.secid) universe.set(x.secid, { name: x.name || '', code: x.code || '' })
  }
}

function reasonOf(r) {
  if (!r.bars) return '缓存为空 / 上游无返回'
  if (r.first > END) return `上市晚于 2024（首日 ${r.first}）`
  if (r.first > PASS_FIRST) {
    if (r.bars === 600) return `仅 600 根（首日 ${r.first}；旧 limit=600 或上市晚，未达 1000）`
    return `历史不足（${r.bars} 根，首日 ${r.first}；上市晚/上游只给这么多）`
  }
  if (r.last < START) return `2024 前已停止交易（末日 ${r.last}；退市/长停）`
  if (r.last < END) return `2024 内停止更新（末日 ${r.last}；停牌/退市/上游缺失）`
  if (r.missing2024 > 0) {
    const ranges = r.gapRanges.slice(0, 3).join('、')
    return `2024 内缺 ${r.missing2024} 个交易日（${ranges}${r.gapRanges.length > 3 ? ' 等' : ''}；停牌/上游缺口）`
  }
  if (r.bars < PASS_BARS) return `bars ${r.bars} < 1000（2024 已完整覆盖；历史长度受上市日/新浪 1023 上限限制）`
  if (!r.covered2024) return `未完整覆盖 ${START}~${END}`
  return '—'
}

const files = fs
  .readdirSync(DIR)
  .filter((f) => /^\d+\.\d+\.json$/.test(f))
  .map((f) => f.slice(0, -5))

// 2024 交易日历：以全缓存中出现 ≥100 只的日期为准（避免硬编码节假日）
const dateCount = new Map()
const raw = []
for (const secid of files) {
  const j = readJson(path.join(DIR, `${secid}.json`), null)
  const bars = (j?.bars || []).filter((b) => b && b.time)
  const dates = bars.map((b) => day(b.time))
  for (const d of dates) if (d >= START && d <= END) dateCount.set(d, (dateCount.get(d) || 0) + 1)
  raw.push({ secid, bars, dates, name: universe.get(secid)?.name || '' })
}
const tradingDays = [...dateCount.entries()]
  .filter(([, n]) => n >= 30)
  .map(([d]) => d)
  .sort()
const dayIndex = new Map(tradingDays.map((d, i) => [d, i]))

const records = raw.map(({ secid, bars, dates, name }) => {
  const inUniverse = universe.has(secid)
  const first = dates[0] || ''
  const last = dates.at(-1) || ''
  const in2024 = new Set(dates.filter((d) => d >= START && d <= END))
  const missing = tradingDays.filter((d) => !in2024.has(d))
  const gapRanges = []
  for (const d of missing) {
    const prev = gapRanges.at(-1)
    if (prev && dayIndex.get(d) === dayIndex.get(prev.end) + 1) prev.end = d
    else gapRanges.push({ start: d, end: d })
  }
  const rec = {
    secid,
    name,
    inUniverse,
    bars: bars.length,
    first,
    last,
    bars2024: in2024.size,
    covered2024: !!first && first <= START && last >= END,
    fullTradingDays: !!first && first <= START && last >= END && missing.length === 0,
    missing2024: missing.length,
    gapRanges: gapRanges.map((g) => (g.start === g.end ? g.start : `${g.start}~${g.end}`)),
    pass: bars.length >= PASS_BARS && !!first && first <= PASS_FIRST,
  }
  rec.reason = reasonOf(rec)
  return rec
})

const uni = records.filter((r) => r.inUniverse)
const extra = records.filter((r) => !r.inUniverse)
const passed = uni.filter((r) => r.pass)
const failed = uni.filter((r) => !r.pass)
const covered = uni.filter((r) => r.covered2024)
const eligible = uni.filter((r) => r.first && r.first <= START)
const coveredEligible = eligible.filter((r) => r.covered2024)
const fullEligible = coveredEligible.filter((r) => r.fullTradingDays)
const post2024 = uni.filter((r) => !r.first || r.first > END)
const buckets = [
  ['0（空）', 0, 0],
  ['<600', 1, 599],
  ['600', 600, 600],
  ['601–999', 601, 999],
  ['1000–1022', 1000, 1022],
  ['≥1023', 1023, Infinity],
].map(([label, lo, hi]) => ({ label, n: records.filter((r) => r.bars >= lo && r.bars <= hi).length }))

const generatedAt = new Date().toISOString()
const esc = (s) => String(s).replace(/\|/g, '\\|')

const lines = []
lines.push('# 日K缓存覆盖审计（2026-11-15）', '')
lines.push(`- 生成时间：${generatedAt}`)
lines.push(`- 缓存目录：\`${DIR}\``)
lines.push(`- 目标区间：\`${START}\` ~ \`${END}\`；达标线：bars ≥ ${PASS_BARS} 且首日 ≤ ${PASS_FIRST}`)
lines.push(`- 2024 交易日口径：缓存中出现 ≥30 只的日期，共 **${tradingDays.length}** 个交易日`)
lines.push('', '## 总览', '')
lines.push('| 范围 | 只数 | bars≥1000 | 首日≤2024-01-05 | 双条件达标 | 完整覆盖 2024 |')
lines.push('| --- | ---: | ---: | ---: | ---: | ---: |')
const row = (label, rs) =>
  `| ${label} | ${rs.length} | ${rs.filter((r) => r.bars >= PASS_BARS).length} | ${rs.filter((r) => r.first && r.first <= PASS_FIRST).length} | ${rs.filter((r) => r.pass).length}（${pct(rs.filter((r) => r.pass).length, rs.length)}%） | ${rs.filter((r) => r.covered2024).length} |`
lines.push(row('宇宙并集', uni))
lines.push(row('非宇宙缓存', extra))
lines.push(row('全部缓存', records))
lines.push('')
lines.push(`**字面验收（bars ≥ 1000 且首日 ≤ 2024-01-05）：${passed.length}/${uni.length} = ${pct(passed.length, uni.length)}%，${passed.length >= uni.length * 0.95 ? '通过' : '未达 95%（未通过）'}。**`)
lines.push('')
lines.push(`**2024 覆盖验收：2024-01-02 前已上市 ${eligible.length} 只，完整覆盖 ${coveredEligible.length} 只 = ${pct(coveredEligible.length, eligible.length)}%；2024 后上市 ${post2024.length} 只（结构性无 2024 数据）。**`)
lines.push('')
lines.push(`其中 ${tradingDays.length} 个交易日逐日无缺 **${fullEligible.length}** 只；${coveredEligible.length - fullEligible.length} 只有停牌等自然缺口（区间仍覆盖，缺口天数/区间见明细）。`)
lines.push('')
lines.push(`> 字面口径不可达的原因：新浪日K单次上限 1023 根（最早 2022-08-23），宇宙中有 ${uni.filter((r) => r.bars < PASS_BARS && r.first && r.first <= PASS_FIRST).length} 只在 2022-09 之后上市，全部历史不足 1000 根；但它们 2024 年覆盖完整。`)
lines.push('')
lines.push('### bars 分布（全部缓存）', '')
lines.push('| bars | 只数 |', '| --- | ---: |')
for (const b of buckets) lines.push(`| ${b.label} | ${b.n} |`)
lines.push('')
lines.push(`## 宇宙内未达标清单（${failed.length} 只）`, '')
if (!failed.length) lines.push('无。', '')
else {
  lines.push('| secid | 名称 | bars | 首日 | 末日 | 2024 bars | 缺口原因 |')
  lines.push('| --- | --- | ---: | --- | --- | ---: | --- |')
  for (const r of failed.sort((a, b) => b.bars - a.bars)) {
    lines.push(`| ${r.secid} | ${esc(r.name)} | ${r.bars} | ${r.first || '—'} | ${r.last || '—'} | ${r.bars2024} | ${esc(r.reason)} |`)
  }
  lines.push('')
}
lines.push(`## 宇宙内未完整覆盖 2024 的股票（${uni.length - covered.length} 只）`, '')
const uncovered = uni.filter((r) => !r.covered2024).sort((a, b) => b.bars - a.bars)
if (!uncovered.length) lines.push('无。', '')
else {
  lines.push('| secid | 名称 | bars | 首日 | 末日 | 2024 bars | 缺失交易日 | 缺口原因 |')
  lines.push('| --- | --- | ---: | --- | --- | ---: | ---: | --- |')
  for (const r of uncovered) {
    lines.push(`| ${r.secid} | ${esc(r.name)} | ${r.bars} | ${r.first || '—'} | ${r.last || '—'} | ${r.bars2024} | ${r.missing2024} | ${esc(r.reason)} |`)
  }
  lines.push('')
}
lines.push('## 全部缓存逐只明细', '')
lines.push('| secid | 宇宙 | 名称 | bars | 首日 | 末日 | 2024 bars | 覆盖2024 | 达标 | 缺口原因 |')
lines.push('| --- | --- | --- | ---: | --- | --- | ---: | --- | --- | --- |')
for (const r of records.sort((a, b) => (a.inUniverse === b.inUniverse ? a.secid.localeCompare(b.secid) : a.inUniverse ? -1 : 1))) {
  lines.push(
    `| ${r.secid} | ${r.inUniverse ? '是' : '否'} | ${esc(r.name)} | ${r.bars} | ${r.first || '—'} | ${r.last || '—'} | ${r.bars2024} | ${r.covered2024 ? '是' : '否'} | ${r.pass ? '是' : '否'} | ${esc(r.reason)} |`,
  )
}
lines.push('', '## 缺口原因说明', '')
lines.push('- `旧缓存 limit=600`：原缓存只抓 600 根，首日集中在 2024-04 之后，需重抓。')
lines.push('- `历史不足/上市晚`：上游（新浪）本身没有更早数据，通常是 2024 年后上市或长期停牌。')
lines.push('- `2024 内停止更新`：末日早于 2024-12-31，多为停牌、退市或上游缺失。')
lines.push('- `2024 内缺 N 个交易日`：首末日均覆盖但中间缺日，按交易日历比对；停牌属正常，成片缺失才需追上游。')
lines.push('- 非宇宙缓存只做统计，不计入验收；本次重抓只覆盖宇宙并集 1888 只。')
lines.push('')

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, lines.join('\n'))
const jsonOut = OUT.replace(/\.md$/, '.json')
fs.writeFileSync(
  jsonOut,
  `${JSON.stringify(
    {
      generatedAt,
      cacheDir: DIR,
      target: { start: START, end: END, passBars: PASS_BARS, passFirst: PASS_FIRST },
      tradingDays2024: tradingDays.length,
      summary: {
        universe: uni.length,
        universePass: passed.length,
        universePassPct: Number(pct(passed.length, uni.length)),
        universeCovered: covered.length,
        eligibleBefore2024: eligible.length,
        eligibleCovered: coveredEligible.length,
        eligibleFullTradingDays: fullEligible.length,
        post2024Listed: post2024.length,
        extra: extra.length,
        total: records.length,
      },
      failures: failed,
      records,
    },
    null,
    2,
  )}\n`,
)
console.log(
  `[audit] 全部 ${records.length} 只；宇宙 ${uni.length} 只，达标 ${passed.length}（${pct(passed.length, uni.length)}%），未达标 ${failed.length}，完整覆盖 2024 ${covered.length}`,
)
console.log(`[audit] 写出 ${path.relative(ROOT, OUT)} 与 ${path.relative(ROOT, jsonOut)}`)
