import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mean, median, std, quantile, compound, equityFrom, maxDrawdown,
  betaAlpha, bootstrapCI, costAdjust, mulberry32,
} from '../scripts/research/metrics.js'

test('research/metrics：基础统计', () => {
  assert.equal(mean([1, 2, 3]), 2)
  assert.equal(mean([]), null)
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 2, 3]), 2.5)
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5)
  assert.equal(std([2, 2, 2]), 0)
  assert.ok(Math.abs(std([1, 2, 3]) - Math.sqrt(2 / 3)) < 1e-12)
})

test('research/metrics：复利/净值/最大回撤', () => {
  const c = compound([0.1, -0.1])
  assert.ok(Math.abs(c - -0.01) < 1e-12)
  const eq = equityFrom([0.1, -0.1])
  assert.ok(Math.abs(eq[0] - 1) < 1e-12)
  assert.ok(Math.abs(eq[1] - 1.1) < 1e-12)
  assert.ok(Math.abs(eq[2] - 0.99) < 1e-12)
  const mdd = maxDrawdown([1, 1.1, 0.99, 1.05])
  assert.ok(Math.abs(mdd - -0.1) < 1e-12)
})

test('research/metrics：betaAlpha 已知线性关系', () => {
  const xs = [-2, -1, 0, 1, 2]
  const ys = xs.map((x) => 2 * x + 1)
  const r = betaAlpha(ys, xs)
  assert.equal(r.n, 5)
  assert.ok(Math.abs(r.beta - 2) < 1e-12)
  assert.ok(Math.abs(r.alpha - 1) < 1e-12)
  assert.ok(Math.abs(r.r2 - 1) < 1e-12)
})

test('research/metrics：bootstrap 可复现且包含均值', () => {
  const xs = [1, 2, 3, 4, 5]
  const a = bootstrapCI(xs, { n: 2000, seed: 7 })
  const b = bootstrapCI(xs, { n: 2000, seed: 7 })
  assert.deepEqual(a, b)
  assert.ok(a.lo <= mean(xs) && mean(xs) <= a.hi)
})

test('research/metrics：成本敏感性（单边 bps × 2）', () => {
  const r = costAdjust([0.1], 10)
  assert.ok(Math.abs(r[0] - 0.098) < 1e-12)
})

test('research/metrics：PRNG 可复现', () => {
  const a = mulberry32(42)
  const b = mulberry32(42)
  assert.deepEqual([a(), a(), a()], [b(), b(), b()])
})
