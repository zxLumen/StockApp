// 回补「点-时」资讯/公告归档，供资讯因子按「≤ 某天」取用（无未来函数）。
//   node scripts/archive-info.js --from 2026-07-01 --to 2026-10-04
//   node scripts/archive-info.js --ann-only --from 2026-10-01 --to 2026-10-09
// 产物：
//   DATA_DIR/news-archive/<day>.json  市场财经新闻（东财多个 column，按天去重）
//   DATA_DIR/ann-archive/<day>.json   个股公告（东财 np-anotice，带精确股票代码）
//
// 所有条目的时间戳都来自源站（showTime / notice_date），只用当天及以前的天做因子。
// 公告抓取的核心已抽到 lib/archive-ann.js（每日自动归档也复用它）。
import path from 'node:path'

import { DATA_DIR } from '../lib/scope.js'
import { fetchJson } from '../lib/http.js'
import { writeJson } from '../lib/store.js'
import { archiveAnnouncements } from '../lib/archive-ann.js'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const opt = (n, d) => {
  const i = argv.indexOf(n)
  return i >= 0 ? argv[i + 1] : d
}
const bjToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
const FROM = opt('--from', '2026-07-01')
const TO = opt('--to', bjToday())
const ANN_ONLY = has('--ann-only')
const ANN_START = Number(opt('--ann-start', 1)) || 1
const ANN_MAX = Number(opt('--ann-max', 800)) || 800
const NEWS_COLUMNS = [345, 346, 347, 350, 351]
const REFERER = { Referer: 'https://finance.eastmoney.com/' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const clean = (s) =>
  String(s ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const newsApi = (col, page, size = 50) =>
  `https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col` +
  `&column=${col}&order=1&needInteractData=0&page_index=${page}&page_size=${size}&req_trace=1`

const dayOf = (t) => String(t || '').slice(0, 10)

/** 抓市场新闻（多频道，按天去重）。 */
async function archiveNews() {
  const byDay = new Map()
  for (const col of NEWS_COLUMNS) {
    let page = 1
    let oldest = '9999-99-99'
    let n = 0
    while (page <= 400) {
      let list
      try {
        const json = await fetchJson(newsApi(col, page), { headers: REFERER })
        list = Array.isArray(json?.data?.list) ? json.data.list : []
      } catch (e) {
        console.warn(`  [news ${col}] 第 ${page} 页失败：${e instanceof Error ? e.message : e}`)
        break
      }
      if (!list.length) break
      for (const r of list) {
        const day = dayOf(r.showTime)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
        if (day < oldest) oldest = day
        if (day < FROM || day > TO) continue
        const title = clean(r.title)
        if (!title) continue
        const item = {
          title,
          url: r.uniqueUrl || r.url || null,
          source: clean(r.mediaName) || '东方财富',
          time: new Date(`${r.showTime.replace(' ', 'T')}+08:00`).getTime() || null,
          summary: clean(r.summary).slice(0, 160) || null,
        }
        if (!byDay.has(day)) byDay.set(day, [])
        byDay.get(day).push(item)
        n += 1
      }
      if (oldest < FROM) break
      page += 1
      await sleep(80)
    }
    console.log(`  [news col=${col}] 收 ${n} 条，最旧 ${oldest}`)
  }
  // 落盘（按 title 去重）
  let days = 0
  for (const [day, items] of [...byDay.entries()].sort()) {
    const seen = new Set()
    const uniq = items.filter((x) => (seen.has(x.title) ? false : (seen.add(x.title), true)))
    await writeJson(path.join(DATA_DIR, 'news-archive', `${day}.json`), uniq)
    days += 1
  }
  console.log(`[archive-info] 新闻：${days} 天`)
}

async function main() {
  console.log(`[archive-info] 归档 ${FROM} ~ ${TO} → ${DATA_DIR}${ANN_ONLY ? '（仅公告）' : ''}`)
  if (!ANN_ONLY) await archiveNews()
  await archiveAnnouncements({
    dataDir: DATA_DIR,
    from: FROM,
    to: TO,
    startPage: ANN_START,
    maxPage: ANN_MAX,
    preload: true,
    log: console.log,
  })
  console.log('[archive-info] 完成')
}

main().catch((e) => {
  console.error('[archive-info] 失败：', e)
  process.exit(1)
})
