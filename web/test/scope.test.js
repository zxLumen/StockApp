import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { cookieHeader, newCid, parseCookies, resolveScope, validBlogAdmin } from '../lib/scope.js'

test('parseCookies: 解析 / 截断 / 空值', () => {
  assert.deepEqual(parseCookies({ headers: { cookie: 'a=1; b=2' } }), { a: '1', b: '2' })
  assert.deepEqual(parseCookies({ headers: {} }), {})
  assert.deepEqual(parseCookies({ headers: { cookie: 'a=1; =x; c=3' } }), { a: '1', c: '3' })
  assert.deepEqual(parseCookies({ headers: { cookie: 'zx_mock=abc; ' } }), { zx_mock: 'abc' })
})

test('newCid 是 16 位小写 hex', () => {
  const c = newCid()
  assert.match(c, /^[0-9a-f]{16}$/)
  assert.notEqual(c, newCid())
})

test('访客：各自 scopeKey = cid', () => {
  process.env.STOCK_OWNER_TOKEN = 'ownertoken'
  const a = resolveScope({ headers: { cookie: 'stock_cid=aaaaaaaaaaaaaaaa' } })
  const b = resolveScope({ headers: { cookie: 'stock_cid=bbbbbbbbbbbbbbbb' } })
  assert.equal(a.isOwner, false)
  assert.equal(a.scopeKey, 'aaaaaaaaaaaaaaaa')
  assert.equal(b.scopeKey, 'bbbbbbbbbbbbbbbb')
})

test('站长：scopeKey 固定为 owner', () => {
  process.env.STOCK_OWNER_TOKEN = 'ownertoken'
  const s = resolveScope({ headers: { cookie: 'stock_owner=ownertoken' } })
  assert.equal(s.isOwner, true)
  assert.equal(s.scopeKey, 'owner')
})

test('站长开 MOCK：按模拟身份分域，不再享有 owner 权限', () => {
  process.env.STOCK_OWNER_TOKEN = 'ownertoken'
  const s = resolveScope({ headers: { cookie: 'stock_owner=ownertoken; zx_mock=cccccccccccccccc' } })
  assert.equal(s.isOwner, false)
  assert.equal(s.mocked, true)
  assert.equal(s.scopeKey, 'cccccccccccccccc')
})

test('非站长带 zx_mock 不生效（仍是自己的 cid）', () => {
  process.env.STOCK_OWNER_TOKEN = 'ownertoken'
  const s = resolveScope({ headers: { cookie: 'stock_cid=aaaaaaaaaaaaaaaa; zx_mock=cccccccccccccccc' } })
  assert.equal(s.scopeKey, 'aaaaaaaaaaaaaaaa')
})

test('cid 非法时重新生成，不接受外部伪造', () => {
  process.env.STOCK_OWNER_TOKEN = 'ownertoken'
  const s = resolveScope({ headers: { cookie: 'stock_cid=../../etc/passwd' } })
  assert.notEqual(s.scopeKey, '../../etc/passwd')
  assert.match(s.scopeKey, /^[0-9a-f]{16}$/)
})

test('博客管理员 cookie：同构 HMAC 验签', () => {
  const secret = 'test-secret'
  process.env.SESSION_SECRET = secret
  const exp = Date.now() + 60_000
  const sig = crypto.createHmac('sha256', secret).update(String(exp)).digest('hex')
  assert.equal(validBlogAdmin({ zx_admin: `${exp}.${sig}` }), true)
  assert.equal(validBlogAdmin({ zx_admin: `${exp}.${'0'.repeat(64)}` }), false)
  assert.equal(validBlogAdmin({ zx_admin: `${Date.now() - 1000}.${sig}` }), false)
  assert.equal(validBlogAdmin({ zx_admin: 'garbage' }), false)
  assert.equal(validBlogAdmin({}), false)
  const saved = process.env.SESSION_SECRET
  delete process.env.SESSION_SECRET
  assert.equal(validBlogAdmin({ zx_admin: `${exp}.${sig}` }), false)
  process.env.SESSION_SECRET = saved
})

test('cookieHeader 带 Path/HttpOnly/SameSite', () => {
  const h = cookieHeader('stock_cid', 'abc')
  assert.match(h, /^stock_cid=abc; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax$/)
})