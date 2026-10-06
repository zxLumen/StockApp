// 回补**较早历史**的资讯/公告归档（现有 archive-info.js 的 news 上限只到 page 400，
// 覆盖不到 2025-09 这类更早的样本外窗口）。
//
//   node scripts/archive-history.js --from 2025-08-01 --to 2025-09-30 [--col-start 345:600] [--news-only|--ann-only]
//
// 与 archive-info.js 的关键区别：
//   - **合并写入**：先读入当日已有归档，去重后再写回，绝不覆盖已抓的（archive-info.js 的
//     news 部分是直接覆盖，会清掉 2026-07~10 的存量）。
//   - 每个栏目从指定起始页**向更早翻**，直到跨过 FROM 就停，不做无谓翻页。
//   - 公告接口很深（2025-09 约在 page 1700+），单独用 --ann-start/--ann-max 控制。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { DATA_DIR } from '../lib/scope.js'
import { fetchJson } from '../lib/http.js'
import { readJson, writeJson } from '../lib/store.js'

const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf(n)
  return i >= 0 ? argv[i + 1] : d
}
const has = (f) => argv.includes(f)
const FROM = opt('--from', '2025-08-01')
const TO = opt('--to', '2025-09-30')
const NEWS_ONLY = has('--news-only')
const ANN_ONLY = has('--ann-only')
const ANN_BYDAY = has('--ann-byday')
const COL_START = Number(opt('--col-start', 600)) || 600
const ANN_START = Number(opt('--ann-start', 1000)) || 1000
const ANN_MAX = Number(opt('--ann-max', 2600)) || 2600
const REFERER = { Referer: 'https://finance.eastmoney.com/' }
const ANN_REFERER = { Referer: 'https://data.eastmoney.com/' }
// 只有 345（财经要闻）与 347 能翻到 2025 年及更早；346/350/351 只到 2026 年，
// 用来回补历史纯属浪费翻页（实测会白扫上千页）。可用 --cols 覆盖。
const NEWS_COLUMNS = String(opt('--cols', '345,347'))
  .split(',')
  .map(Number)
  .filter(Boolean)
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
// 按天日期过滤：绕过区间查询的 50000 硬顶（区间 total_hits 会被截到 50000 且翻不过去）。
// 单日总量远小于 5 万（如 2025-09-18 约 1600 条），100/页翻十几页即可。
const annDayApi = (day, page, size = 100) =>
  `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=${size}&page_index=${page}` +
  `&ann_type=A&client_source=web&f_node=0&s_node=0&begin_time=${day}&end_time=${day}`

const dayOf = (t) => String(t || '').slice(0, 10)

/** 读入已有归档目录全部数据（day → items），用于合并写入。 */
async function loadExisting(sub) {
  const dir = path.join(DATA_DIR, sub)
  const byDay = new Map()
  try {
    for (const f of await fsp.readdir(dir)) {
      if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) continue
      const items = await readJson(path.join(dir, f), [])
      byDay.set(f.slice(0, 10), Array.isArray(items) ? items : [])
    }
  } catch {
    /* 首次还没有 */
  }
  return byDay
}

/** 合并写回：只在目标范围内落盘，且与已有条目按 key 去重。 */
async function flush(byDay, sub, keyOf) {
  const exist = await loadExisting(sub)
  const touched = []
  for (const [day, items] of byDay) {
    if (day < FROM || day > TO) continue
    const merged = [...(exist.get(day) || []), ...items]
    const seen = new Set()
    const uniq = merged.filter((x) => (seen.has(keyOf(x)) ? false : (seen.add(keyOf(x)), true)))
    await writeJson(path.join(DATA_DIR, sub, `${day}.json`), uniq)
    touched.push([day, uniq.length])
  }
  return touched
}

async function archiveNews() {
  const byDay = new Map()
  // 每列的可翻深度不同，起点也不同（345 的 2025-08 在 p700 附近，347 在 p200 附近）。
  // `--col-start` 支持两种写法：全局一个数（所有列同起点），或 `345:700,347:200` 按列指定。
  const starts = new Map()
  const raw = String(opt('--col-start', '')) || ''
  if (raw.includes(':')) {
    for (const part of raw.split(',')) {
      const [c, p] = part.split(':').map(Number)
      if (c && p) starts.set(c, p)
    }
  }
  const startFor = (col) => starts.get(col) ?? COL_START
  for (const col of NEWS_COLUMNS) {
    let page = startFor(col)
    let oldest = '9999-99-99'
    let n = 0
    while (page >= 1) {
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
      process.stdout.write(`\r  [news col=${col}] p${page} 累计 ${n}，最旧 ${oldest}   `)
      if (oldest < FROM) break
      page -= 1
      await sleep(70)
    }
    console.log()
  }
  const touched = await flush(byDay, 'news-archive', (x) => x.title)
  console.log(`[archive-history] 新闻合并：${touched.length} 天`)
}

