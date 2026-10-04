import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

import {
  searchSuggest,
  fundSuggest,
  fundQuotes,
  INDEX_GROUPS,
  marketOf,
} from './lib/eastmoney.js'
import {
  getBoards,
  getBoardMembers,
  getKline,
  getQuotes,
  searchBoards,
  SOURCES,
  sourceLabel,
} from './lib/market.js'
import { fundHot, fundNavSeries, fundRank, FUND_RANK_SORTS } from './lib/fund.js'
import { marketNews, stockNews, newsScope } from './lib/news.js'
import { loadRecommend, listRecommendDates, attachPerformance } from './lib/recommend.js'
import { readJson, writeJson } from './lib/store.js'
import { DATA_DIR, resolveScope, cookieHeader, ownerToken } from './lib/scope.js'
import { loadSettings, saveSettings, saveKey, publicSettings, aiConfig, aiConfigFor } from './lib/settings.js'
import { streamChat, fetchModels } from './lib/llm.js'
import { PROVIDERS } from './lib/providers.js'
import { upstreamStatus } from './lib/http.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(__dirname, 'dist')
const PORT = Number(process.env.STOCK_PORT || 8789)
const HOST = process.env.STOCK_HOST || '127.0.0.1'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

// ---- 工具 ----

function sendJson(res, status, body, headers = {}) {
  const txt = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(txt)
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

const rateBuckets = new Map()

function rateLimited(key, max, windowMs) {
  const now = Date.now()
  const b = rateBuckets.get(key)
  if (!b || now - b.at > windowMs) {
    rateBuckets.set(key, { at: now, n: 1 })
    return false
  }
  b.n += 1
  return b.n > max
}

async function loadWatchlist(scopeKey) {
  const list = await readJson(path.join(DATA_DIR, 'watchlist', `${scopeKey}.json`), [])
  return Array.isArray(list) ? list.filter((x) => x && typeof x.secid === 'string') : []
}

async function saveWatchlist(scopeKey, list) {
  await writeJson(path.join(DATA_DIR, 'watchlist', `${scopeKey}.json`), list)
}

const MAX_WATCH = 100

// ---- 路由 ----

const routes = []
const route = (method, pattern, handler) => routes.push({ method, pattern, handler })

route('GET', /^\/api\/status$/, async (ctx) => {
  const cfg = await aiConfig(DATA_DIR)
  const settings = await loadSettings(DATA_DIR)
  const enabled = cfg.visitorAi ? !!cfg.apiKey : ctx.scope.isOwner && !!cfg.apiKey
  return {
    owner: ctx.scope.isOwner,
    visitorAi: settings.visitorAi,
    ai: { enabled, hasKey: !!cfg.apiKey, model: cfg.model, provider: settings.provider },
    providers: PROVIDERS.map((p) => ({ id: p.id, label: p.label })),
    sources: SOURCES,
    upstream: upstreamStatus(),
  }
})

route('GET', /^\/api\/market\/indices$/, async (ctx) => {
  const scope = ctx.url.searchParams.get('scope') === 'us' ? 'us' : 'cn'
  const group = INDEX_GROUPS[scope] || INDEX_GROUPS.cn
  const { items: quotes, source } = await getQuotes(group.map((i) => i.secid))
  const byId = new Map(quotes.map((q) => [q.secid, q]))
  return {
    scope,
    source,
    sourceLabel: sourceLabel(source),
    items: group.map((i) => ({ ...i, ...(byId.get(i.secid) || {}) })),
  }
})

route('GET', /^\/api\/market\/search$/, async (ctx) => {
  const q = ctx.url.searchParams.get('q') || ''
  const scope = ctx.url.searchParams.get('scope') || ''
  // scope=board：板块走本地全量索引（同花顺 90 行业 + 293 概念 + 中证 10 行业），
  // 不依赖任何被封 / 被限流的上游，所以和个股搜索分开走。
  if (scope === 'board') {
    const raw = ctx.url.searchParams.get('kind') || ''
    const kind = ['industry', 'concept', 'csi'].includes(raw) ? raw : ''
    const items = await searchBoards(q, { kind, limit: 20 })
    return { scope, kind, items }
  }
  let items = await searchSuggest(q, { limit: 14 })
  // scope=cn = 「沪深港」一个页签，港股（market=hk）要一起显示
  if (scope === 'cn') items = items.filter((x) => x.market === 'cn' || x.market === 'hk')
  if (scope === 'us') items = items.filter((x) => x.market === 'us')
  return { items }
})

route('GET', /^\/api\/market\/kline$/, async (ctx) => {
  const secid = ctx.url.searchParams.get('secid') || ''
  if (!/^\d+\.[A-Za-z0-9._-]+$/.test(secid)) throw new HttpError(400, 'secid 不合法')
  const period = ctx.url.searchParams.get('period') || 'd'
  const limit = Number(ctx.url.searchParams.get('limit')) || 240
  const k = await getKline(secid, { period, limit })
  return { ...k, sourceLabel: sourceLabel(k.source) }
})

route('GET', /^\/api\/market\/quote$/, async (ctx) => {
  const raw = ctx.url.searchParams.get('secids') || ''
  const secids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d+\.[A-Za-z0-9._-]+$/.test(s))
    .slice(0, 60)
  const { items, source } = await getQuotes(secids)
  return { items, source, sourceLabel: sourceLabel(source) }
})

