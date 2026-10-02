import test from 'node:test'
import assert from 'node:assert/strict'
import { HttpError, breakerReset, cacheClear, cached, fetchJson, fetchJsonp, fetchText } from '../lib/http.js'

test.beforeEach(() => {
  breakerReset()
  cacheClear()
})

test('HttpError 带状态码', () => {
  const e = new HttpError(403, 'forbidden')
  assert.equal(e.status, 403)
  assert.equal(e.message, 'forbidden')
  assert.ok(e instanceof Error)
})

test('非法 URL 直接报错', async () => {
  await assert.rejects(() => fetchText('not-a-url'), /非法 URL/)
})

test('抓文本：带 UA，空 body 视为失败', async () => {
  const orig = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url, headers: init.headers })
    return new Response('{"a":1}', { status: 200 })
  }
  try {
    const text = await fetchText('https://example.test/x')
    assert.equal(text, '{"a":1}')
    assert.match(seen[0].headers['User-Agent'], /Mozilla/)
  } finally {
    globalThis.fetch = orig
  }

  globalThis.fetch = async () => new Response('   ', { status: 200 })
  try {
    await assert.rejects(() => fetchText('https://example.test/empty', { retries: 0 }), /空内容/)
  } finally {
    globalThis.fetch = orig
  }
})

test('非 2xx 抛 HttpError，且会重试一次', async () => {
  const orig = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return new Response('nope', { status: 500 })
  }
  try {
    await assert.rejects(() => fetchText('https://example.test/500'), (err) => err instanceof HttpError)
    assert.equal(calls, 2) // retries=1 → 共 2 次
  } finally {
    globalThis.fetch = orig
  }
})

test('fetchJson / fetchJsonp 解析', async () => {
  breakerReset()
  const orig = globalThis.fetch
  globalThis.fetch = async () => new Response('{"ok":true}', { status: 200 })
  try {
    assert.deepEqual(await fetchJson('https://example.test/j'), { ok: true })
  } finally {
    globalThis.fetch = orig
  }
  globalThis.fetch = async () => new Response('cb({"Datas":[1,2]})', { status: 200 })
  try {
    assert.deepEqual(await fetchJsonp('https://example.test/p'), { Datas: [1, 2] })
  } finally {
    globalThis.fetch = orig
  }
  globalThis.fetch = async () => new Response('not jsonp', { status: 200 })
  try {
    await assert.rejects(() => fetchJsonp('https://example.test/bad', { retries: 0 }), /非 JSONP/)
  } finally {
    globalThis.fetch = orig
  }
})

test('cached: TTL 内不重复调用', async () => {
  cacheClear()
  let calls = 0
  const make = () => cached('t1', 10_000, async () => {
    calls += 1
    return { v: calls }
  })
  assert.deepEqual(await make(), { v: 1 })
  assert.deepEqual(await make(), { v: 1 })
  assert.equal(calls, 1)
})

test('cached: 并发请求合并成一次', async () => {
  cacheClear()
  let calls = 0
  const producer = async () => {
    calls += 1
    await new Promise((r) => setTimeout(r, 20))
    return calls
  }
  const [a, b, c] = await Promise.all([
    cached('t2', 10_000, producer),
    cached('t2', 10_000, producer),
    cached('t2', 10_000, producer),
  ])
  assert.deepEqual([a, b, c], [1, 1, 1])
  assert.equal(calls, 1)
})

test('cached: 上游报错时回退到旧值（stale-on-error）', async () => {
  cacheClear()
  let n = 0
  const good = async () => {
    n += 1
    return { v: n }
  }
  await cached('t3', 10_000, good)
  // 立刻再取一次，但这次生产端失败：仍应给出旧值
  const stale = await cached('t3', 10_000, async () => {
    throw new Error('上游挂了')
  })
  assert.deepEqual(stale, { v: 1 })
})

test('cached: 从没有过旧值时错误照常抛出', async () => {
  cacheClear()
  await assert.rejects(
    () => cached('t4', 10_000, async () => {
      throw new Error('首次就失败')
    }),
    /首次就失败/,
  )
})