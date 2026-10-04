import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseJsonLoose,
  buildReviewRows,
  bjDate,
  nextTradingDay,
  pctFromPick,
  selectTop10,
} from '../lib/recommend.js'

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
    { code: '600418', name: '江淮汽车', monthPct: 30.81, ai: { buyScore: 88, summary: '整车放量' } },
  ])
  assert.match(rows, /600418 江淮汽车/)
  assert.match(rows, /买入评分88/)
  assert.match(rows, /整车放量/)
  assert.match(rows, /整车放量/)
})

test('bjDate：返回 YYYY-MM-DD', () => {
  assert.match(bjDate(new Date('2026-10-04T06:00:00Z')), /^\d{4}-\d{2}-\d{2}$/)
})

test('nextTradingDay：周中 → 次日；周五 → 下周一；周六 → 周一', () => {
  assert.equal(nextTradingDay('2026-10-06'), '2026-10-07', '周二 → 周三')
  assert.equal(nextTradingDay('2026-10-09'), '2026-10-12', '周五 → 下周一')
  assert.equal(nextTradingDay('2026-10-10'), '2026-10-12', '周六 → 周一')
})

test('pctFromPick：正常计算、除零/缺值返回 null', () => {
  assert.equal(pctFromPick(10, 12), 20)
  assert.equal(pctFromPick(100, 88), -12)
  assert.equal(pctFromPick(0, 12), null)
  assert.equal(pctFromPick(null, 12), null)
  assert.equal(pctFromPick(10, null), null)
})

// selectTop10 在不触发评审（高分 ≤ finalPicks）时不需要 cfg。
const st = (code, buyScore) => ({ code, name: code, ai: { buyScore, summary: '' } })

test('selectTop10：高分不足10只 → 有多少取多少 + 低分垫底（不调评审）', async () => {
  const scored = [st('a', 80), st('b', 70), st('c', 40), st('d', 30)]
  const top = await selectTop10(null, scored, 10, () => {}, { highBar: 60 })
  // 先高分（a,b），再按分把 c,d 垫底补满
  assert.deepEqual(top.map((t) => t.code), ['a', 'b', 'c', 'd'])
  assert.equal(top[0].pickedBy, 'score')
  assert.equal(top[2].pickedBy, 'fill')
})

test('selectTop10：高分恰好≤10 → 不会混入 < highBar 的股', async () => {
  const scored = [st('a', 72), st('b', 65), st('c', 18)]
  const top = await selectTop10(null, scored, 10, () => {}, { highBar: 60 })
  // 只有 2 只高分，补齐时会带上低分（<10 只），但顺序必须高分在前
  assert.deepEqual(top.map((t) => t.code), ['a', 'b', 'c'])
  assert.ok(top[0].ai.buyScore >= 60 && top[1].ai.buyScore >= 60)
})

test('selectTop10：无高分时按分降序取（低分也保留，不崩）', async () => {
  const scored = [st('a', 30), st('b', 20)]
  const top = await selectTop10(null, scored, 10, () => {}, { highBar: 60 })
  assert.deepEqual(top.map((t) => t.code), ['a', 'b'])
})
