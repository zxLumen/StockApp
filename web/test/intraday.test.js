import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SESSION_SLOTS,
  avgPrices,
  barDay,
  lastDayBars,
  sessionSlot,
  slotLabel,
  slotTs,
  tsToSlot,
} from '../src/lib/intraday.ts'

test('barDay：取分钟时间戳的日期部分', () => {
  assert.equal(barDay('2026-10-08 09:31'), '2026-10-08')
  assert.equal(barDay('2026-10-08'), '2026-10-08')
  assert.equal(barDay('bad'), '')
})

test('sessionSlot：上午 09:30..11:30 / 下午 13:00..15:00，午休与盘外为 null', () => {
  assert.equal(sessionSlot('2026-10-08 09:30'), 0)
  assert.equal(sessionSlot('2026-10-08 09:31'), 1)
  assert.equal(sessionSlot('2026-10-08 11:30'), 120)
  assert.equal(sessionSlot('2026-10-08 13:00'), 120)
  assert.equal(sessionSlot('2026-10-08 13:01'), 121)
  assert.equal(sessionSlot('2026-10-08 15:00'), 240)
  assert.equal(sessionSlot('2026-10-08 12:00'), null)
  assert.equal(sessionSlot('2026-10-08 08:59'), null)
  assert.equal(sessionSlot('2026-10-08 15:01'), null)
})

test('slotLabel：槽位反算墙钟，午休被压缩（11:30 紧接 13:01）', () => {
  assert.equal(slotLabel(0), '09:30')
  assert.equal(slotLabel(1), '09:31')
  assert.equal(slotLabel(120), '11:30')
  assert.equal(slotLabel(121), '13:01')
  assert.equal(slotLabel(240), '15:00')
  assert.equal(slotLabel(9999), '15:00', '越界钳到收盘')
})

test('slotTs / tsToSlot：伪时间戳与槽位互逆', () => {
  const day = '2026-10-08'
  assert.equal(tsToSlot(day, slotTs(day, 0)), 0)
  assert.equal(tsToSlot(day, slotTs(day, 137)), 137)
  assert.equal(SESSION_SLOTS, 241, '含两端共 241 个点')
})

test('avgPrices：累计成交额 / 累计成交量（手 → 股）', () => {
  const bars = [
    { amount: 1000, volume: 1 }, // 1000 / (1*100) = 10
    { amount: 1000, volume: 1 }, // 2000 / 200 = 10
    { amount: 3000, volume: 1 }, // 5000 / 300 ≈ 16.667
  ]
  const a = avgPrices(bars)
  assert.equal(a[0], 10)
  assert.equal(a[1], 10)
  assert.equal(a[2], 16.667)
})

test('avgPrices：量缺失沿用上一根，开头无量为 null', () => {
  const bars = [{ amount: 0, volume: 0 }, { amount: 2000, volume: 2 }]
  const a = avgPrices(bars)
  assert.equal(a[0], null)
  assert.equal(a[1], 10)
})

test('lastDayBars：只留最后一个交易日', () => {
  const bars = [
    { time: '2026-10-07 14:00' },
    { time: '2026-10-08 09:31' },
    { time: '2026-10-08 09:32' },
  ]
  assert.deepEqual(lastDayBars(bars).map((b) => b.time), ['2026-10-08 09:31', '2026-10-08 09:32'])
})
