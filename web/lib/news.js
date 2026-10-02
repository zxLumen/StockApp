import { fetchJson, cached } from './http.js'

const SINA_ROLL = 'https://feed.mix.sina.com.cn/api/roll/get'

const clean = (s) =>
  String(s ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** 当日财经要闻（新浪滚动新闻，唯一稳定可用的免 key 源）。 */
export async function marketNews({ limit = 20 } = {}) {
  const n = Math.min(40, Math.max(5, limit))
  const url = `${SINA_ROLL}?pageid=155&lid=1686&num=${n}&page=1`
  const json = await cached(`news:${n}`, 5 * 60_000, () => fetchJson(url))
  const rows = Array.isArray(json?.result?.data) ? json.result.data : []
  return rows
    .map((r) => ({
      title: clean(r.title),
      url: r.url || r.wapurl || null,
      source: clean(r.media_name),
      time: Number(r.ctime) ? Number(r.ctime) * 1000 : null,
      summary: clean(r.wapsummary || r.summary || r.intro).slice(0, 160) || null,
    }))
    .filter((x) => x.title)
    .slice(0, limit)
}

/**
 * 个股相关新闻。
 * 同花顺新闻搜索已被封、东财资讯搜索 403，个股级新闻源目前都不可用；
 * 这里降级为「按名称/代码在全市场要闻里做关键词匹配」，命中的即是相关热点。
 * 命中不足时前端会提示这是「相关要闻」而非个股专属新闻。
 */
/** 关键词过滤（标题 + 摘要，大小写无关；单字关键词太宽，忽略）。 */
export function filterNewsByKeywords(news, keywords, { limit = 8 } = {}) {
  const kw = (Array.isArray(keywords) ? keywords : [keywords])
    .filter(Boolean)
    .map((s) => String(s).toLowerCase())
  if (!kw.length) return []
  return news
    .filter((n) => {
      const hay = `${n.title} ${n.summary || ''}`.toLowerCase()
      return kw.some((k) => k.length >= 2 && hay.includes(k))
    })
    .slice(0, limit)
}

export async function stockNews(keywords, { limit = 8 } = {}) {
  const news = await marketNews({ limit: 40 })
  return { items: filterNewsByKeywords(news, keywords, { limit }), degraded: true }
}