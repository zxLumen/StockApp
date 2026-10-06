import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseJsonLoose,
  buildReviewRows,
  bjDate,
  nextTradingDay,
  normalizeHoldDays,
  pctFromPick,
  selectTop10,
  pickChain,
} from '../lib/recommend.js'

test('pickChain：逐日 tilt 门控（≥阈值走 A 激进链路，否则走 B 保守链路）', () => {
  // 阈值 0.6 的实际分界：2024-09 实测 tilt 只取 0.00 / 1.00 两端。
  assert.equal(pickChain(1.0, 0.6), 'A')
  assert.equal(pickChain(0.6, 0.6), 'A', '边界含等号')
  assert.equal(pickChain(0.59, 0.6), 'B')
  assert.equal(pickChain(0.0, 0.6), 'B')
  // 中间值同样按阈值切（37% 的交易日落在这段）。
  assert.equal(pickChain(0.41, 0.6), 'B')
  assert.equal(pickChain(0.66, 0.6), 'A')
  // 阈值可配（日后用真实前瞻数据重标定）。
  assert.equal(pickChain(0.41, 0.3), 'A')
  // 拿不到 tilt / 阈值非法 → 保守走 B，绝不因为数据缺失去赌激进链路。
  assert.equal(pickChain(NaN, 0.6), 'B')
  assert.equal(pickChain(1.0, NaN), 'B')
})

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

// ── normalizeHoldDays：AI 逐股判断持有周期 ─────────────────────────────────
// 历史 1300 条 holdDays 全是 10（旧 prompt 写死「默认给 10」+ 运行期覆盖），
// 所以这套归一化此前从没被真正验证过。切动态周期前必须钉住。
test('normalizeHoldDays：3/5/10/20 原样保留', () => {
  for (const n of [3, 5, 10, 20]) assert.equal(normalizeHoldDays(n), n)
})

test('normalizeHoldDays：合法值不回落到 5（防「默认 10」被静默改掉）', () => {
  assert.equal(normalizeHoldDays('20'), 20)
  assert.equal(normalizeHoldDays(3.4), 3, '小数四舍五入到最近档位')
  assert.equal(normalizeHoldDays(19.6), 20)
})

test('normalizeHoldDays：非法值回落 5（不回落 10 —— 那是旧的写死默认值）', () => {
  for (const v of [null, undefined, 0, -3, 7, 15, 'abc', NaN]) {
    assert.equal(normalizeHoldDays(v), 5, `${String(v)} 应回落 5`)
  }
})
