import { fetchJson, fetchJsonp, cached } from './http.js'

// push2 / push2his 会按来源 IP 掐连接（直接关掉，不给状态码），只能靠镜像错开。
// 每个池记住上次成功的那个，失败时才换；主域名一般最不容易被封。
const klinePool = hostPool([
  'https://push2his.eastmoney.com',
  'https://1.push2his.eastmoney.com',
  'https://2.push2his.eastmoney.com',
  'https://3.push2his.eastmoney.com',
])
const quotePool = hostPool([
  'https://push2.eastmoney.com',
  'https://1.push2.eastmoney.com',
  'https://2.push2.eastmoney.com',
  'https://3.push2.eastmoney.com',
])
const SEARCH_API = 'https://searchapi.eastmoney.com/api/suggest/get'
const SEARCH_TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8'
const FUND_NAV_HOST = 'https://api.fund.eastmoney.com'
const FUND_MOB_HOST = 'https://fundmobapi.eastmoney.com'
const FUND_SUGGEST = 'https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx'

/**
 * 镜像池：优先用上次成功的主机；失败就换下一个试（最多试 2 个）。
 * 全部失败时抛最后一次错误。
 */
function hostPool(hosts) {
  let preferred = 0
  return async function withPool(pathAndQuery) {
    let lastErr
    const tried = []
    for (let i = 0; i < 2; i += 1) {
      const idx = (preferred + i) % hosts.length
      tried.push(hosts[idx])
      try {
        const out = await fetchJson(hosts[idx] + pathAndQuery)
        preferred = idx
        return out
      } catch (err) {
        lastErr = err
      }
    }
    // 上游会直接掐连接，前端的「重试」提示没有意义，统一成一句可读的话。
    throw new Error(`行情上游暂不可用（已试 ${tried.map((h) => h.replace('https://', '')).join(' / ')}）`)
  }
}

const enc = encodeURIComponent
const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * 港股指数与美股指数共用 `100.` 前缀（恒生 100.HSI / 道指 100.DJIA），
 * 只能靠代码区分；港股个股是 `116.`。
 */
const HK_INDEX_CODES = new Set(['HSI', 'HSCEI', 'HSTECH', 'HSCCI', 'HSCCOEX', 'HSTECHH'])

/** 东财 secid → 市场。0/1=A股(沪/深) 116=港股 100/105/106/107/155=美股 90=板块 */
export function marketOf(secid) {
  const [m, code = ''] = String(secid || '').split('.')
  // 90 = 板块（东财 90.BKxxxx / 同花顺 90.881xxx、90.885xxx、90.886xxx）
  // 91 = 中证一级行业指数（91.000928 … 91.000937），同样是板块口径
  if (m === '90' || m === '91') return 'board'
  if (m === '116') return 'hk'
  if (HK_INDEX_CODES.has(code.toUpperCase())) return 'hk'
  if (['100', '105', '106', '107', '153', '155'].includes(m)) return 'us'
  if (m === '0' || m === '1') return 'cn'
  return 'cn'
}

export const MARKETS = ['cn', 'us', 'fund']

export const INDEX_GROUPS = {
  cn: [
    { secid: '1.000001', name: '上证指数' },
    { secid: '0.399001', name: '深证成指' },
    { secid: '0.399006', name: '创业板指' },
    { secid: '100.HSI', name: '恒生指数' },
    { secid: '124.HSTECH', name: '恒生科技' },
  ],
  us: [
    { secid: '100.DJIA', name: '道琼斯' },
    { secid: '100.NDX', name: '纳斯达克100' },
    { secid: '100.SPX', name: '标普500' },
  ],
}

const KLT = { d: 101, w: 102, m: 103, m5: 5, m15: 15, m30: 30, m60: 60 }
export const KLINE_PERIODS = [
  { key: 'd', label: '日K' },
  { key: 'w', label: '周K' },
  { key: 'm', label: '月K' },
  { key: 'm60', label: '60分' },
  { key: 'm30', label: '30分' },
  { key: 'm15', label: '15分' },
  { key: 'm5', label: '5分' },
]

const MA_WINDOWS = [5, 10, 20]

export function withMa(bars) {
  return bars.map((bar, i) => {
    const out = { ...bar }
    for (const w of MA_WINDOWS) {
      if (i + 1 < w) {
        out[`ma${w}`] = null
        continue
      }
      let sum = 0
      for (let k = i - w + 1; k <= i; k += 1) sum += bars[k].close
      out[`ma${w}`] = Number((sum / w).toFixed(3))
    }
    return out
  })
}

/**
 * 从前收推导涨跌额 / 涨跌幅 / 振幅，**只补上游没给的**。
 *
 * 腾讯 / 新浪的 K 线只有 [时间,开,收,高,低,量]，压根没有这三个字段；而本机
 * 东财的 kline 通道常年被掐（见 lib/http.js 里 undici 被封、需走 OpenSSL 那段），
 * 于是 AI 解读拿到的全是 NA，模型只能自己说「无法评估量价与资金活跃度」。
 *
 * 这三个值可以精确还原，东财自己的公式就是这样：
 *   涨跌额 = 收盘 − 前收   涨跌幅 = 涨跌额 / 前收   振幅 = (最高 − 最低) / 前收
 * 拿 600519 的 2026-10-02 对过：1.86% / 23.04 / 2.59，与东财逐位一致。
 * 成交额和换手率**不能**这样推（OHLCV 里没有），仍得靠行情快照补。
 */
