import test from 'node:test'
import assert from 'node:assert/strict'

import { requestBody, isOpenCode, parseChunk, finishReasonOf, endpointURL, friendlyDetail } from '../lib/llm.js'

const line = (o) => `data: ${JSON.stringify(o)}`
const msgs = [{ role: 'user', content: 'hi' }]

test('isOpenCode: 只认 opencode.ai 端点，大小写不敏感', () => {
  assert.equal(isOpenCode('https://opencode.ai/zen/go/v1'), true)
  assert.equal(isOpenCode('https://OPENCODE.AI/zen/v1'), true)
  assert.equal(isOpenCode('https://api.deepseek.com'), false)
  assert.equal(isOpenCode('https://open.bigmodel.cn/api/paas/v4'), false)
  assert.equal(isOpenCode(''), false)
  assert.equal(isOpenCode(undefined), false)
})

test('requestBody: 默认注入 reasoning_effort=none（所有端点统一压思考）', () => {
  const b = requestBody({ model: 'm', messages: msgs, maxTokens: 100 })
  assert.equal(b.reasoning_effort, 'none')
  assert.equal(b.stream, false)
  assert.equal(b.max_tokens, 100)
  assert.equal(b.model, 'm')
  assert.deepEqual(b.messages, msgs)
})

test('requestBody: noThinking=false 不注入 reasoning_effort', () => {
  const b = requestBody({ model: 'm', messages: msgs, maxTokens: 100, stream: true, includeUsage: true, noThinking: false })
  assert.equal('reasoning_effort' in b, false)
  assert.deepEqual(b.stream_options, { include_usage: true })
})

test('requestBody: 非流式不该带 stream_options', () => {
  const b = requestBody({ model: 'm', messages: msgs, maxTokens: 100, includeUsage: true })
  assert.equal('stream_options' in b, false)
})

test('endpointURL: 补斜杠、不留双斜杠、空地址返回 null', () => {
  assert.equal(endpointURL('https://api.deepseek.com').href, 'https://api.deepseek.com/chat/completions')
  assert.equal(endpointURL('https://api.deepseek.com/').href, 'https://api.deepseek.com/chat/completions')
  assert.equal(endpointURL('https://x.dev/v4').href, 'https://x.dev/v4/chat/completions')
  assert.equal(endpointURL(''), null)
  assert.equal(endpointURL('   '), null)
  assert.equal(endpointURL(undefined), null)
})

test('parseChunk: 正常正文分片', () => {
  const c = parseChunk(line({ choices: [{ delta: { content: '你好' } }] }))
  assert.equal(c.content, '你好')
  assert.equal(c.usage, null)
})

test('parseChunk: 思考通道不算正文（否则会把思维链显示给用户）', () => {
  const c = parseChunk(line({ choices: [{ delta: { content: '', reasoning_content: '先分析一下' } }] }))
  assert.equal(c, null, '只有 reasoning_content 的分片要被丢掉')
})

test('parseChunk: usage 重映射成 input/output 并带上 reasoning', () => {
  const c = parseChunk(
    line({
      choices: [{ delta: {} }],
      usage: { prompt_tokens: 309, completion_tokens: 3259, completion_tokens_details: { reasoning_tokens: 2825 } },
    }),
  )
  assert.deepEqual(c.usage, { input: 309, output: 3259, reasoning: 2825 })
  assert.equal(c.content, '')
})

test('parseChunk: 没有 reasoning 细节时 reasoning 记 0 而不是 undefined', () => {
  const c = parseChunk(line({ choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 2 } }))
  assert.deepEqual(c.usage, { input: 1, output: 2, reasoning: 0 })
})

test('parseChunk: [DONE] 与坏数据不炸', () => {
  assert.equal(parseChunk('data: [DONE]').done, true)
  assert.equal(parseChunk('data: {坏 JSON}'), null)
  assert.equal(parseChunk('event: ping'), null)
  assert.equal(parseChunk(''), null)
})

test('finishReasonOf: 能取到截断信号 length', () => {
  assert.equal(finishReasonOf(line({ choices: [{ finish_reason: 'length' }] })), 'length')
  assert.equal(finishReasonOf(line({ choices: [{ finish_reason: 'stop' }] })), 'stop')
  // 没结束标记的分片不该瞎报
  assert.equal(finishReasonOf(line({ choices: [{ delta: { content: 'x' } }] })), null)
  assert.equal(finishReasonOf('data: [DONE]'), null)
  assert.equal(finishReasonOf('data: {坏}'), null)
  assert.equal(finishReasonOf('event: ping'), null)
})

test('friendlyDetail: 上游纯文本错误要透出真实原因', () => {
  assert.equal(friendlyDetail('Authentication Fails (governor)'), 'Authentication Fails (governor)')
  assert.equal(friendlyDetail('{"error":{"message":"余额不足"}}'), '余额不足')
  assert.equal(friendlyDetail(''), '请检查网络或 Key 是否有效。')
})