// 个股公告归档核心（东财 np-anotice，带精确股票代码），供：
//   - scripts/archive-info.js（按区间回补 / 手动）
//   - scripts/recommend.js（每日收盘后自动归档当天，保证事件因子不恒空）
// 共用。产物：DATA_DIR/ann-archive/<YYYY-MM-DD>.json。
//
// 无未来函数：条目的 notice_date 决定归属日；调用方只映射「≤ 评估日」的归档。
import fsp from 'node:fs/promises'
import path from 'node:path'

import { fetchJson } from './http.js'
import { writeJson } from './store.js'

const REFERER = { Referer: 'https://data.eastmoney.com/' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const clean = (s) =>
  String(s ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
const dayOf = (t) => String(t || '').slice(0, 10)
const annApi = (page, size = 100) =>
  `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=${size}&page_index=${page}` +
  `&ann_type=A&client_source=web&f_node=0&s_node=0`

/**
 * 抓取个股公告并按自然日落盘。
 * @param {object} o
 * @param {string} o.dataDir                    数据根目录（其下 ann-archive/）
 * @param {string} [o.from]                     只保留 notice_date ≥ from（含）
 * @param {string} [o.to]                       只保留 notice_date ≤ to（含）
 * @param {number} [o.startPage=1]              起始页
 * @param {number} [o.maxPage=800]              最大页数上限
 * @param {boolean} [o.preload=true]            true=先载入已有归档再合并（回补跨页时防丢）；
 *                                              false=不读旧文件、只写 [from,to]（每日增量，最省）
 * @param {(m:string)=>void} [o.log=()=>{}]
 * @returns {Promise<{days:number,count:number,touched:string[]}>}
 */
export async function archiveAnnouncements({
  dataDir,
  from,
  to,
  startPage = 1,
  maxPage = 800,
  preload = true,
  log = () => {},
} = {}) {
  const byDay = new Map()
  if (preload) {
    try {
      const dir = path.join(dataDir, 'ann-archive')
      for (const f of await fsp.readdir(dir)) {
        if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) continue
        const items = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'))
        byDay.set(f.slice(0, 10), Array.isArray(items) ? items : [])
      }
    } catch {
      /* 首次还没有 */
    }
  }

  let page = startPage
  let oldest = '9999-99-99'
  let n = 0
  while (page <= maxPage) {
    let list
    try {
      const json = await fetchJson(annApi(page), { headers: REFERER })
      list = Array.isArray(json?.data?.list) ? json.data.list : []
    } catch (e) {
      log(`  [ann] 第 ${page} 页失败：${e instanceof Error ? e.message : e}`)
      break
    }
    if (!list.length) break
    for (const r of list) {
      const day = dayOf(r.notice_date)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
      if (day < oldest) oldest = day
      if (from && day < from) continue
      if (to && day > to) continue
      const codes = (r.codes || []).map((c) => String(c.stock_code || '')).filter(Boolean)
      const title = clean(r.title)
      if (!title || !codes.length) continue
      const item = {
        title,
        code: codes[0],
        codes,
        url: r.art_code
          ? `https://data.eastmoney.com/notices/detail/${codes[0]}/${r.art_code}.html`
          : null,
        time: new Date(`${day}T00:00:00+08:00`).getTime() || null,
      }
      if (!byDay.has(day)) byDay.set(day, [])
      byDay.get(day).push(item)
      n += 1
    }
    if (from && oldest < from) break
    page += 1
    if (page % 20 === 0) log(`  [ann] 第 ${page} 页… 累计 ${n}，最旧 ${oldest}`)
    await sleep(80)
  }

  let days = 0
  const touched = []
  for (const [day, items] of [...byDay.entries()].sort()) {
    if (from && day < from) continue
    if (to && day > to) continue
    const seen = new Set()
    const uniq = items.filter((x) => {
      const k = `${x.code}|${x.title}`
      return seen.has(k) ? false : (seen.add(k), true)
    })
    await writeJson(path.join(dataDir, 'ann-archive', `${day}.json`), uniq)
    days += 1
    touched.push(day)
  }
  log(`[archive-ann] 公告：${days} 天，共 ${n} 条`)
  return { days, count: n, touched }
}
