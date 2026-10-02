import { fetchJson, fetchJsonp, cached } from './http.js'

const SINA_ROLL = 'https://feed.mix.sina.com.cn/api/roll/get'
// 东财资讯搜索：与被封的 push2 不同主机，能按个股名 / 代码搜到真新闻。
const EM_SEARCH = 'https://search-api-web.eastmoney.com/search/jsonp'

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
 * 主源：东财资讯搜索（`search-api-web`，与 push2 不同主机，未被 IP 封），按名称 / 代码搜索。
 * 兜底：全市场要闻做关键词匹配（个股名很少出现在要闻标题里，命中率低）。
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

/** 东财搜索的 date（`2026-09-28 15:13:39`）→ 毫秒。 */
function emDateMs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s || ''))
  if (!m) return null
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()
}

/** 东财资讯搜索结果 → NewsItem[]（标题里的 `<em>` 高亮会被 clean 去掉）。 */
export function parseEmNewsSearch(json) {
  const rows = json?.result?.cmsArticleWebOld
  if (!Array.isArray(rows)) return []
  return rows
    .map((x) => ({
      title: clean(x.title),
      url: x.url || null,
      source: clean(x.mediaName) || '东方财富',
      time: emDateMs(x.date),
      summary: clean(x.content).slice(0, 160) || null,
    }))
    .filter((x) => x.title)
}

export async function emStockNews(keyword, { limit = 8 } = {}) {
  const q = String(keyword || '').trim()
  if (!q) return []
  const param = {
    uid: '',
    keyword: q,
    type: ['cmsArticleWebOld'],
    client: 'web',
    clientType: 'web',
    clientVersion: 'curr',
    param: {
      cmsArticleWebOld: { searchScope: 'default', sort: 'default', pageIndex: 1, pageSize: limit },
    },
  }
  const url = `${EM_SEARCH}?cb=cb&param=${encodeURIComponent(JSON.stringify(param))}`
  const json = await cached(`emn:${q}:${limit}`, 10 * 60_000, () => fetchJsonp(url))
  return parseEmNewsSearch(json).slice(0, limit)
}

export async function stockNews(keywords, { limit = 8 } = {}) {
  const list = (Array.isArray(keywords) ? keywords : [keywords]).map((s) => String(s || '').trim()).filter(Boolean)
  const errors = []
  for (const kw of list) {
    try {
      const items = await emStockNews(kw, { limit })
      if (items.length) return { items, degraded: false, source: 'eastmoney' }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }
  const news = await marketNews({ limit: 40 })
  return {
    items: filterNewsByKeywords(news, list, { limit }),
    degraded: true,
    source: 'sina-match',
    ...(errors.length ? { error: errors[0] } : {}),
  }
}