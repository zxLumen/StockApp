// 资讯/公告 → 「点-时」个股信息。**红线：只用 ≤ 目标日 D 的归档，且条目时间戳必须 ≤ D。**
import path from 'node:path'

import { readJson } from './store.js'

// 新闻标题情绪词表（先验，冻结；**不用 LLM**）。命中即计分。
const NEWS_POS = /利好|大涨|涨停|中标|签约|突破|新高|增长|超预期|回购|增持|盈利|扭亏|获批|量产|订单/
const NEWS_NEG = /利空|大跌|跌停|亏损|下滑|减持|质押|违规|立案|处罚|问询|退市|风险|商誉减值|终止|终止上市/

/** 单条新闻标题的情绪分（+1 利好 / -1 利空 / 0 中性；标题同时含正负则抵消为 0）。 */
export function scoreNewsTitle(title) {
  const t = String(title || '')
  const p = NEWS_POS.test(t) ? 1 : 0
  const n = NEWS_NEG.test(t) ? 1 : 0
  return p - n
}

/** 名称索引：把市场新闻按股票名/代码匹配到个股。 */
export function buildNameIndex(universe) {
  return universe
    .map((s) => ({ code: s.code, name: String(s.name || '').replace(/\s/g, '') }))
    .filter((s) => s.code && s.name)
}

/** 一条新闻匹配到的股票代码集合（标题+摘要里含股票名，或标题含 6 位代码）。 */
export function matchNewsItem(item, idx) {
  const hay = `${item.title || ''} ${item.summary || ''}`.replace(/\s/g, '')
  const hits = new Set()
  for (const s of idx) {
    if (hay.includes(s.name)) hits.add(s.code)
    else if (s.name.length >= 3 && (item.summary || '').includes(s.name)) hits.add(s.code)
  }
  return hits
}

/** `YYYY-MM-DD` 当天北京时间 23:59:59 的毫秒时间戳。 */
export function dayEndMs(day) {
  return Date.parse(`${day}T23:59:59+08:00`)
}

/**
 * 汇总某天（只读该天归档文件）的个股资讯/公告标题。
 * 返回 Map<code, { news: string[], ann: string[] }>。
 * 归档文件本身按天切分，天然 ≤ D；这里再断言时间戳，防回归。
 */
export async function buildDailyInfo(dataDir, day, nameIndex) {
  const map = new Map()
  const add = (code, title, kind) => {
    if (!code || !title) return
    if (!map.has(code)) map.set(code, { news: [], ann: [] })
    const e = map.get(code)
    if (e[kind].includes(title)) return
    if (e[kind].length < 12) e[kind].push(title)
  }

  const limit = dayEndMs(day)
  const news = await readJson(path.join(dataDir, 'news-archive', `${day}.json`), [])
  for (const it of Array.isArray(news) ? news : []) {
    if (it?.time && it.time > limit) throw new Error(`未来数据泄漏：新闻 ${it.time} > ${day}`)
    for (const code of matchNewsItem(it, nameIndex)) add(code, it.title, 'news')
  }
  const ann = await readJson(path.join(dataDir, 'ann-archive', `${day}.json`), [])
  for (const it of Array.isArray(ann) ? ann : []) {
    if (it?.time && it.time > limit) throw new Error(`未来数据泄漏：公告 ${it.time} > ${day}`)
    for (const code of it.codes || [it.code]) add(code, it.title, 'ann')
  }
  return map
}
