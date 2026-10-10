import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { classifyAnn, scoreAnnItem, prevDays, eventWindowDays, eventScores } from '../lib/ann-factor.js'

// ── classifyAnn / scoreAnnItem ─────────────────────────────────────────────
test('classifyAnn：识别利好公告', () => {
  const pos = [
    '2025年半年度业绩预增公告',
    '关于股份回购方案的公告',
    '控股股东拟增持公司股份的公告',
    '关于重大合同中标的自愿性信息披露公告',
    '关于股权激励计划（草案）的公告',
  ]
  for (const t of pos) {
    const s = scoreAnnItem({ title: t })
    assert.ok(s > 0, `应判为利好：${t}（实得 ${s}）`)
  }
})

test('classifyAnn：识别利空公告', () => {
  const neg = [
    '2025年半年度业绩预减公告',
    '关于股东减持股份计划的公告',
    '关于公司收到中国证监会立案告知书的公告',
    '关于限售股份上市流通的提示性公告',
    '关于公司股票被实施退市风险警示的公告',
  ]
  for (const t of neg) {
    const s = scoreAnnItem({ title: t })
    assert.ok(s < 0, `应判为利空：${t}（实得 ${s}）`)
  }
})

test('classifyAnn：日常公告不计分', () => {
  for (const t of ['第三届董事会第十五次会议决议公告', '关于召开2025年第一次临时股东大会的通知']) {
    assert.equal(scoreAnnItem({ title: t }), 0, `不应计分：${t}`)
    assert.deepEqual(classifyAnn(t), [])
  }
})

test('classifyAnn：同一类只计一次（去重）', () => {
  const hits = classifyAnn('关于控股股东增持公司股份暨增持计划的公告')
  assert.equal(hits.filter((h) => h.type === '增持').length, 1)
})

// ── prevDays ───────────────────────────────────────────────────────────────
test('prevDays：含评估日、连续回看', () => {
  assert.deepEqual(prevDays('2026-09-10', 3), ['2026-09-08', '2026-09-09', '2026-09-10'])
  assert.deepEqual(prevDays('2026-03-01', 2), ['2026-02-28', '2026-03-01'], '跨月')
})

// ── eventWindowDays（交易日锚定 + 末端=传入日） ───────────────────────────
test('eventWindowDays：起点锚最近 N 个交易日，末端=传入日（可含周末）', () => {
  // 2026-09-30（交易日）：前 5 个交易日 = 09-30, 09-29, 09-28, 09-24, 09-23
  // （09-25~27 中秋假 + 周末被跳过，但仍回看满 5 个交易日）
  assert.deepEqual(eventWindowDays('2026-09-30', 5), [
    '2026-09-23',
    '2026-09-24',
    '2026-09-25',
    '2026-09-26',
    '2026-09-27',
    '2026-09-28',
    '2026-09-29',
    '2026-09-30',
  ])
  // n=1 → 仅评估日
  assert.deepEqual(eventWindowDays('2026-09-30', 1), ['2026-09-30'])
  // 末端传非交易日（周日 09-27）→ 窗口末端 = 09-27，纳入 09-25/26/27（盘前刷新用）
  assert.deepEqual(eventWindowDays('2026-09-27', 5).slice(-3), ['2026-09-25', '2026-09-26', '2026-09-27'])
})

// ── eventScores ────────────────────────────────────────────────────────────
async function withTmp(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'annfactor-'))
  try {
    return await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}
const write = async (dir, day, items) => {
  await fs.mkdir(path.join(dir, 'ann-archive'), { recursive: true })
  await fs.writeFile(path.join(dir, 'ann-archive', `${day}.json`), JSON.stringify(items))
}
const ms = (day, hms = '10:00:00') => Date.parse(`${day}T${hms}+08:00`)

test('eventScores：按窗口聚合、只留 6 位代码', async () => {
  await withTmp(async (dir) => {
    await write(dir, '2026-09-09', [
      { title: '业绩预增公告', code: '600519', codes: ['600519'], time: ms('2026-09-09') },
      { title: '辅导备案报告', code: 'A16254', codes: ['A16254'], time: ms('2026-09-09') },
    ])
    await write(dir, '2026-09-10', [
      { title: '股东减持股份计划', code: '600519', codes: ['600519'], time: ms('2026-09-10') },
      { title: '股份回购方案', code: '000001', codes: ['000001'], time: ms('2026-09-10') },
    ])
    const m = await eventScores(dir, '2026-09-10', { windowDays: 5 })
    assert.equal(m.get('600519'), 3 - 2, '预增(+3) + 减持(-2)')
    assert.equal(m.get('000001'), 2, '回购(+2)')
    assert.equal(m.has('A16254'), false, '非 6 位代码被过滤')
  })
})

test('eventScores：窗口外（更早）不计入', async () => {
  await withTmp(async (dir) => {
    await write(dir, '2026-09-01', [
      { title: '业绩预增公告', code: '600519', codes: ['600519'], time: ms('2026-09-01') },
    ])
    const m = await eventScores(dir, '2026-09-10', { windowDays: 5 })
    assert.equal(m.has('600519'), false, '9-01 在 5 天窗口（9-06~9-10）之外')
  })
})

test('eventScores：时间戳超过评估日 → 抛未来数据泄漏', async () => {
  await withTmp(async (dir) => {
    await write(dir, '2026-09-10', [
      { title: '业绩预增公告', code: '600519', codes: ['600519'], time: ms('2026-09-11') },
    ])
    await assert.rejects(() => eventScores(dir, '2026-09-10'), /未来数据泄漏/)
  })
})
