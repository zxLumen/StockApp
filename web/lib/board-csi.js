import { setTimeout as delay } from 'node:timers/promises'
import { fetchJson, cached } from './http.js'
import { withMa, withDerived } from './eastmoney.js'

// 中证指数官网（csindex.com.cn）：**官方口径**的 10 个中证一级行业指数，作为行业板块的第二源。
//
// 端点：`/csindex-home/perf/index-perf?indexCode=&startDate=&endDate=`
// 字段比任何一家都全：tradeDate / OHLC / change / changePct / tradingVol / tradingValue /
// **consNumber（成分股数）**。稳定 JSON、无需 cookie、无需 UA 特殊处理。
//
// 定位：**只有行业（10 个），没有概念**，所以只做行业链的备份与「官方口径」对照。
// 同花顺有 90 个行业但分类是同花顺自己的，两套口径不能互相映射，各自独立成分类展示。
// secid 用 `91.` 前缀（marketOf 里同样归 board），与同花顺的 `90.` 区分。
//
// 注意：官网没有指数枚举接口（`/index-list` 等一律 404），所以这 10 个代码是写死的
// —— 它们是中证一级行业的固定集合，不会变。

const HOST = 'https://www.csindex.com.cn/csindex-home/perf/index-perf'

/** 中证一级行业（800 系列）。名称用官方简称，长的全称在 K 线响应的 indexNameCnAll 里。 */
export const CSI_INDUSTRIES = [
  { code: '000928', name: '能源' },
  { code: '000929', name: '材料' },
  { code: '000930', name: '工业' },
  { code: '000931', name: '可选' },
  { code: '000932', name: '消费' },
  { code: '000933', name: '医卫' },
  { code: '000934', name: '金地' },
  { code: '000935', name: '信息' },
  { code: '000936', name: '通信' },
  { code: '000937', name: '公用' },
]

const isCsiCode = (code) => /^0009(2[89]|3[0-7])$/.test(String(code || ''))

const num = (v) => {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const ymd = (d) => d.toISOString().slice(0, 10)

/** 行业榜（结构和同花顺 / 新浪一致，前端可共用渲染）。 */
export async function csiBoardIndex({ limit = 40 } = {}) {
  const list = CSI_INDUSTRIES.map((x) => ({
    code: x.code,
    secid: `91.${x.code}`,
    kind: 'csi',
    name: x.name,
    fullName: `中证${x.name}指数`,
    index: null,
    changePct: null,
    up: null,
    down: null,
    volume: null,
    amount: null,
    leader: null,
    leaderCode: null,
    leaderPct: null,
  }))
  return list.slice(0, limit)
}

/** 官网只给日线，周 / 月由日线聚合（口径与东财的 klt 一致：本周 / 本月内聚合）。 */
function aggregate(bars, period) {
  if (period === 'd') return bars
  const keyOf = (time) => {
    const d = new Date(`${time}T00:00:00Z`)
    if (period === 'm') return `${time.slice(0, 7)}-01`
    // ISO 周：以周四定年（周四所在年份即该周归属年，避免跨年周错位）
    const day = (d.getUTCDay() + 6) % 7
    const thu = new Date(d.getTime() + (3 - day) * 86400_000)
    const jan1 = Date.UTC(thu.getUTCFullYear(), 0, 1)
    const week = Math.floor((thu.getTime() - jan1) / (7 * 86400_000)) + 1
    return `${thu.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
  }
  const out = []
  let cur = null
  let curKey = null
  for (const b of bars) {
    const k = keyOf(b.time)
    if (k !== curKey) {
      if (cur) out.push(cur)
      curKey = k
      cur = { time: k, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, amount: b.amount, amplitude: null, changePct: null, change: null, turnover: null }
    } else {
      cur.high = Math.max(cur.high ?? -Infinity, b.high ?? -Infinity)
      cur.low = Math.min(cur.low ?? Infinity, b.low ?? Infinity)
      cur.close = b.close
      cur.volume = (cur.volume ?? 0) + (b.volume ?? 0)
      cur.amount = (cur.amount ?? 0) + (b.amount ?? 0)
    }
  }
  if (cur) out.push(cur)
  return out
}

/**
 * 中证行业 K 线。要多少根就按日历天往前多取一些日线（周末 / 假期会少掉一部分），
 * 周线 ×7 天、月线 ×31 天。
 */
export async function csiBoardKline(code, { period = 'd', limit = 240 } = {}) {
  const c = String(code || '').trim()
  if (!isCsiCode(c)) throw new Error('非中证行业代码')
  const p = ['d', 'w', 'm'].includes(period) ? period : 'd'
  const want = Math.min(600, Math.max(20, limit))
  const HDRS = {
    Referer: `https://www.csindex.com.cn/#/indices/family/detail?indexCode=${c}`,
    Origin: "https://www.csindex.com.cn",
    Accept: "application/json, text/plain, */*",
  }
  const perBar = p === 'd' ? 1.5 : p === 'w' ? 9 : 34
  const end = new Date()
  const start = new Date(end.getTime() - want * perBar * 86400_000)
  const url =
    `${HOST}?indexCode=${c}&startDate=${ymd(start)}&endDate=${ymd(end)}`

  // 官网限流很凶，且**限流时返回 HTTP 200 + data:[]**（不报错、不 429）。实测连续十几次请求后
  // 会空上几分钟，连 curl 也一样，所以这不是客户端差异。
  //
  // 两个后果决定了写法：
  //   1) 缓存要长（1 小时）—— 10 个行业、用户不会频繁翻，只有这样才够用；
  //   2) 空响应**绝不能进缓存** —— 否则一次限流会把空结果钉住一小时。
  //      在 producer 内部抛错，cached 就不写缓存；同时它的 stale-on-error 会把上一次的好数据
  //      直接返回，页面照常有图。
  let rows = []
  for (const wait of [0, 4000, 10000]) {
    if (wait) await delay(wait)
    try {
      const json = await cached(`csik:${c}:${p}:${want}`, 60 * 60_000, async () => {
        const j = await fetchJson(url, { headers: HDRS })
        if (!Array.isArray(j?.data) || !j.data.length) throw new Error('中证返回空 data（限流）')
        return j
      })
      rows = json.data
      break
    } catch {
      rows = []
    }
  }
  if (!rows.length) throw new Error('中证行业 K 线暂不可用（官网限流，请稍后重试）')

  const bars = rows
    .map((d) => ({
      time: String(d?.tradeDate || '').trim(),
      open: num(d?.open),
      high: num(d?.high),
      low: num(d?.low),
      close: num(d?.close),
      volume: num(d?.tradingVol),
      amount: num(d?.tradingValue),
      amplitude: null,
      changePct: num(d?.changePct),
      change: num(d?.change),
      turnover: null,
    }))
    .filter((b) => /^\d{8}$/.test(b.time) && b.close != null)
    .sort((a, b) => a.time.localeCompare(b.time))
    .map((b) => ({ ...b, time: `${b.time.slice(0, 4)}-${b.time.slice(4, 6)}-${b.time.slice(6, 8)}` }))

  const merged = aggregate(bars, p).slice(-want)
  const last = rows.at(-1)
  return {
    secid: `91.${c}`,
    code: c,
    market: 'board',
    name: String(last?.indexNameCnAll || '').replace(/指数$/, '') || null,
    consNumber: num(last?.consNumber),
    bars: withDerived(withMa(merged)),
  }
}