route('GET', /^\/api\/market\/board$/, async (ctx) => {
  const raw = ctx.url.searchParams.get('kind') || 'industry'
  const kind = ['industry', 'concept', 'csi'].includes(raw) ? raw : 'industry'
  // 搜索放开后列表不再截到 24 条：同花顺行业 90 / 概念 293，全量给到 300
  const limit = Math.min(300, Number(ctx.url.searchParams.get('limit')) || 300)
  const { items, source } = await getBoards(kind, { limit })
  return { kind, items, source, sourceLabel: sourceLabel(source) }
})

route('GET', /^\/api\/market\/board\/members$/, async (ctx) => {
  const name = ctx.url.searchParams.get('name') || ''
  const code = ctx.url.searchParams.get('code') || ''
  const raw = ctx.url.searchParams.get('kind') || ''
  const kind = ['industry', 'concept'].includes(raw) ? raw : ''
  const cid = ctx.url.searchParams.get('cid') || ''
  if (!name && !code) throw new HttpError(400, '缺少 name 或 code')
  const limit = Math.min(50, Number(ctx.url.searchParams.get('limit')) || 30)
  const { items, source, board } = await getBoardMembers({ code, name, kind, cid }, { limit })
  // board 是板块自身的涨跌家数 / 领涨股 / 净流入，服务端从内存索引里带出来，
  // 前端不用为了这几个字段再拉一遍 90~293 条的列表接口
  return { name, items, source, sourceLabel: sourceLabel(source), board: board ?? null }
})

route('GET', /^\/api\/fund\/suggest$/, async (ctx) => {
  const q = ctx.url.searchParams.get('q') || ''
  return { items: await fundSuggest(q, { limit: 10 }) }
})

route('GET', /^\/api\/fund\/nav$/, async (ctx) => {
  const code = ctx.url.searchParams.get('code') || ''
  if (!/^\d{6}$/.test(code)) throw new HttpError(400, '基金代码不合法')
  return fundNavSeries(code, { limit: Number(ctx.url.searchParams.get('limit')) || 240 })
})

route('GET', /^\/api\/fund\/quotes$/, async (ctx) => {
  const raw = ctx.url.searchParams.get('codes') || ''
  const codes = raw.split(',').map((s) => s.trim()).filter((s) => /^\d{6}$/.test(s)).slice(0, 30)
  return { items: await fundQuotes(codes) }
})

route('GET', /^\/api\/fund\/rank$/, async (ctx) => {
  const sort = ctx.url.searchParams.get('sort') || 'd1'
  const limit = Math.min(40, Number(ctx.url.searchParams.get('limit')) || 20)
  if (!FUND_RANK_SORTS.some((s) => s.key === sort)) throw new HttpError(400, '不支持的排序')
  return { ...(await fundRank({ sort, limit })), sorts: FUND_RANK_SORTS }
})

route('GET', /^\/api\/fund\/hot$/, async () => ({ groups: await fundHot() }))

route('GET', /^\/api\/news$/, async (ctx) => {
  const kind = ctx.url.searchParams.get('kind') || 'market'
  // 美股页要美股自己的新闻，缺省仍是 A 股
  const scope = newsScope(ctx.url.searchParams.get('scope'))
  // 两类新闻都支持 limit：前端固定只显示 Top 10，用户点「展开」才拿剩下的，
  // 所以这里必须给够（默认 20），否则「展开」后面本来就是空的。
  const limit = Math.min(40, Math.max(5, Number(ctx.url.searchParams.get('limit')) || 20))
  if (kind === 'stock') {
    const name = ctx.url.searchParams.get('name') || ''
    const code = ctx.url.searchParams.get('code') || ''
    const out = await stockNews([name, code].filter(Boolean), { limit, scope })
    return { kind, scope, ...out }
  }
  return { kind, scope, items: await marketNews({ limit, scope }) }
})

