import test from 'node:test'
import assert from 'node:assert/strict'

import {
  secidOfSinaSymbol,
  monthChangeFromBars,
  mapLimit,
  rankByMonthChange,
} from '../lib/rank.js'

test('secidOfSinaSymbol：沪深前缀 → 东财 secid', () => {
  assert.equal(secidOfSinaSymbol('sz300308'), '0.300308')
  assert.equal(secidOfSinaSymbol('sh600519'), '1.600519')
  assert.equal(secidOfSinaSymbol('SH000001'), '1.000001')
  assert.equal(secidOfSinaSymbol('bj430047'), null, '北交所不在这套映射里')
  assert.equal(secidOfSinaSymbol(''), null)
})

test('monthChangeFromBars：最新收盘 / 20 交易日前收盘 - 1', () => {
  // 造 21 根日线：第 0 根 10 元，最后一根 12 元 → +20%
  const bars = Array.from({ length: 21 }, (_, i) => ({ close: i === 0 ? 10 : 12 }))
  assert.equal(monthChangeFromBars(bars, 20), 20)
})

test('monthChangeFromBars：不足月 / 空 / 基数为 0 → null', () => {
  assert.equal(monthChangeFromBars([], 20), null)
  assert.equal(monthChangeFromBars([{ close: 10 }], 20), null)
  // 只有 2 根时用最早那根兜底，不算错
  assert.equal(monthChangeFromBars([{ close: 0 }, { close: 10 }], 20), null, '基数 0 不能除')
})

test('mapLimit：保序、限并发、单项抛错记 null', async () => {
  let inFlight = 0
  let peak = 0
  const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise((r) => setTimeout(r, 5))
    inFlight -= 1
    if (n === 3) throw new Error('boom')
    return n * 10
  })
  assert.deepEqual(out, [10, 20, null, 40, 50])
  assert.ok(peak <= 2, `并发应 ≤2，实际峰值 ${peak}`)
})

test('rankByMonthChange：按涨幅降序、剔除取不到涨幅的', async () => {
  const pool = [
    { secid: '0.000002', code: '000002', name: 'B' },
    { secid: '0.000001', code: '000001', name: 'A' },
    { secid: '0.000003', code: '000003', name: 'C' },
  ]
  const compute = async (secid) => ({ '0.000001': 5, '0.000002': 12, '0.000003': null })[secid]
  const ranked = await rankByMonthChange(pool, { compute })
  assert.deepEqual(
    ranked.map((x) => x.code),
    ['000002', '000001'],
  )
  assert.equal(ranked[0].monthPct, 12)
  assert.equal(ranked[0].name, 'B', '要保留池里的字段')
})
