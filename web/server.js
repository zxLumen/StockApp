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
import { getBoards, getBoardMembers, getKline, getQuotes, SOURCES, sourceLabel } from './lib/market.js'
import { fundHot, fundNavSeries, fundRank, FUND_RANK_SORTS } from './lib/fund.js'
import { marketNews, stockNews } from './lib/news.js'
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
  const kind = ctx.url.searchParams.get('kind') === 'concept' ? 'concept' : 'industry'
  const limit = Math.min(60, Number(ctx.url.searchParams.get('limit')) || 24)
  const { items, source } = await getBoards(kind, { limit })
  return { kind, items, source, sourceLabel: sourceLabel(source) }
})

route('GET', /^\/api\/market\/board\/members$/, async (ctx) => {
  const name = ctx.url.searchParams.get('name') || ''
  const code = ctx.url.searchParams.get('code') || ''
  if (!name && !code) throw new HttpError(400, '缺少 name 或 code')
  const { items, source } = await getBoardMembers({ code, name }, { limit: 12 })
  return { name, items, source, sourceLabel: sourceLabel(source) }
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
  if (kind === 'stock') {
    const name = ctx.url.searchParams.get('name') || ''
    const code = ctx.url.searchParams.get('code') || ''
    const out = await stockNews([name, code].filter(Boolean), { limit: 8 })
    return { kind, ...out }
  }
  return { kind, items: await marketNews({ limit: Number(ctx.url.searchParams.get('limit')) || 20 }) }
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

/** 把行情与新闻压成一段紧凑上下文，交给模型解读。 */
async function buildContext(secid, name) {
  const [kline, quote, news] = await Promise.all([
    getKline(secid, { period: 'd', limit: 60 }).catch(() => null),
    getQuotes([secid]).catch(() => []),
    stockNews([name], { limit: 6 }).catch(() => ({ items: [] })),
  ])
  const bars = kline?.bars || []
  const last = bars[bars.length - 1] || null
  const closes = bars.map((b) => b.close)
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null)
  const fmt = (n, d = 2) => (n == null ? 'NA' : n.toFixed(d))
  const lines = [
    `标的：${name || kline?.name || secid}（${secid}）`,
    `最新：${fmt(last?.close)}  涨跌：${fmt(last?.changePct)}%  振幅：${fmt(last?.amplitude)}%`,
    `成交量：${fmt(last?.volume, 0)} 手  成交额：${fmt(last?.amount, 0)} 元  换手：${fmt(last?.turnover)}%`,
    `MA5=${fmt(last?.ma5)}  MA10=${fmt(last?.ma10)}  MA20=${fmt(last?.ma20)}`,
    `近20日均价 ${fmt(avg(closes.slice(-20)))}  近60日均价 ${fmt(avg(closes.slice(-60)))}`,
    `区间：60日高 ${fmt(Math.max(...closes))}  60日低 ${fmt(Math.min(...closes))}`,
    quote[0] ? `总市值 ${fmt(quote[0].marketCap, 0)} 元  流通市值 ${fmt(quote[0].floatCap, 0)} 元` : '',
    '',
    '近期相关资讯标题：',
    ...(news.items || []).map((n, i) => `${i + 1}. ${n.title}`),
  ].filter(Boolean)
  return lines.join('\n')
}

const SYSTEM_PROMPT =
  '你是一名克制的证券分析师。基于给定的行情数据与资讯标题做结构化解读，' +
  '用简体中文输出，包含三个小标题：走势结构、量价与均线、风险提示。' +
  '只描述数据里能看到的事实，不要编造消息，不要给出买卖建议，最后一行必须写「以上仅为数据分析，不构成投资建议」。'

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