// 每日推荐：datasets = 有哪几天的；不带 date 给最新一天的完整（Top10 + 候选 + 解读）；
// 带 date 给指定那天。找不到就是 null（前端显示「今日尚未生成」）。
route('GET', /^\/api\/recommend\/dates$/, async () => ({ dates: await listRecommendDates(DATA_DIR) }))

route('GET', /^\/api\/recommend$/, async (ctx) => {
  const date = ctx.url.searchParams.get('date') || ''
  const data = await loadRecommend(DATA_DIR, date)
  if (!data) return null
  // 补上「自推荐日到最新」的涨跌（公开数据，任何人可见）
  return attachPerformance(data)
})

route('GET', /^\/api\/watchlist$/, async (ctx) => ({ items: await loadWatchlist(ctx.scope.scopeKey) }))

route('POST', /^\/api\/watchlist$/, async (ctx) => {
  const body = await readBody(ctx.req)
  const isFund = body.kind === 'fund'
  const secid = isFund ? String(body.code || body.secid || '') : String(body.secid || '')
  if (isFund) {
    if (!/^\d{6}$/.test(secid)) throw new HttpError(400, '基金代码不合法')
  } else if (!/^\d+\.[A-Za-z0-9._-]+$/.test(secid)) {
    throw new HttpError(400, 'secid 不合法')
  }
  const list = await loadWatchlist(ctx.scope.scopeKey)
  if (!list.some((x) => x.secid === secid)) {
    if (list.length >= MAX_WATCH) throw new HttpError(400, `自选最多 ${MAX_WATCH} 个`)
    list.unshift({
      secid,
      code: String(body.code || secid.split('.')[1] || ''),
      name: String(body.name || '').slice(0, 40),
      market: isFund ? 'fund' : marketOf(secid),
      kind: isFund ? 'fund' : 'stock',
      at: Date.now(),
    })
    await saveWatchlist(ctx.scope.scopeKey, list)
  }
  return { items: list }
})

route('DELETE', /^\/api\/watchlist$/, async (ctx) => {
  const secid = ctx.url.searchParams.get('secid') || ''
  const list = await loadWatchlist(ctx.scope.scopeKey)
  const next = list.filter((x) => x.secid !== secid)
  if (next.length !== list.length) await saveWatchlist(ctx.scope.scopeKey, next)
  return { items: next }
})

route('GET', /^\/api\/ai\/settings$/, async () => publicSettings(DATA_DIR))

route('POST', /^\/api\/ai\/settings$/, async (ctx) => {
  if (!ctx.scope.isOwner) throw new HttpError(403, '仅站长可配置')
  const body = await readBody(ctx.req)
  const allowed = {}
  for (const k of ['provider', 'providers', 'maxTokens', 'temperature', 'visitorAi']) {
    if (body[k] !== undefined) allowed[k] = body[k]
  }
  await saveSettings(DATA_DIR, allowed)
  return publicSettings(DATA_DIR)
})

route('POST', /^\/api\/ai\/key$/, async (ctx) => {
  if (!ctx.scope.isOwner) throw new HttpError(403, '仅站长可配置')
  const body = await readBody(ctx.req)
  const provider = String(body.provider || '')
  if (!PROVIDERS.some((p) => p.id === provider)) throw new HttpError(400, '未知的服务商')
  await saveKey(DATA_DIR, provider, body.key)
  return publicSettings(DATA_DIR)
})

route('GET', /^\/api\/ai\/models$/, async (ctx) => {
  if (!ctx.scope.isOwner) throw new HttpError(403, '仅站长可查询')
  const provider = ctx.url.searchParams.get('provider') || ''
  if (provider && !PROVIDERS.some((p) => p.id === provider)) throw new HttpError(400, '未知的服务商')
  // 带 provider 时可以在「非当前服务商」的槽上探测（设置面板里挨个试）
  const cfg = await aiConfigFor(DATA_DIR, provider || null)
  // 没 Key 就别拿裸请求去换上游那个语焉不详的 401
  if (!cfg.apiKey) throw new HttpError(400, `「${provider ? PROVIDERS.find((p) => p.id === provider).label : '当前服务商'}」还没保存 API Key`)
  const baseURL = ctx.url.searchParams.get('baseURL') || cfg.baseURL
  const models = await fetchModels({ baseURL, apiKey: cfg.apiKey }, crypto.randomUUID())
  return { models }
})

