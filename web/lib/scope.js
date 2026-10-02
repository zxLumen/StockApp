import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const CID_COOKIE = 'stock_cid'
const OWNER_COOKIE = 'stock_owner'
const BLOG_ADMIN_COOKIE = 'zx_admin'
const MOCK_COOKIE = 'zx_mock'

export const DATA_DIR = process.env.STOCK_DATA_DIR || path.join(process.cwd(), 'data')

export function parseCookies(req) {
  const raw = req.headers.cookie || ''
  /** @type {Record<string,string>} */
  const out = {}
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

/** 站长兜底 token：环境变量优先，否则在数据目录生成一份 0600 的。 */
export function ownerToken() {
  if (process.env.STOCK_OWNER_TOKEN) return process.env.STOCK_OWNER_TOKEN
  const file = path.join(DATA_DIR, 'owner.token')
  try {
    const t = fs.readFileSync(file, 'utf8').trim()
    if (t) return t
  } catch {
    /* 首次启动还没有 */
  }
  const t = crypto.randomBytes(16).toString('hex')
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(file, `${t}\n`, { mode: 0o600 })
  } catch {
    /* 只读文件系统时降级为内存态 */
  }
  return t
}

/**
 * 博客下发的管理员会话 cookie（`zx_admin` = `<exp>.<hmac_sha256(exp, SESSION_SECRET)>`）。
 * 与主站 apps/next-home/src/lib/auth.ts 同构——同一把 SESSION_SECRET 才能验签通过。
 */
export function validBlogAdmin(cookies) {
  const secret = process.env.SESSION_SECRET
  if (!secret) return false
  const v = cookies[BLOG_ADMIN_COOKIE]
  if (!v) return false
  const i = v.indexOf('.')
  if (i < 0) return false
  const exp = Number(v.slice(0, i))
  const sig = v.slice(i + 1)
  if (!Number.isFinite(exp) || exp < Date.now()) return false
  const expected = crypto.createHmac('sha256', secret).update(String(exp)).digest('hex')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export function newCid() {
  return crypto.randomBytes(8).toString('hex')
}

/** 访客 / 站长 / 站长模拟访客，三种数据域。 */
export function resolveScope(req) {
  const cookies = parseCookies(req)
  const token = ownerToken()
  const isRealOwner = (!!token && cookies[OWNER_COOKIE] === token) || validBlogAdmin(cookies)
  const own = cookies[CID_COOKIE]
  const cid = /^[0-9a-f]{16}$/.test(own || '') ? own : newCid()
  const mock = cookies[MOCK_COOKIE]
  const mockOk = /^[0-9a-f]{16}$/.test(mock || '')
  // 站长开 MOCK 后，该请求整体按普通访客处理：不享受站长特权，数据也落在模拟身份名下。
  const mocked = isRealOwner && mockOk
  const effectiveCid = mocked ? mock : cid
  return {
    isOwner: isRealOwner && !mocked,
    mocked,
    cid: effectiveCid,
    scopeKey: isRealOwner && !mocked ? 'owner' : effectiveCid,
  }
}

export function cookieHeader(name, value, { maxAge = 60 * 60 * 24 * 365 } = {}) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`
}