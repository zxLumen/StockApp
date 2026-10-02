import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readJson, readJsonWithBak, writeJson } from '../lib/store.js'

let dir
let n = 0

test.beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stock-store-'))
})

const file = () => path.join(dir, `f${(n += 1)}.json`)

test('写入后可读回，数组与对象都支持', async () => {
  const f = file()
  await writeJson(f, [{ secid: '1.600519' }])
  assert.deepEqual(await readJson(f), [{ secid: '1.600519' }])
  await writeJson(f, { a: 1 })
  assert.deepEqual(await readJson(f), { a: 1 })
})

test('不存在的文件返回 fallback', async () => {
  assert.deepEqual(await readJson(path.join(dir, 'nope.json'), []), [])
  assert.equal(await readJson(path.join(dir, 'nope.json')), null)
})

test('自动创建父目录', async () => {
  const f = path.join(dir, 'a', 'b', 'c.json')
  await writeJson(f, [1])
  assert.deepEqual(await readJson(f), [1])
})

test('主文件损坏时回退到 .bak', async () => {
  const f = file()
  await writeJson(f, ['第一版'])
  await writeJson(f, ['第二版'])
  await fs.writeFile(f, '{坏掉的 json', 'utf8')
  assert.deepEqual(await readJsonWithBak(f, null), ['第一版'])
})

test('主文件为空（写入被打断）也回退到 .bak', async () => {
  const f = file()
  await writeJson(f, ['完整'])
  await writeJson(f, ['新内容'])
  await fs.writeFile(f, '', 'utf8')
  assert.deepEqual(await readJsonWithBak(f, null), ['完整'])
})

test('主文件合法时优先用它，而不是 .bak', async () => {
  const f = file()
  await writeJson(f, ['旧'])
  await writeJson(f, ['新'])
  assert.deepEqual(await readJsonWithBak(f, null), ['新'])
})

test('两个都没有才用 fallback', async () => {
  assert.deepEqual(await readJsonWithBak(path.join(dir, 'none.json'), { ok: 1 }), { ok: 1 })
})

test('mode 生效（AI Key 用 0600）', async () => {
  const f = file()
  await writeJson(f, { k: 'sk-test' }, { mode: 0o600 })
  const st = await fs.stat(f)
  assert.equal(st.mode & 0o777, 0o600)
})

test('并发写同一文件不互相覆盖（串行锁）', async () => {
  const f = file()
  await Promise.all([
    writeJson(f, { i: 1 }),
    writeJson(f, { i: 2 }),
    writeJson(f, { i: 3 }),
  ])
  const v = await readJson(f)
  assert.ok(v && typeof v === 'object')
  // 不留 .tmp 残骸
  const left = (await fs.readdir(dir)).filter((x) => x.endsWith('.tmp'))
  assert.deepEqual(left, [])
})