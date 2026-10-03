import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { aiConfig, aiConfigFor, loadSettings, publicSettings, saveKey, saveSettings } from '../lib/settings.js'
import { friendlyDetail } from '../lib/llm.js'

const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'stock-settings-'))

const readJson = async (dir, name) => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'))

const writeJson = async (dir, name, value) => {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`)
}

test('loadSettings: 没有文件时给全套默认值', async () => {
  const s = await loadSettings(await tmpDir())
  assert.equal(s.provider, 'deepseek')
  assert.equal(s.maxTokens, 2048)
  assert.equal(s.temperature, 0.6)
  assert.equal(s.providers.deepseek.model, 'deepseek-flash')
  assert.equal(s.providers.deepseek.baseURL, 'https://api.deepseek.com')
  assert.equal(s.providers.custom.baseURL, '')
})

test('loadSettings: 旧版单槽形状并进对应服务商的槽位', async () => {
  const dir = await tmpDir()
  await writeJson(dir, 'settings.json', {
    provider: 'zhipu',
    model: 'glm-4.7',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    maxTokens: 4096,
    temperature: 0.3,
  })
  const s = await loadSettings(dir)
  // 老配置原样保住，不被预设覆盖
  assert.equal(s.provider, 'zhipu')
  assert.equal(s.providers.zhipu.model, 'glm-4.7')
  assert.equal(s.providers.zhipu.baseURL, 'https://open.bigmodel.cn/api/paas/v4')
  // 没配过的服务商各自回落自己的预设
  assert.equal(s.providers.deepseek.model, 'deepseek-flash')
  assert.equal(s.maxTokens, 4096)
})

test('loadSettings: 未知 provider 回落到 deepseek', async () => {
  const dir = await tmpDir()
  await writeJson(dir, 'settings.json', { provider: 'nope' })
  assert.equal((await loadSettings(dir)).provider, 'deepseek')
})

test('saveSettings: 切 provider 不动任何槽位', async () => {
  const dir = await tmpDir()
  await saveSettings(dir, { providers: { zhipu: { model: 'glm-4.7', baseURL: 'https://zhipu.example/v4' } } })
  await saveSettings(dir, { provider: 'zhipu' })
  await saveSettings(dir, { provider: 'deepseek' })

  const raw = await readJson(dir, 'settings.json')
  assert.equal(raw.provider, 'deepseek')
  assert.deepEqual(raw.providers.zhipu, { model: 'glm-4.7', baseURL: 'https://zhipu.example/v4' })
})

test('saveSettings: 只传一个字段时同槽另一个字段保持原值', async () => {
  const dir = await tmpDir()
  await saveSettings(dir, { providers: { opencodeGo: { model: 'a', baseURL: 'https://go.example/v1' } } })
  await saveSettings(dir, { providers: { opencodeGo: { model: 'b' } } })
  assert.deepEqual((await loadSettings(dir)).providers.opencodeGo, {
    model: 'b',
    baseURL: 'https://go.example/v1',
  })
})

test('saveSettings: 显式空串表示清掉并回落预设', async () => {
  const dir = await tmpDir()
  await saveSettings(dir, { providers: { deepseek: { baseURL: 'https://my.proxy/v1' } } })
  await saveSettings(dir, { providers: { deepseek: { baseURL: '' } } })
  assert.equal((await loadSettings(dir)).providers.deepseek.baseURL, 'https://api.deepseek.com')
})

test('saveSettings: 不在白名单内的键被忽略', async () => {
  const dir = await tmpDir()
  await saveSettings(dir, { apiKey: 'sk-leak', model: 'x' })
  const raw = await readJson(dir, 'settings.json')
  assert.equal(raw.apiKey, undefined)
  assert.equal(raw.model, undefined)
})

test('saveSettings: maxTokens / temperature 夹取到区间内', async () => {
  const dir = await tmpDir()
  await saveSettings(dir, { maxTokens: 99999, temperature: 9 })
  const s = await loadSettings(dir)
  assert.equal(s.maxTokens, 8192)
  assert.equal(s.temperature, 2)
  await saveSettings(dir, { maxTokens: 'abc', temperature: -1 })
  const s2 = await loadSettings(dir)
  // 非法值回落上一个，而不是 0/NaN
  assert.equal(s2.maxTokens, 8192)
  assert.equal(s2.temperature, 0)
})

test('saveKey: 按服务商分开存，空串清除', async () => {
  const dir = await tmpDir()
  await saveKey(dir, 'deepseek', 'sk-deepseek')
  await saveKey(dir, 'zhipu', 'sk-zhipu')
  assert.deepEqual(await readJson(dir, 'keys.json'), { deepseek: 'sk-deepseek', zhipu: 'sk-zhipu' })
  await saveKey(dir, 'deepseek', '')
  assert.deepEqual(await readJson(dir, 'keys.json'), { zhipu: 'sk-zhipu' })
})

test('saveKey: keys.json 是 0600', async () => {
  const dir = await tmpDir()
  await saveKey(dir, 'deepseek', 'sk-secret')
  const st = await fs.stat(path.join(dir, 'keys.json'))
  assert.equal(st.mode & 0o777, 0o600)
})

test('aiConfigFor: 取指定服务商的槽与其 Key', async () => {
  const dir = await tmpDir()
  await saveSettings(dir, {
    provider: 'deepseek',
    providers: {
      deepseek: { model: 'ds', baseURL: 'https://ds/v1' },
      zhipu: { model: 'glm', baseURL: 'https://zhipu/v4' },
    },
  })
  await saveKey(dir, 'zhipu', 'sk-zhipu')

  const zhipu = await aiConfigFor(dir, 'zhipu')
  assert.deepEqual(
    { apiKey: zhipu.apiKey, baseURL: zhipu.baseURL, model: zhipu.model },
    { apiKey: 'sk-zhipu', baseURL: 'https://zhipu/v4', model: 'glm' },
  )
  // 另一个槽的 Key 绝不串过来
  assert.equal((await aiConfigFor(dir, 'deepseek')).apiKey, '')
  // 省略 provider = 当前服务商
  assert.equal((await aiConfig(dir)).model, 'ds')
  // 未知 provider 回落当前服务商，而不是静默用别的槽
  assert.equal((await aiConfigFor(dir, 'nope')).model, 'ds')
})

test('aiConfigFor: 槽里没 Key 时按地址回退（老配置 provider 常是 custom）', async () => {
  const dir = await tmpDir()
  await saveSettings(dir, { provider: 'custom', providers: { custom: { baseURL: 'https://api.deepseek.com' } } })
  await saveKey(dir, 'deepseek', 'sk-deepseek')
  assert.equal((await aiConfig(dir)).apiKey, 'sk-deepseek')
})

test('publicSettings: 列出全部槽位且只给掩码', async () => {
  const dir = await tmpDir()
  await saveSettings(dir, { provider: 'opencodeZen' })
  await saveKey(dir, 'deepseek', 'sk-abcdefghijklmnop')
  const pub = await publicSettings(dir)

  assert.equal(pub.provider, 'opencodeZen')
  assert.equal(pub.hasKey, false)
  assert.equal(pub.keyMask, null)
  // 当前服务商的解析值也带上，省得调用方自己找
  assert.equal(pub.model, pub.providers.find((p) => p.id === 'opencodeZen').model)

  const deepseek = pub.providers.find((p) => p.id === 'deepseek')
  assert.equal(deepseek.hasKey, true)
  assert.equal(deepseek.keyMask, 'sk-abc…mnop')
  assert.equal(pub.providers.length, 5)
  // 全部 provider 都要有 label / 默认值，UI 才能渲染下拉与占位符
  for (const p of pub.providers) {
    assert.equal(typeof p.label, 'string')
    assert.ok(p.label.length > 0)
    assert.equal(typeof p.defaultBaseURL, 'string')
  }
  // 明文 Key 不能出现在任何字段里
  assert.equal(JSON.stringify(pub).includes('sk-abcdefghijklmnop'), false)
})

test('friendlyDetail: 纯文本正文原样透出，不被泛泛提示吞掉', () => {
  assert.equal(friendlyDetail('Authentication Fails (governor)'), 'Authentication Fails (governor)')
  // 多行 HTML 压成一行
  assert.equal(friendlyDetail('  <html>\n  <body>401</body>\n</html>  '), '<html> <body>401</body> </html>')
  // 过长截断
  const long = friendlyDetail('x'.repeat(500))
  assert.equal(long.length, 161)
  assert.ok(long.endsWith('…'))
})

test('friendlyDetail: JSON 仍取 error.message，其次 error.detail', () => {
  assert.equal(friendlyDetail('{"error":{"message":"余额不足"}}'), '余额不足')
  assert.equal(friendlyDetail('{"error":{"detail":"quota exceeded"}}'), 'quota exceeded')
  // JSON 里没有可读信息时退到整体正文，而不是无脑回泛泛提示
  assert.equal(friendlyDetail('{"foo":1}'), '{"foo":1}')
  // 真的什么都没有才给兜底
  assert.equal(friendlyDetail(''), '请检查网络或 Key 是否有效。')
  assert.equal(friendlyDetail(null), '请检查网络或 Key 是否有效。')
})