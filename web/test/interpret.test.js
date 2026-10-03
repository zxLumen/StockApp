import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js')

/** 借一个系统分配的空闲端口（server.js 的 STOCK_PORT 用 `|| 8789`，传 0 会被吃掉）。 */
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = http.createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
    s.on('error', reject)
  })

/** 假的 OpenAI 兼容上游：吐标准 SSE 分片。 */
const startFakeUpstream = async () => {
  const seen = { auth: null, body: null, hits: 0 }
  const server = http.createServer((req, res) => {
    seen.hits += 1
    seen.auth = req.headers.authorization ?? null
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      seen.body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"第一段"}}]}\n\n')
      res.write('data: {"choices":[{"delta":{"content":"第二段"}}]}\n\n')
      res.write('data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":11,"completion_tokens":7}}\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port, seen }
}

const startStock = async (port, dataDir) => {
  const proc = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: { ...process.env, STOCK_PORT: String(port), STOCK_HOST: '127.0.0.1', STOCK_DATA_DIR: dataDir, STOCK_OWNER_TOKEN: 'test-owner' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const err = []
  proc.stderr.on('data', (d) => err.push(String(d)))
  for (let i = 0; i < 60; i += 1) {
    if (proc.exitCode !== null) throw new Error(`server 提前退出(${proc.exitCode}): ${err.join('')}`)
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(1000) })
      if (r.ok) return proc
    } catch { /* 还没起来 */ }
    await sleep(150)
  }
  throw new Error(`server 没起来: ${err.join('')}`)
}

/** 跑一次 AI 解读，返回 { status, headers, frames, raw }。 */
const interpret = async (port, { question } = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/ai/interpret`, {
    method: 'POST',
    headers: { cookie: 'stock_owner=test-owner', 'content-type': 'application/json' },
    body: JSON.stringify({ secid: '1.600519', name: '贵州茅台', question }),
  })
  const raw = await res.text()
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    raw,
    frames: raw
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6).trim())
      .filter((l) => l && l !== '[DONE]')
      .map((l) => JSON.parse(l)),
  }
}

test('AI 解读：SSE 流式链路端到端跑通（回归：res 未定义会让这里整条 502）', async (t) => {
  const up = await startFakeUpstream()
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stock-interpret-'))
  await fs.writeFile(
    path.join(dataDir, 'settings.json'),
    JSON.stringify({
      provider: 'deepseek',
      providers: {
        deepseek: { model: 'test-model', baseURL: `http://127.0.0.1:${up.port}/` },
      },
      maxTokens: 256,
      temperature: 0.2,
      visitorAi: true,
    }),
  )
  await fs.writeFile(path.join(dataDir, 'keys.json'), JSON.stringify({ deepseek: 'sk-test-key' }), { mode: 0o600 })

  const port = await freePort()
  const proc = await startStock(port, dataDir)
  t.after(async () => {
    proc.kill()
    up.server.close()
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
  })

  const r = await interpret(port)
  assert.equal(r.status, 200, `期望 200，实际 ${r.status}，正文：${r.raw.slice(0, 300)}`)
  assert.match(r.contentType, /text\/plain/)
  assert.equal(/res is not defined/.test(r.raw), false, `不该再有 res 未定义：${r.raw.slice(0, 300)}`)

  // 分片按序到达
  const deltas = r.frames.filter((f) => f.delta?.content).map((f) => f.delta.content)
  assert.deepEqual(deltas, ['第一段', '第二段'])

  // 收尾帧带完整正文与用量（parseChunk 把上游字段重映射成 input/output）
  const done = r.frames.find((f) => f.done)
  assert.equal(done.text, '第一段第二段')
  assert.deepEqual(done.usage, { input: 11, output: 7, reasoning: 0 })

  // 上游确实带上了 Authorization（分槽后取的是当前槽的 Key）
  assert.equal(up.seen.auth, 'Bearer sk-test-key')
  assert.equal(up.seen.body.model, 'test-model')
  assert.equal(up.seen.body.stream, true)
  assert.deepEqual(up.seen.body.stream_options, { include_usage: true })
  // 这个假上游不是 opencode 端点，不能给它塞未验证的字段
  assert.equal('reasoning_effort' in up.seen.body, false, JSON.stringify(up.seen.body))
})

