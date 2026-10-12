import test from 'node:test'
import assert from 'node:assert/strict'

import { isTradingDay, nextTradingDay, prevTradingDay, prevTradingDayBefore, addTradingDays, tradingLag, STALE_CLOSED_DAYS } from '../lib/trading-days.js'

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

test('tradingLag：基日→生效日的自然日/休市日（长假明显偏大）', () => {
  assert.deepEqual(tradingLag('2026-10-07', '2026-10-08'), { calendarDays: 1, closedDays: 0 }, '平常日')
  assert.deepEqual(tradingLag('2026-10-09', '2026-10-12'), { calendarDays: 3, closedDays: 2 }, '普通周末')
  assert.deepEqual(tradingLag('2026-06-18', '2026-06-22'), { calendarDays: 4, closedDays: 3 }, '端午小长假')
  assert.deepEqual(tradingLag('2026-09-30', '2026-10-08'), { calendarDays: 8, closedDays: 7 }, '国庆长假')
  assert.deepEqual(tradingLag('2026-10-08', '2026-10-08'), { calendarDays: 0, closedDays: 0 }, '同日')
  assert.deepEqual(tradingLag('', '2026-10-08'), { calendarDays: 0, closedDays: 0 }, '缺基日')
  assert.equal(STALE_CLOSED_DAYS, 3)
})
