import test from 'node:test'
import assert from 'node:assert/strict'

import { parseJsonLoose, buildReviewRows, bjDate } from '../lib/recommend.js'

test('parseJsonLoose：裸 JSON', () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 })
})

test('parseJsonLoose：```json 代码块围栏', () => {
  assert.deepEqual(parseJsonLoose('好的：\n```json\n{"score": 80}\n```\n以上'), { score: 80 })
})

test('parseJsonLoose：前后夹带文字也能截出 JSON', () => {
  assert.deepEqual(parseJsonLoose('前面的话 {"score": 12, "tags": ["a"]} 后面的话'), {
    score: 12,
    tags: ['a'],
  })
})

test('parseJsonLoose：不是 JSON → null', () => {
  assert.equal(parseJsonLoose('完全不是 json'), null)
  assert.equal(parseJsonLoose(''), null)
})

test('buildReviewRows：把候选拼成评审用的行', () => {
  const rows = buildReviewRows([
    { code: '600418', name: '江淮汽车', monthPct: 30.81, ai: { score: 88, summary: '整车放量' } },
  ])
  assert.match(rows, /600418 江淮汽车/)
  assert.match(rows, /30\.81%/)
  assert.match(rows, /88/)
  assert.match(rows, /整车放量/)
})

test('bjDate：返回 YYYY-MM-DD', () => {
  assert.match(bjDate(new Date('2026-10-04T06:00:00Z')), /^\d{4}-\d{2}-\d{2}$/)
})