test('AI 解读：思考链吃光 token 预算时必须报错，不能静默返回空白', async (t) => {
  // 复刻带思考链模型（deepseek-v4.x 等）的行为：reasoning_content 写满，
  // content 全程为空，最后 finish_reason=length。
  const up = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"","reasoning_content":"先分析"}}]}\n\n')
      res.write('data: {"choices":[{"delta":{"content":"","reasoning_content":"再分析"}}]}\n\n')
      res.write('data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":300,"completion_tokens":2048,"completion_tokens_details":{"reasoning_tokens":2048}}}\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise((r) => up.listen(0, '127.0.0.1', r))
  const upPort = up.address().port

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stock-interpret-think-'))
  await fs.writeFile(
    path.join(dataDir, 'settings.json'),
    JSON.stringify({
      provider: 'deepseek',
      providers: { deepseek: { model: 'thinking-model', baseURL: `http://127.0.0.1:${upPort}/` } },
      maxTokens: 2048,
      temperature: 0.2,
      visitorAi: true,
    }),
  )
  await fs.writeFile(path.join(dataDir, 'keys.json'), JSON.stringify({ deepseek: 'sk-test' }), { mode: 0o600 })

  const port = await freePort()
  const proc = await startStock(port, dataDir)
  t.after(async () => {
    proc.kill()
    up.close()
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
  })

  const r = await interpret(port)
  assert.equal(r.status, 200)
  const err = r.frames.find((f) => f.error)
  assert.ok(err, `空正文必须变成 error 帧，实际帧：${JSON.stringify(r.frames)}`)
  // 文案要能指导用户行动：说清是思考吃掉了预算、让他调大 max_tokens
  assert.match(err.error.message, /思考过程/)
  assert.match(err.error.message, /2048/)
  assert.match(err.error.message, /最大输出 tokens/)
  assert.match(err.error.message, /length/)
  // 别把这种事说成「流式响应中断」，那是网络问题的说法，会误导
  assert.equal(/流式响应中断/.test(err.error.message), false, err.error.message)
  // 不能出现一个「成功但正文为空」的 done 帧
  assert.equal(r.frames.some((f) => f.done), false, JSON.stringify(r.frames))
})

test('AI 解读：上游报错时以 SSE error 帧收尾，而不是把整条流打断成 502', async (t) => {
  const up = http.createServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'text/plain' })
    res.end('Authentication Fails (governor)')
  })
  await new Promise((r) => up.listen(0, '127.0.0.1', r))
  const upPort = up.address().port

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stock-interpret-err-'))
  await fs.writeFile(
    path.join(dataDir, 'settings.json'),
    JSON.stringify({
      provider: 'deepseek',
      providers: { deepseek: { model: 'test-model', baseURL: `http://127.0.0.1:${upPort}/` } },
      maxTokens: 256,
      temperature: 0.2,
      visitorAi: true,
    }),
  )
  await fs.writeFile(path.join(dataDir, 'keys.json'), JSON.stringify({ deepseek: 'sk-bad' }), { mode: 0o600 })

  const port = await freePort()
  const proc = await startStock(port, dataDir)
  t.after(async () => {
    proc.kill()
    up.close()
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
  })

  const r = await interpret(port)
  // 头已经发出去了，所以状态码仍是 200，错误走 SSE 帧
  assert.equal(r.status, 200)
  const err = r.frames.find((f) => f.error)
  assert.ok(err, `应收到 error 帧，实际帧：${JSON.stringify(r.frames)}`)
  // 上游的纯文本原因要能透出来，而不是被吞成「请检查网络或 Key 是否有效」
  assert.match(err.error.message, /Authentication Fails \(governor\)/)
})