export function withDerived(bars) {
  return bars.map((bar, i) => {
    const out = { ...bar }
    const prev = i > 0 ? bars[i - 1].close : null
    if (!(prev > 0) || out.close == null) return out
    if (out.change == null) out.change = Number((out.close - prev).toFixed(2))
    if (out.changePct == null) out.changePct = Number(((out.change / prev) * 100).toFixed(2))
    if (out.amplitude == null && out.high != null && out.low != null) {
      out.amplitude = Number((((out.high - out.low) / prev) * 100).toFixed(2))
    }
    return out
  })
}

/** K 线（含 MA5/10/20）。字段顺序为 日期,开,收,高,低,量(手),额,振幅,涨跌%,涨跌额,换手% */
export async function getKline(secid, { period = 'd', fq = 1, limit = 240 } = {}) {
  const klt = KLT[period] || 101
  const pathAndQuery =
    `/api/qt/stock/kline/get?secid=${enc(secid)}` +
    `&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61` +
    `&klt=${klt}&fqt=${fq}&end=20500101&lmt=${Math.min(600, Math.max(20, limit))}`
  const json = await cached(`k:${secid}:${klt}:${fq}:${limit}`, 5 * 60_000, () => klinePool(pathAndQuery))
  const d = json?.data
  if (!d || !Array.isArray(d.klines) || !d.klines.length) throw new Error('无 K 线数据')
  const bars = d.klines.map((line) => {
    const c = line.split(',')
    return {
      time: c[0],
      open: num(c[1]),
      close: num(c[2]),
      high: num(c[3]),
      low: num(c[4]),
      volume: num(c[5]),
      amount: num(c[6]),
      amplitude: num(c[7]),
      changePct: num(c[8]),
      change: num(c[9]),
      turnover: num(c[10]),
    }
  })
  return {
    secid: d.market != null && d.code ? `${d.market}.${d.code}` : secid,
    code: d.code ?? null,
    market: marketOf(d.market != null && d.code ? `${d.market}.${d.code}` : secid),
    name: d.name ?? null,
    bars: withDerived(withMa(bars)),
  }
}

const QUOTE_FIELDS = 'f1,f2,f3,f4,f5,f6,f8,f12,f13,f14,f15,f16,f17,f18,f20,f21'

export function decodeQuote(x) {
  const d = num(x.f1) ?? 2
  const p = 10 ** d
  const secid = `${x.f13}.${x.f12}`
  return {
    secid,
    code: x.f12,
    name: x.f14,
    market: marketOf(secid),
    price: num(x.f2) != null ? Number((num(x.f2) / p).toFixed(3)) : null,
    changePct: num(x.f3) != null ? Number((num(x.f3) / p).toFixed(2)) : null,
    change: num(x.f4) != null ? Number((num(x.f4) / p).toFixed(3)) : null,
    high: num(x.f15) != null ? Number((num(x.f15) / p).toFixed(3)) : null,
    low: num(x.f16) != null ? Number((num(x.f16) / p).toFixed(3)) : null,
    open: num(x.f17) != null ? Number((num(x.f17) / p).toFixed(3)) : null,
    prevClose: num(x.f18) != null ? Number((num(x.f18) / p).toFixed(3)) : null,
    volume: num(x.f5),
    amount: num(x.f6),
    turnover: num(x.f8) != null ? Number((num(x.f8) / 100).toFixed(2)) : null,
    marketCap: num(x.f20),
    floatCap: num(x.f21),
  }
}

/** 批量实时快照（自选股页用）。一次最多 50 个，自动分批。 */
export async function getQuotes(secids) {
  const list = [...new Set(secids.filter(Boolean))]
  if (!list.length) return []
  const batches = []
  for (let i = 0; i < list.length; i += 50) batches.push(list.slice(i, i + 50))
  const out = []
  for (const batch of batches) {
    const pathAndQuery = `/api/qt/ulist.np/get?fields=${QUOTE_FIELDS}&secids=${batch.map(enc).join(',')}`
    const json = await cached(`q:${batch.join(',')}`, 10_000, () => quotePool(pathAndQuery))
    const diff = json?.data?.diff
    if (!diff) continue
    for (const x of Array.isArray(diff) ? diff : Object.values(diff)) {
      if (x && x.f12) out.push(decodeQuote(x))
    }
  }
  return out
}

export function mapSuggest(x) {
  const secid = x.QuoteID || `${x.MktNum}.${x.Code}`
  return {
    code: x.Code,
    name: x.Name,
    secid,
    market: marketOf(secid),
    classify: x.Classify || null,
    type: x.SecurityTypeName || null,
    exchange: x.JYS || null,
  }
}

