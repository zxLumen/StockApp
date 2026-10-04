import test from 'node:test'
import assert from 'node:assert/strict'

import { toSinaUsSymbol } from '../lib/sina.js'

test('toSinaUsSymbol: 美股指数必须映射成带点的符号（回归：不映射新浪返回空）', () => {
  // 回归点：直接把代码段丢给 US_MinKService，NDX / SPX / IXIC / INX 全部返回空数组，
  // 于是美股首页日 K 整段拿不到（首页曾经还额外写死 market === 'cn'）。
  assert.equal(toSinaUsSymbol('100.DJIA'), '.DJI')
  assert.equal(toSinaUsSymbol('100.NDX'), '.NDX')
  assert.equal(toSinaUsSymbol('100.SPX'), '.INX')
  assert.equal(toSinaUsSymbol('100.IXIC'), '.IXIC')
  // 同义代码也认
  assert.equal(toSinaUsSymbol('100.INX'), '.INX')
  assert.equal(toSinaUsSymbol('100.GSPC'), '.INX')
  assert.equal(toSinaUsSymbol('100.COMP'), '.IXIC')
  // 大小写不敏感
  assert.equal(toSinaUsSymbol('100.ndx'), '.NDX')
})

test('toSinaUsSymbol: 个股用代码段本身，不查指数表', () => {
  assert.equal(toSinaUsSymbol('105.AAPL'), 'AAPL')
  assert.equal(toSinaUsSymbol('105.NDX'), 'NDX')
  assert.equal(toSinaUsSymbol('106.BABA'), 'BABA')
})

test('toSinaUsSymbol: 残缺 secid 返回 null，不去请求上游', () => {
  assert.equal(toSinaUsSymbol(''), null)
  assert.equal(toSinaUsSymbol(null), null)
  assert.equal(toSinaUsSymbol('100.'), null)
  assert.equal(toSinaUsSymbol('.DJIA'), null)
})