async function archiveAnnouncements() {
  const byDay = new Map()
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
      if (day < FROM || day > TO) continue
      const codes = (r.codes || []).map((c) => String(c.stock_code || '')).filter(Boolean)
      const title = clean(r.title)
      if (!title || !codes.length) continue
      if (!byDay.has(day)) byDay.set(day, [])
      byDay.get(day).push({
        title,
        code: codes[0],
        codes,
        cols: (r.columns || []).map((c) => clean(c.column_name)).filter(Boolean),
        url: r.art_code ? `https://data.eastmoney.com/notices/detail/${codes[0]}/${r.art_code}.html` : null,
        time: new Date(`${day}T00:00:00+08:00`).getTime() || null,
      })
      n += 1
    }
    process.stdout.write(`\r  [ann] p${page} 累计 ${n}，最旧 ${oldest}   `)
    if (oldest < FROM) break
    page += 1
    await sleep(70)
  }
  console.log()
  const touched = await flush(byDay, 'ann-archive', (x) => `${x.code}|${x.title}`)
  console.log(`[archive-history] 公告合并：${touched.length} 天`)
}

/** [FROM, TO] 连续日期（YYYY-MM-DD，含两端）。 */
function dayRange(from, to) {
  const out = []
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  for (let t = start; t <= end; t += 86400000) out.push(new Date(t).toISOString().slice(0, 10))
  return out
}

/**
 * **按天**回补公告（推荐）：`begin_time=end_time=day`，绕开区间 50000 硬顶。
 * 每天从 page 1 翻到 total_hits 耗尽，只收 `notice_date === day` 的条目，合并写入。
 */
async function archiveAnnouncementsByDay() {
  const days = dayRange(FROM, TO)
  const byDay = new Map()
  let n = 0
  for (const day of days) {
    const items = []
    let page = 1
    let total = 0
    while (page <= 200) {
      let json
      try {
        json = await fetchJson(annDayApi(day, page), { headers: ANN_REFERER })
      } catch (e) {
        console.warn(`  [ann ${day}] p${page} 失败：${e instanceof Error ? e.message : e}，重试一次`)
        await sleep(300)
        try {
          json = await fetchJson(annDayApi(day, page), { headers: ANN_REFERER })
        } catch (e2) {
          console.warn(`  [ann ${day}] p${page} 重试仍失败，跳过该天剩余页`)
          break
        }
      }
      const list = Array.isArray(json?.data?.list) ? json.data.list : []
      total = json?.data?.total_hits || total
      if (!list.length) break
      for (const r of list) {
        if (dayOf(r.notice_date) !== day) continue
        const codes = (r.codes || []).map((c) => String(c.stock_code || '')).filter(Boolean)
        const title = clean(r.title)
        if (!title || !codes.length) continue
        items.push({
          title,
          code: codes[0],
          codes,
          cols: (r.columns || []).map((c) => clean(c.column_name)).filter(Boolean),
          url: r.art_code ? `https://data.eastmoney.com/notices/detail/${codes[0]}/${r.art_code}.html` : null,
          time: new Date(`${day}T00:00:00+08:00`).getTime() || null,
        })
      }
      if (list.length < 100) break
      page += 1
      await sleep(60)
    }
    if (items.length) byDay.set(day, items)
    n += items.length
    process.stdout.write(`\r  [ann] ${day} ${items.length}/${total} 条，累计 ${n}   `)
    await sleep(60)
  }
  console.log()
  const touched = await flush(byDay, 'ann-archive', (x) => `${x.code}|${x.title}`)
  console.log(`[archive-history] 公告(按天)合并：${touched.length} 天`)
}

async function main() {
  console.log(`[archive-history] 回补 ${FROM} ~ ${TO}（合并写入，不覆盖存量）`)
  if (!ANN_ONLY) await archiveNews()
  if (!NEWS_ONLY) {
    if (ANN_BYDAY) await archiveAnnouncementsByDay()
    else await archiveAnnouncements()
  }
  console.log('[archive-history] 完成')
}

main().catch((e) => {
  console.error('[archive-history] 失败：', e)
  process.exit(1)
})
