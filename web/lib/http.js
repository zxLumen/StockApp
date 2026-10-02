import dns from 'node:dns'
import { setTimeout as delay } from 'node:timers/promises'

// 东财等上游在本机/部分网络下会解析到 IPv6 地址且「TCP 能连上但 TLS 握手不返回」，
// happy-eyeballs 认为已连上就不会回退 IPv4，请求就一直挂着（表现为 code=000 / 0 字节）。
// 强制 IPv4 优先，一次性绕开这类问题。
dns.setDefaultResultOrder('ipv4first')

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const MIN_GAP = 300
const BREAK_FAILS = 3
const BREAK_MS = 60_000

export class HttpError extends Error {
  constructor(status, message) {
    super(message || `上游 HTTP ${status}`)
    this.name = 'HttpError'
    this.status = status
  }
}

// ---- 上游节流 + 熔断 ----
// 东财是免费非官方接口，打太狠会被按来源 IP 临时掐掉（表现为连接被关 / 空 body）。
// 这里主动限速：每主机同时最多 1 个请求、最小间隔 120ms；连续失败 3 次则熔断 60s。
const HOSTS = new Map()

function hostState(host) {
  let st = HOSTS.get(host)
  if (!st) {
    st = { chain: Promise.resolve(), lastAt: 0, fails: 0, openUntil: 0 }
    HOSTS.set(host, st)
  }
  return st
}

/** 按主机排队 + 最小间隔；熔断打开时直接快速失败。 */
function throttle(host, run) {
  const st = hostState(host)
  const now = Date.now()
  if (st.openUntil > now) {
    return Promise.reject(new Error(`${host} 上游熔断中，稍后再试`))
  }
  const task = st.chain.then(async () => {
    const gap = Date.now() - st.lastAt
    if (gap < MIN_GAP) await delay(MIN_GAP - gap)
    st.lastAt = Date.now()
    return run()
  })
  // 无论成败都让队列继续
  st.chain = task.then(
    () => undefined,
    () => undefined,
  )
  return task
}

function recordSuccess(host) {
  const st = hostState(host)
  st.fails = 0
}

function recordFailure(host) {
  const st = hostState(host)
  st.fails += 1
  if (st.fails >= BREAK_FAILS) {
    st.openUntil = Date.now() + BREAK_MS
    st.fails = 0
  }
}

/** 手动复位所有主机的熔断状态（测试 / 上游恢复后立即重试）。 */
export function breakerReset() {
  for (const st of HOSTS.values()) {
    st.fails = 0
    st.openUntil = 0
  }
}

export function upstreamStatus() {
  return [...HOSTS.entries()].map(([host, st]) => ({
    host,
    fails: st.fails,
    cooling: st.openUntil > Date.now(),
  }))
}

/** 带超时 + 重试的原始字节抓取；空 body 视为失败（上游限流时常见）。 */
export async function fetchBuffer(url, { headers = {}, timeout = 8000, retries = 1 } = {}) {
  let host = ''
  try {
    host = new URL(url).host
  } catch {
    throw new Error('非法 URL')
  }
  let lastErr
  for (let i = 0; i <= retries; i += 1) {
    try {
      const buf = await throttle(host, async () => {
        const res = await fetch(url, {
          headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
          signal: AbortSignal.timeout(timeout),
          redirect: 'follow',
        })
        if (!res.ok) throw new HttpError(res.status)
        return Buffer.from(await res.arrayBuffer())
      })
      if (!buf.length || !buf.toString('latin1').trim()) throw new Error('上游返回空内容')
      recordSuccess(host)
      return buf
    } catch (err) {
      lastErr = err
      if (!String(err?.message || '').includes('熔断中')) recordFailure(host)
      if (i < retries) await delay(400 * (i + 1))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

export async function fetchText(url, opts = {}) {
  return (await fetchBuffer(url, opts)).toString('utf8')
}

/** 腾讯 / 新浪的行情接口返回 GBK，必须按字节解。 */
export async function fetchGbk(url, opts = {}) {
  return new TextDecoder('gbk').decode(await fetchBuffer(url, opts))
}

export async function fetchJson(url, opts = {}) {
  const text = await fetchText(url, opts)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('上游返回非 JSON')
  }
}

/** 抓 JSONP（`callback({...})`）并抽出 JSON 部分。 */
export async function fetchJsonp(url, opts = {}) {
  const text = await fetchText(url, opts)
  const start = text.indexOf('(')
  const end = text.lastIndexOf(')')
  if (start < 0 || end < start) throw new Error('上游返回非 JSONP')
  return JSON.parse(text.slice(start + 1, end))
}

// ---- 极简 TTL 缓存：并发合并 + stale-on-error ----
const cache = new Map()

export async function cached(key, ttlMs, producer) {
  const hit = cache.get(key)
  const now = Date.now()
  if (hit) {
    if (hit.inflight) return hit.inflight
    if (now - hit.at < ttlMs) return hit.value
  }
  const inflight = (async () => {
    try {
      const value = await producer()
      cache.set(key, { at: Date.now(), value })
      return value
    } catch (err) {
      // 上游抖动时宁可给旧数据，也不要整页空白
      if (hit && hit.value !== undefined) {
        cache.set(key, { at: Date.now(), value: hit.value })
        return hit.value
      }
      throw err
    }
  })()
  cache.set(key, { at: hit?.at ?? 0, value: hit?.value, inflight })
  return inflight
}

export function cacheClear() {
  cache.clear()
}