/** 搜索建议：代码 / 名称 / 拼音首字母，跨 A股 / 美股 / 场内基金 / 指数。板块另走 getBoards。 */
export async function searchSuggest(input, { limit = 12 } = {}) {
  const q = String(input || '').trim()
  if (!q) return []
  const url = `${SEARCH_API}?input=${enc(q)}&type=14&token=${SEARCH_TOKEN}&count=${Math.min(30, limit * 2)}`
  const json = await cached(`s:${q}:${limit}`, 10 * 60_000, () => fetchJson(url))
  const rows = json?.QuotationCodeTable?.Data || []
  const seen = new Set()
  const out = []
  for (const x of rows) {
    const item = mapSuggest(x)
    if (!item.secid || item.market === 'board' || seen.has(item.secid)) continue
    seen.add(item.secid)
    out.push(item)
    if (out.length >= limit) break
  }
  return out
}

function normalizeDiff(diff) {
  if (!diff) return []
  return Array.isArray(diff) ? diff : Object.values(diff)
}

/** 行业 / 概念板块涨跌幅榜。 */
export async function getBoards(kind = 'industry', { limit = 24 } = {}) {
  const t = kind === 'concept' ? 3 : 2
  const pathAndQuery =
    `/api/qt/clist/get?fltt=2&invt=2&fid=f3&pn=1&pz=${limit}&po=1` +
    `&fs=m:90+t:${t}+f:!50&fields=f2,f3,f12,f14,f104,f105,f128,f136,f140`
  const json = await cached(`b:${kind}:${limit}`, 30_000, () => quotePool(pathAndQuery))
  return normalizeDiff(json?.data?.diff)
    .filter((x) => x && x.f12)
    .map((x) => ({
      code: x.f12,
      secid: `90.${x.f12}`,
      name: x.f14,
      index: num(x.f2),
      changePct: num(x.f3),
      up: num(x.f104),
      down: num(x.f105),
      leader: x.f128 || null,
      leaderCode: x.f140 || null,
      leaderPct: num(x.f136),
    }))
}

/** 板块成分股：东财的 b: 过滤与 90.BK 的板块指数当前都取不到，退化为「按板块名搜索个股」。 */
export async function getBoardMembers(boardName, { limit = 12 } = {}) {
  const rows = await searchSuggest(boardName, { limit: limit + 8 })
  return rows.filter((r) => r.market === 'cn' && r.classify === 'AStock').slice(0, limit)
}

// ---- 场外基金 ----

export function cleanHtml(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export async function fundSuggest(keyword, { limit = 10 } = {}) {
  const q = String(keyword || '').trim()
  if (!q) return []
  const url = `${FUND_SUGGEST}?m=1&key=${enc(q)}&callback=cb`
  const json = await cached(`fs:${q}:${limit}`, 10 * 60_000, () => fetchJsonp(url))
  const rows = Array.isArray(json?.Datas) ? json.Datas : []
  return rows
    .map((x) => ({
      code: x.CODE,
      name: cleanHtml(x.NAME),
      type: cleanHtml(x.FundBaseInfo?.FTYPE || '') || null,
      pinyin: cleanHtml(x.JP || '') || null,
    }))
    .filter((x) => x.code)
    .slice(0, limit)
}

export async function fundNav(code, { limit = 180 } = {}) {
  const url =
    `${FUND_NAV_HOST}/f10/lsjz?fundCode=${enc(code)}` +
    `&pageIndex=1&pageSize=${Math.min(600, Math.max(20, limit))}`
  const json = await cached(`fn:${code}:${limit}`, 10 * 60_000, () =>
    fetchJson(url, { headers: { Referer: 'https://fundf10.eastmoney.com/' } }),
  )
  const list = json?.Data?.LSJZList || []
  const points = list
    .map((r) => ({ date: r.FSRQ, nav: num(r.DWJZ), accNav: num(r.LJJZ), changePct: num(r.JZZZL) }))
    .filter((p) => p.date && p.nav != null)
    .reverse()
  if (!points.length) throw new Error('无净值数据')
  const last = points[points.length - 1]
  return {
    code,
    nav: last.nav,
    accNav: last.accNav,
    changePct: last.changePct,
    points,
  }
}

export async function fundQuotes(codes) {
  const list = [...new Set(codes.filter(Boolean))]
  if (!list.length) return []
  const url =
    `${FUND_MOB_HOST}/FundMNewApi/FundMNFInfo?plat=Android&appType=ttjj&product=EFund` +
    `&Version=1&deviceid=stock-web&pageIndex=1&pageSize=${Math.max(20, list.length)}&Fcodes=${list.join(',')}`
  const json = await cached(`fq:${list.join(',')}`, 10_000, () =>
    fetchJson(url, { headers: { Referer: 'https://fund.eastmoney.com/' } }),
  )
  const rows = Array.isArray(json?.Datas) ? json.Datas : []
  return rows.map((r) => ({
    code: r.FCODE,
    name: r.SHORTNAME,
    nav: num(r.NAV),
    accNav: num(r.ACCNAV),
    changePct: num(r.NAVCHGRT),
    date: r.PDATE,
  }))
}