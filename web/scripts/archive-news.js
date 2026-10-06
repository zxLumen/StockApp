// 抓近 N 天资讯并按天落盘，供回测脚本按「≤ 某天」取用（无未来函数）。
//   node scripts/archive-news.js --days 30
// 产物：DATA_DIR/news-archive/<YYYY-MM-DD>.json（每天一个数组，字段同 NewsItem）
//
// 源：东方财富财经新闻栏目（np-listapi getNewsByColumns，column=345），可翻到任意历史、
// 带 showTime。新浪滚动新闻只保留最近 50 页（约 2 天），拿不到 30 天，故不用。
import path from 'node:path'
import { DATA_DIR } from '../lib/scope.js'
import { fetchJson } from '../lib/http.js'
import { writeJson } from '../lib/store.js'

const COL = 345
const api = (page, size = 50) =>
  `https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col` +
  `&column=${COL}&order=1&needInteractData=0&page_index=${page}&page_size=${size}&req_trace=1`

const clean = (s) =>
  String(s ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf(n)
  const v = i >= 0 ? Number(argv[i + 1]) : NaN
  return Number.isFinite(v) ? v : d
}
const DAYS = opt('--days', 30)

/** `2026-10-04 12:03:57` → 北京日期 YYYY-MM-DD（该字段本就是北京时间文本）。 */
const dayOf = (showTime) => String(showTime || '').slice(0, 10)

const since = new Date(Date.now() - DAYS * 86400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
console.log(`[archive-news] 抓取自 ${since} 起（近 ${DAYS} 天）→ ${DATA_DIR}/news-archive/`)

const byDay = new Map()
let page = 1
let total = 0
let oldest = '9999-99-99'
while (page <= 300) {
  let list
  try {
    const json = await fetchJson(api(page), { headers: { Referer: 'https://finance.eastmoney.com/' } })
    list = Array.isArray(json?.data?.list) ? json.data.list : []
  } catch (e) {
    console.warn(`  第 ${page} 页失败：${e instanceof Error ? e.message : e}`)
    break
  }
  if (!list.length) break
  for (const r of list) {
    const day = dayOf(r.showTime)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
    if (day < oldest) oldest = day
    if (day < since) continue
    const item = {
      title: clean(r.title),
      url: r.uniqueUrl || r.url || null,
      source: clean(r.mediaName) || '东方财富',
      time: new Date(`${r.showTime.replace(' ', 'T')}+08:00`).getTime() || null,
      summary: clean(r.summary).slice(0, 160) || null,
    }
    if (!item.title) continue
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day).push(item)
    total += 1
  }
  process.stdout.write(`\r  第 ${page} 页… 累计 ${total} 条，最旧 ${oldest}`)
  if (oldest < since) break
  page += 1
  await new Promise((r) => setTimeout(r, 120))
}
console.log()

for (const [day, items] of [...byDay.entries()].sort()) {
  const seen = new Set()
  const uniq = items.filter((x) => (seen.has(x.title) ? false : (seen.add(x.title), true)))
  await writeJson(path.join(DATA_DIR, 'news-archive', `${day}.json`), uniq)
  console.log(`  ${day}: ${uniq.length} 条`)
}
console.log(`[archive-news] 完成：${byDay.size} 天，共 ${total} 条`)
