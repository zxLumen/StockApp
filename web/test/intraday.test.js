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

test('avgPrices：成交量加权均价 VWAP（Σ close×vol / Σ vol）', () => {
  const bars = [
    { close: 10, volume: 1 }, // 10
    { close: 10, volume: 1 }, // 20 / 2 = 10
    { close: 30, volume: 1 }, // 50 / 3 ≈ 16.667
  ]
  const a = avgPrices(bars)
  assert.equal(a[0], 10)
  assert.equal(a[1], 10)
  assert.equal(a[2], 16.667)
})

test('avgPrices：量缺失沿用上一根，开头无量为 null', () => {
  const bars = [{ close: null, volume: 0 }, { close: 10, volume: 2 }]
  const a = avgPrices(bars)
  assert.equal(a[0], null)
  assert.equal(a[1], 10)
})

test('avgPrices：指数按 close 加权（amount 口径不适用）', () => {
  // 上证指数：amount 是成分股总成交额（亿级），直接用 amount/volume 会得到十几元，
  // 必须用 close（点位）加权，均价线才贴住指数点位。
  const bars = [
    { close: 3800, volume: 100, amount: 34188124160 },
    { close: 3820, volume: 100, amount: 15854417152 },
  ]
  const a = avgPrices(bars)
  assert.equal(a[0], 3800)
  assert.equal(a[1], 3810)
})

test('lastDayBars：只留最后一个交易日', () => {
  const bars = [
    { time: '2026-10-07 14:00' },
    { time: '2026-10-08 09:31' },
    { time: '2026-10-08 09:32' },
  ]
  assert.deepEqual(lastDayBars(bars).map((b) => b.time), ['2026-10-08 09:31', '2026-10-08 09:32'])
})
