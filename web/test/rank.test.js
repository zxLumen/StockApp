import test from 'node:test'
import assert from 'node:assert/strict'

import {
  secidOfSinaSymbol,
  monthChangeFromBars,
  mapLimit,
  objectiveFilter,
  isSt,
  hasLimitUpStreak,
  lastAmplitude,
  poolFromUniverse,
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

const bar = (close, high = close, low = close) => ({ close, high, low })

test('isSt：认出 ST / *ST / 退市', () => {
  assert.equal(isSt('*ST天喻'), true)
  assert.equal(isSt('ST晨光'), true)
  assert.equal(isSt('退市大控'), true)
  assert.equal(isSt('贵州茅台'), false)
})

test('hasLimitUpStreak：近 5 日连续 3 个涨停 → true', () => {
  // 3 个连续 +10% 的交易日（在窗口内）
  const b = [bar(10), bar(11), bar(12.1), bar(13.31), bar(14.5)]
  assert.equal(hasLimitUpStreak(b, 3, 5), true)
  // 只有 2 个连续涨停 → false（更宽口径）
  const b2 = [bar(10), bar(11), bar(12.1), bar(12.0), bar(11.9)]
  assert.equal(hasLimitUpStreak(b2, 3, 5), false)
})

test('lastAmplitude：最近一根 (高-低)/前收', () => {
  const b = [bar(10), { close: 11, high: 12, low: 9 }]
  assert.equal(lastAmplitude(b), 30) // (12-9)/10*100
  assert.equal(lastAmplitude([bar(10)]), null)
})

test('objectiveFilter：剔停牌/ST/连板/过热，按成交额取前 N', async () => {
  const pool = [
    { secid: '0.000001', code: '000001', name: '正常A', price: 10, amount: 5e8, turnover: 5 },
    { secid: '0.000002', code: '000002', name: '停牌B', price: null, amount: 0, turnover: 0 },
    { secid: '0.000003', code: '000003', name: '*ST风险C', price: 5, amount: 9e8, turnover: 3 },
    { secid: '0.000004', code: '000004', name: '过热D', price: 20, amount: 8e8, turnover: 45 },
    { secid: '0.000005', code: '000005', name: '正常E', price: 30, amount: 7e8, turnover: 8 },
    { secid: '0.000006', code: '000006', name: '连板F', price: 40, amount: 6e8, turnover: 10 },
  ]
  // 连板 F 的日 K：连续 3 个涨停
  const kline = async (secid) =>
    secid === '0.000006'
      ? { bars: [bar(10), bar(11), bar(12.1), bar(13.31)] }
      : { bars: [bar(10), { close: 10.2, high: 10.5, low: 9.9 }] }
  const kept = await objectiveFilter(pool, { target: 200, kline })
  assert.deepEqual(
    kept.map((x) => x.code),
    ['000005', '000001'], // E(7e8) 在 A(5e8) 前（按成交额降序）
  )
})

test('poolFromUniverse：取 ≤ basisDate 的最后一根日K，amount = volume×close', async () => {
  const universe = [
    { secid: '0.000001', code: '000001', name: '甲' },
    { secid: '0.000002', code: '000002', name: '乙' }, // 最后一根在基准日之后 → 用 ≤ basisDate 那根
    { secid: '0.000003', code: '000003', name: '丙' }, // 无数据 → 剔
  ]
  const kline = async (secid) => {
    if (secid === '0.000001') {
      return {
        bars: [
          { time: '2026-10-08', close: 10, volume: 100, changePct: 1 },
          { time: '2026-10-09', close: 11, volume: 200, changePct: 10 },
        ],
      }
    }
    if (secid === '0.000002') {
      return { bars: [{ time: '2026-10-09', close: 5, volume: 10 }, { time: '2026-10-12', close: 6, volume: 99 }] }
    }
    return null
  }
  const pool = await poolFromUniverse(universe, { basisDate: '2026-10-09', kline })
  // mapLimit 保序：丙被剔，剩甲、乙（顺序不变）
  assert.deepEqual(pool.map((x) => x.code), ['000001', '000002'])
  assert.equal(pool[0].price, 11)
  assert.equal(pool[0].amount, 2200) // 11 × 200
  assert.equal(pool[0].changePct, 10)
  // 乙：基准日之后那根（10-12）不得入选 → 仍用 10-09 那根
  assert.equal(pool[1].price, 5)
  assert.equal(pool[1].amount, 50) // 5 × 10
})