/** 喂给模型的资讯条数。够覆盖「热点/消息面」那一段，又不至于把 prompt 撑爆。 */
const AI_NEWS_LIMIT = 10

/** 把行情与新闻压成一段紧凑上下文，交给模型解读。 */
export async function buildContext(secid, name) {
  // 市场从 secid 自己推，不信客户端传的 market —— 否则美股会被喂 A 股新闻。
  const market = marketOf(secid)
  const scope = newsScope(market)
  const isBoard = market === 'board'
  const board = isBoard ? await boardContext(secid, name).catch(() => null) : null
  const [kline, quote, news] = await Promise.all([
    getKline(secid, { period: 'd', limit: 60 }).catch(() => null),
    // getQuotes 返回 { items, source }，不是数组 —— 兜底也得是同形状，
    // 否则下面取 items[0] 会静默拿到 null，成交额/换手率/市值又全成了 NA。
    getQuotes([secid]).catch(() => ({ items: [] })),
    stockNews([name], { limit: AI_NEWS_LIMIT, scope }).catch(() => ({ items: [] })),
  ])
  const q = quote?.items?.[0] ?? null
  const bars = kline?.bars || []
  const last = bars[bars.length - 1] || null
  const closes = bars.map((b) => b.close)
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null)
  const fmt = (n, d = 2) => (n == null ? 'NA' : n.toFixed(d))
  // 成交额 / 换手率只能来自行情快照（OHLCV 里推不出来）；涨跌幅 / 振幅由
  // withDerived 从前收精确还原过，快照有就优先用快照的权威值。
  const first = (...vals) => {
    for (const v of vals) if (v != null) return v
    return null
  }
  const amount = first(q?.amount, last?.amount)
  const turnover = first(q?.turnover, last?.turnover)
  const changePct = first(last?.changePct, q?.changePct)
  const amplitude = first(last?.amplitude, q?.amplitude)
  const volume = first(last?.volume, q?.volume)

  // 缺哪个就明说哪个，别打「NA」让模型自己脑补 —— 它会直接说「无法评估」。
  // 板块没有「换手率 / 市值」这回事（成分股 dozens 只，各自动态），列进去只会让
  // 模型反复念叨「未取到」，所以按市场类型决定要查哪些。
  const missing = [
    ['成交额', amount],
    ...(isBoard ? [] : [['换手率', turnover]]),
    ['涨跌幅', changePct],
    ['振幅', amplitude],
  ]
    .filter(([, v]) => v == null)
    .map(([k]) => k)

  const marketLabel = { us: '美股', fund: '基金', board: '板块' }[market] ?? 'A 股'
  const lines = [
    `标的：${name || kline?.name || secid}（${secid}，${marketLabel}）`,
    ...(isBoard ? boardLines(board) : []),
    `最新：${fmt(last?.close)}  涨跌：${fmt(changePct)}%  振幅：${fmt(amplitude)}%`,
    `成交量：${fmt(volume, 0)} 手  成交额：${fmt(amount, 0)} 元${isBoard ? '' : `  换手：${fmt(turnover)}%`}`,
    `MA5=${fmt(last?.ma5)}  MA10=${fmt(last?.ma10)}  MA20=${fmt(last?.ma20)}`,
    `近20日均价 ${fmt(avg(closes.slice(-20)))}  近60日均价 ${fmt(avg(closes.slice(-60)))}`,
    `区间：60日高 ${fmt(Math.max(...closes))}  60日低 ${fmt(Math.min(...closes))}`,
    ...(isBoard ? [] : [q ? `总市值 ${fmt(q.marketCap, 0)}  流通市值 ${fmt(q.floatCap, 0)}` : '']),
    missing.length ? `（本次未取到：${missing.join('、')}，请勿臆测具体数值）` : '',
    '',
    `近期相关资讯标题（${scope === 'us' ? '美股' : 'A 股'}）：`,
    ...(news.items || []).map((n, i) => `${i + 1}. ${n.title}`),
  ].filter(Boolean)
  if (!(news.items || []).length) lines.push('（本次没有取到相关资讯标题）')
  return lines.join('\n')
}

