import { fetchGbk, cached } from './http.js'

// 新浪板块：与被封的东财 push2 不同主机，实测稳定。行业 / 概念都是 GBK 的
// `var S_Finance_bankuai_xxx = {...}`，成分股走 Market_Center.getHQNodeData。
const HY_URL = 'https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php'
const GN_URL = 'https://money.finance.sina.com.cn/q/view/newFLJK.php?param=class'
const NODE_URL = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData'

const HDRS = { Referer: 'https://finance.sina.com.cn/' }

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 去掉 `var S_Finance_bankuai_xxx = ` 前缀，取 JSON 体。 */
function unwrap(text) {
  const s = String(text || '')
  const i = s.indexOf('{')
  const j = s.lastIndexOf('}')
  if (i < 0 || j <= i) return {}
  const body = s.slice(i, j + 1)
  try {
    return JSON.parse(body)
  } catch {
    return {}
  }
}

/**
 * 新浪板块字段：`code,name,count,avgPrice,change,changePct,volume,amount,
 *                 leaderSymbol,leaderPct,leaderPrice,leaderChange,...,leaderName`
 * 涨/跌家数新浪不提供（置 null）。
 */
export function parseSinaBoards(text) {
  const map = unwrap(text)
  const out = []
  for (const raw of Object.values(map)) {
    const f = String(raw || '').split(',')
    if (f.length < 13 || !f[0] || !f[1]) continue
    const leaderName = f[12] || null
    out.push({
      code: f[0],
      secid: f[0],
      name: f[1],
      index: num(f[3]),
      changePct: num(f[5]),
      up: null,
      down: null,
      leader: leaderName,
      leaderCode: f[8] || null,
      leaderPct: num(f[9]),
    })
  }
  return out
}

export async function sinaBoards(kind = 'industry', { limit = 24 } = {}) {
  const url = kind === 'concept' ? GN_URL : HY_URL
  const text = await cached(`sboard:${kind}`, 60_000, () => fetchGbk(url, { headers: HDRS }))
  return parseSinaBoards(text)
    .sort((a, b) => (b.changePct ?? -Infinity) - (a.changePct ?? -Infinity))
    .slice(0, limit)
}

/** `sz300395` → `0.300395`，`sh600519` → `1.600519`。 */
export function sinaSymbolToSecid(symbol) {
  const s = String(symbol || '').toLowerCase()
  const m = /^(sh|sz|bj)(\d{6})$/.exec(s)
  if (!m) return null
  const prefix = m[1] === 'sh' ? '1' : '0'
  return `${prefix}.${m[2]}`
}

/** Market_Center.getHQNodeData 的成分股数组 → 统一结构。 */
export function parseSinaBoardMembers(rows) {
  if (!Array.isArray(rows)) return []
  return rows
    .map((x) => {
      const secid = sinaSymbolToSecid(x.symbol)
      if (!secid) return null
      return {
        secid,
        code: String(x.code || x.symbol || '').replace(/^(sh|sz|bj)/, ''),
        name: String(x.name || '').trim(),
        price: num(x.trade),
        changePct: num(x.changepercent),
      }
    })
    .filter((x) => x && x.name)
}

export async function sinaBoardMembers(node, { limit = 40 } = {}) {
  const code = String(node || '').trim()
  if (!code) return []
  const n = Math.min(80, Math.max(5, limit))
  const url = `${NODE_URL}?page=1&num=${n}&sort=changepercent&asc=0&node=${encodeURIComponent(code)}`
  const text = await cached(`smem:${code}:${n}`, 60_000, () => fetchGbk(url, { headers: HDRS }))
  let rows
  try {
    rows = JSON.parse(text)
  } catch {
    return []
  }
  return parseSinaBoardMembers(rows).slice(0, n)
}
