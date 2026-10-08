import test from 'node:test'
import assert from 'node:assert/strict'

import { sharesFor } from '../lib/positions.js'

test('sharesFor：低价整手（≈1万），高价小数股（=1万）', () => {
  // 50 元：一手 5000 ≤ 1万 → 2 手 = 200 股，成本正好 1 万
  assert.equal(sharesFor(50), 200)
  // 7.18 元：整手取整到 1400 股（成本≈1.0052 万）
  assert.equal(sharesFor(7.18), 1400)
  // 一手就超 1 万的高价股 → 小数股，成本正好 1 万
  assert.ok(Math.abs(sharesFor(1546.63) * 1546.63 - 10000) < 1)
  assert.ok(Math.abs(sharesFor(101.35) * 101.35 - 10000) < 1)
  // 非法价
  assert.equal(sharesFor(0), 0)
  assert.equal(sharesFor(null), 0)
})
