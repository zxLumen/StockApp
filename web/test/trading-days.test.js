import test from 'node:test'
import assert from 'node:assert/strict'

import { isTradingDay, nextTradingDay, prevTradingDay, prevTradingDayBefore, addTradingDays } from '../lib/trading-days.js'

test('isTradingDay：跳过周末与法定节假日', () => {
  assert.equal(isTradingDay('2026-10-08'), true)
  assert.equal(isTradingDay('2026-10-03'), false, '国庆假期')
  assert.equal(isTradingDay('2026-10-10'), false, '周六')
})

test('prevTradingDay：交易日返回自身，节假日回退', () => {
  assert.equal(prevTradingDay('2026-10-08'), '2026-10-08')
  assert.equal(prevTradingDay('2026-10-01'), '2026-09-30', '国庆首日回退到节前最后交易日')
  assert.equal(prevTradingDay('2026-10-10'), '2026-10-09', '周六回退到周五')
})

test('prevTradingDayBefore：严格早于输入（交易日也不返回自身）', () => {
  assert.equal(prevTradingDayBefore('2026-10-12'), '2026-10-09', '周一 → 上一交易日周五')
  assert.equal(prevTradingDayBefore('2026-10-13'), '2026-10-12', '周二 → 周一')
  assert.equal(prevTradingDayBefore('2026-10-08'), '2026-09-30', '节后首日 → 节前最后交易日')
})

test('nextTradingDay：跨节假日', () => {
  assert.equal(nextTradingDay('2026-09-30'), '2026-10-08', '节后第一个交易日')
  assert.equal(nextTradingDay('2026-09-24'), '2026-09-28', '跳过中秋(09-25~27)与周末')
})

test('addTradingDays：0 返回对齐后的交易日本身，跨国庆/中秋 n 个交易日', () => {
  assert.equal(addTradingDays('2026-09-24', 0), '2026-09-24')
  assert.equal(addTradingDays('2026-09-24', 4), '2026-10-08')
  assert.equal(addTradingDays('2026-09-24', 5), '2026-10-09')
  assert.equal(addTradingDays('2026-09-28', 3), '2026-10-08')
  // basisDate 落在节假日 → 先回退到上一交易日再往后数
  assert.equal(addTradingDays('2026-10-01', 1), '2026-10-08')
})