/**
 * 板块专属上下文：成分股数量、涨跌家数、领涨股。
 * 这些是板块最关键的「形态」信息 —— 90 只成分里 10 涨 179 跌，比指数那根 K 线
 * 更能说明资金在往哪走。拿不到就返回 null，调用方照常只给行情。
 */
async function boardContext(secid, name) {
  const code = String(secid).split('.')[1] || ''
  if (!/^\d{6}$/.test(code)) return null
  const kind = /^(885|886)\d{3}$/.test(code) ? 'concept' : 'industry'
  const { items, board } = await getBoardMembers({ code, name: name || code, kind }, { limit: 30 })
  return { count: items.length, partial: true, meta: board || null }
}

export function boardLines(board) {
  if (!board) return []
  const m = board.meta || {}
  const out = []
  if (board.count) {
    // 同花顺只内联首页成员，不是全量，得说清楚，否则模型会当成「该板块就这么多股票」
    out.push(`成分股：接口返回 ${board.count} 只（同花顺板块页只内联首页，非全量）`)
  }
  if (m.up != null || m.down != null) out.push(`涨跌家数：涨 ${m.up ?? '?'} / 跌 ${m.down ?? '?'}`)
  if (m.leader) out.push(`领涨股：${m.leader}${m.leaderPct != null ? ` ${m.leaderPct}%` : ''}`)
  if (m.netInflow != null) out.push(`主力净流入：${m.netInflow} 亿`)
  return out
}

const SYSTEM_PROMPT =
  '你是一名克制的证券分析师。基于给定的行情数据与资讯标题做结构化解读，用简体中文输出。' +
  '**先分项分析、最后再下结论**：不要一上来就抛判断 —— 顶部横幅要的是你把所有分项都看过一遍之后' +
  '综合出来的定论，不是顺口说的第一个词。\n' +
  '**必须严格按下面的小标题顺序输出，一个都不能少，也不要另加小标题：**\n' +
  '## 短期（1-2 周）\n' +
  '## 中期（1-3 个月）\n' +
  '## 长期（6-12 个月）\n' +
  '上面三段各给可执行的观察/应对倾向（观望 / 分批参与 / 减仓等）与**量化参考**：' +
  '尽量带上支撑位、压力位、目标区间、涨跌幅幅度这类具体数字，' +
  '数字后面用「%」「倍」「点」等单位。数据里推不出来的就明说「无数据支撑」，不要编。\n' +
  '## 走势结构\n' +
  '## 量价与均线\n' +
  '## 热点/消息面\n' +
  '必须结合给出的资讯标题来写：标题与该标的就说明它可能的影响，并注明「标题层面的信息、未经证实」；' +
  '没有相关资讯就照实写「暂无相关热点资讯」，绝不凭空编造消息或传闻。\n' +
  '## 风险提示\n' +
  '也要点出与资讯相关的风险（如事件不确定性），以及上面各段里彼此矛盾的地方。\n' +
  '## 结论\n' +
  '**这一节放在最后**，是对上面所有分项的归纳。第一行只写倾向判断，用**加粗**包住，' +
  '必须是「看多」「中性」「看空」三者之一，例：**中性**，短期偏多但长期均线压制，方向暂不明朗。\n' +
  '随后用 2-4 句说明这个判断怎么来的 —— 要点出分项之间哪些互相支持、哪些互相矛盾，' +
  '为什么最后落在这一档，而不是把前面某一段原样抄一遍。\n' +
  '只描述数据里能看到的事实；标注为未取到的字段就直说没有，不要估算。' +
  '结论段只给倾向判断和理由，不要写成买卖指令（如「建议在 X 元买入」）。' +
  '最后一行必须写「以上仅为数据分析，不构成投资建议」。'

