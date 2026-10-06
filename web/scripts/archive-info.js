// 回补「点-时」资讯/公告归档，供资讯因子按「≤ 某天」取用（无未来函数）。
//   node scripts/archive-info.js --from 2026-07-01 --to 2026-10-04
// 产物：
//   DATA_DIR/news-archive/<day>.json  市场财经新闻（东财多个 column，按天去重）
//   DATA_DIR/ann-archive/<day>.json   个股公告（东财 np-anotice，带精确股票代码）
//
// 所有条目的时间戳都来自源站（showTime / notice_date），只用当天及以前的天做因子。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { DATA_DIR } from '../lib/scope.js'
import { fetchJson } from '../lib/http.js'
import { writeJson } from '../lib/store.js'

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
const ANN_REFERER = { Referer: 'https://data.eastmoney.com/' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const clean = (s) =>
  String(s ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const newsApi = (col, page, size = 50) =>
  `https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col` +
  `&column=${col}&order=1&needInteractData=0&page_index=${page}&page_size=${size}&req_trace=1`
const annApi = (page, size = 100) =>
  `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=${size}&page_index=${page}` +
  `&ann_type=A&client_source=web&f_node=0&s_node=0`

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

/** 抓个股公告（带精确代码，按天去重）。 */
async function archiveAnnouncements() {
  const byDay = new Map()
  // 先载入已有公告归档（支持「只补更早的页」而不丢已抓的）。
  try {
    const dir = path.join(DATA_DIR, 'ann-archive')
    for (const f of await fsp.readdir(dir)) {
      if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) continue
      const items = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'))
      byDay.set(f.slice(0, 10), Array.isArray(items) ? items : [])
    }
  } catch {
    /* 首次还没有 */
  }
  const preloaded = byDay.size
  let page = ANN_START
  let oldest = '9999-99-99'
  let n = 0
  while (page <= ANN_MAX) {
    let list
    try {
      const json = await fetchJson(annApi(page), { headers: ANN_REFERER })
      list = Array.isArray(json?.data?.list) ? json.data.list : []
    } catch (e) {
      console.warn(`  [ann] 第 ${page} 页失败：${e instanceof Error ? e.message : e}`)
      break
    }
    if (!list.length) break
    for (const r of list) {
      const day = dayOf(r.notice_date)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
      if (day < oldest) oldest = day
      if (day < FROM) continue
      if (day > TO) continue
      const codes = (r.codes || []).map((c) => String(c.stock_code || '')).filter(Boolean)
      const title = clean(r.title)
      if (!title || !codes.length) continue
      const item = {
        title,
        code: codes[0],
        codes,
        url: r.art_code ? `https://data.eastmoney.com/notices/detail/${codes[0]}/${r.art_code}.html` : null,
        time: new Date(`${day}T00:00:00+08:00`).getTime() || null,
      }
      if (!byDay.has(day)) byDay.set(day, [])
      byDay.get(day).push(item)
      n += 1
    }
    if (oldest < FROM) break
    page += 1
    if (page % 20 === 0) console.log(`  [ann] 第 ${page} 页… 累计 ${n}，最旧 ${oldest}`)
    await sleep(80)
  }
  let days = 0
  for (const [day, items] of [...byDay.entries()].sort()) {
    const seen = new Set()
    const uniq = items.filter((x) => {
      const k = `${x.code}|${x.title}`
      return seen.has(k) ? false : (seen.add(k), true)
    })
    await writeJson(path.join(DATA_DIR, 'ann-archive', `${day}.json`), uniq)
    days += 1
  }
  console.log(`[archive-info] 公告：${days} 天，共 ${n} 条`)
}

async function main() {
  console.log(`[archive-info] 归档 ${FROM} ~ ${TO} → ${DATA_DIR}${ANN_ONLY ? '（仅公告）' : ''}`)
  if (!ANN_ONLY) await archiveNews()
  await archiveAnnouncements()
  console.log('[archive-info] 完成')
}

main().catch((e) => {
  console.error('[archive-info] 失败：', e)
  process.exit(1)
})
