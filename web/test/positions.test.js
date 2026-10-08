import test from 'node:test'
import assert from 'node:assert/strict'

import { sharesFor } from '../lib/positions.js'

test('sharesFor：股数一律整数（低价整手、高价整股），成本≈1万', () => {
  // 50 元：一手 5000 ≤ 1万 → 2 手 = 200 股
  assert.equal(sharesFor(50), 200)
  // 7.18 元：整手取整到 1400 股
  assert.equal(sharesFor(7.18), 1400)
  // 57.86 元：2 手 = 200 股
  assert.equal(sharesFor(57.86), 200)
  // 高价（一手就超 1 万）→ 取整股，绝不出现小数
  assert.equal(sharesFor(1546.63), 6)
  assert.equal(sharesFor(1253.8), 8)
  for (const p of [1253.8, 1546.63, 101.35, 28.02, 82.54]) {
    const s = sharesFor(p)
    assert.ok(Number.isInteger(s), `${p} → ${s} 应为整数`)
    assert.ok(s >= 1, `${p} 至少 1 股`)
  }
  assert.equal(sharesFor(0), 0)
  assert.equal(sharesFor(null), 0)
})