route('POST', /^\/api\/ai\/interpret$/, async (ctx) => {
  const body = await readBody(ctx.req, 8 * 1024)
  const secid = String(body.secid || '')
  const name = String(body.name || '').slice(0, 40)
  if (!/^\d+\.[A-Za-z0-9._-]+$/.test(secid)) throw new HttpError(400, 'secid 不合法')

  const cfg = await aiConfig(DATA_DIR)
  if (!cfg.apiKey) throw new HttpError(503, 'AI 解读未配置')
  if (!cfg.visitorAi && !ctx.scope.isOwner) throw new HttpError(403, '访客不可用 AI 解读')
  if (rateLimited(`ai:${ctx.scope.scopeKey}`, 10, 60_000)) throw new HttpError(429, '请求太频繁，请稍后再试')

  const question = String(body.question || '').slice(0, 500)
  const context = await buildContext(secid, name)

  const { res } = ctx
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  })

  const frame = (obj) => res.write(`data: ${JSON.stringify(obj)}\n`)
  const controller = new AbortController()
  ctx.req.on('close', () => controller.abort())

  try {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `以下是该标的的行情与资讯：\n\n${context}\n\n${question ? `我的问题：${question}\n\n` : ''}请解读。`,
      },
    ]
    const result = await streamChat({
      config: cfg,
      messages,
      sessionId: crypto.randomUUID(),
      signal: controller.signal,
      onDelta: ({ content }) => frame({ delta: { content } }),
    })
    frame({ done: true, text: result.text, usage: result.usage })
  } catch (err) {
    frame({ error: { message: err instanceof Error ? err.message : String(err) } })
  } finally {
    res.end()
  }
  return undefined
})

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// ---- 静态资源 ----

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const target = path.join(DIST, rel)
  if (!target.startsWith(DIST)) {
    sendJson(res, 403, { error: 'forbidden' })
    return
  }
  let stat = null
  try {
    stat = await fsp.stat(target)
  } catch {
    stat = null
  }
  if (!stat || stat.isDirectory()) {
    // SPA 回退
    const html = await fsp.readFile(path.join(DIST, 'index.html')).catch(() => null)
    if (!html) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('未构建前端：先执行 npm run build')
      return
    }
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' })
    res.end(html)
    return
  }
  const ext = path.extname(target).toLowerCase()
  const immutable = rel.startsWith('assets/')
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  fs.createReadStream(target).pipe(res)
}

// ---- 主处理 ----

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  const pathname = url.pathname

  /*
   * 站长兜底：/?owner=<token> 换 stock_owner cookie。
   * 必须放在静态分支之前 —— '/' 由 serveStatic 直接返回，走不到下面那段
   * cookie 下发，README 写的「访问 /?owner=<token> 进站长模式」原先根本无效。
   * 非 API 路径种完 cookie 就 302 回不带 token 的干净 URL，别把它留在地址栏里。
   */
  const ownerParam = url.searchParams.get('owner')
  if (ownerParam && ownerParam !== ownerToken()) {
    sendJson(res, 403, { error: '站长 token 不对' })
    return
  }
  if (ownerParam && !pathname.startsWith('/api/')) {
    url.searchParams.delete('owner')
    res.writeHead(302, {
      Location: `${url.pathname}${url.search}`,
      'Set-Cookie': cookieHeader('stock_owner', ownerToken()),
    })
    res.end()
    return
  }

  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    await serveStatic(req, res, pathname)
    return
  }

  const scope = resolveScope(req)
  const headers = {}
  const own = scope.cid
  const sent = parseSentCid(req)
  const cookies = []
  if (!sent) cookies.push(cookieHeader('stock_cid', own))
  if (url.searchParams.get('owner') && url.searchParams.get('owner') === ownerToken()) {
    cookies.push(cookieHeader('stock_owner', ownerToken()))
  }
  if (cookies.length) headers['Set-Cookie'] = cookies

  try {
    const hit = routes.find((r) => r.method === req.method && r.pattern.test(pathname))
    if (!hit) {
      sendJson(res, 404, { error: 'not found' }, headers)
      return
    }
    const body = await hit.handler({ req, res, url, scope, headers })
    if (body !== undefined) sendJson(res, 200, body, headers)
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 502
    const message = err instanceof Error ? err.message : '服务端错误'
    if (res.headersSent) {
      res.end()
      return
    }
    sendJson(res, status, { error: message }, headers)
  }
})

function parseSentCid(req) {
  const raw = req.headers.cookie || ''
  return raw.split(';').some((p) => p.trim().startsWith('stock_cid='))
}

server.listen(PORT, HOST, () => {
  const token = process.env.STOCK_OWNER_TOKEN ? '' : '（见数据目录 owner.token）'
  console.log(`[stock] listening on http://${HOST}:${PORT}${token}`)
  console.log(`[stock] data dir: ${DATA_DIR}`)
  console.log(`[stock] upstream: ${JSON.stringify(upstreamStatus())}`)
})

export { server }