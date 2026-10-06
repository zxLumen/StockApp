import test from 'node:test'
import assert from 'node:assert/strict'

import { computeFactors, zscore, compositeScores, regimeTilt } from '../lib/factors.js'

const bar = (close, volume = 1000) => ({ time: '2026-01-01', open: close, high: close, low: close, close, volume })

test('computeFactors：数据不足 / 空 → null', () => {
  assert.equal(computeFactors(null), null)
  assert.equal(computeFactors([]), null)
  assert.equal(computeFactors(Array.from({ length: 20 }, () => bar(10))), null, '需 ≥21 根')
})

test('computeFactors：字段齐全且为有限数', () => {
  const bars = Array.from({ length: 25 }, (_, i) => bar(10 + i * 0.1, 1000 + i))
  const f = computeFactors(bars)
  assert.ok(f)
  for (const k of ['vol', 'chg5', 'chg20', 'dev', 'avgAmt', 'turnStd', 'maxRet5', 'ampMean', 'upShadowStd']) {
    assert.ok(Number.isFinite(f[k]), `${k} 应为有限数`)
  }
})

test('computeFactors：提供指数加权残差得 IVOL；未提供为 null', () => {
  const bars = Array.from({ length: 25 }, (_, i) => ({
    time: `2026-01-${String(i + 1).padStart(2, '0')}`,
    open: 10,
    high: 11,
    low: 9,
    close: 10 + Math.sin(i) * 0.5,
    volume: 1000,
  }))
  const idx = new Map(bars.map((b, i) => [b.time, 100 + Math.sin(i) * 0.2]))
  assert.ok(Number.isFinite(computeFactors(bars, idx).ivol))
  assert.equal(computeFactors(bars).ivol, null)
})

test('zscore：标准化后均值≈0；常量数组不炸', () => {
  const z = zscore([1, 2, 3, 4, 5])
  assert.ok(Math.abs(z.reduce((a, b) => a + b, 0) / z.length) < 1e-9)
  assert.deepEqual(zscore([2, 2, 2]), [0, 0, 0])
})

test('compositeScores：低波权重下低波股更高（无未来数据，仅日K）', () => {
  const flat = Array.from({ length: 25 }, () => bar(10))
  const wild = Array.from({ length: 25 }, (_, i) => bar(i % 2 ? 8 : 12))
  const w = { lowVol: 1, reversal: 0, midRev: 0, proximity: 0, liquidity: 0, turnStd: 0 }
  const [sFlat, sWild] = compositeScores([computeFactors(flat), computeFactors(wild)], w)
  assert.ok(sFlat > sWild, `低波应更高：${sFlat} vs ${sWild}`)
})

test('compositeScores：反转权重下近期超跌股更高', () => {
  const up = Array.from({ length: 25 }, (_, i) => bar(10 + i * 0.2))
  const down = Array.from({ length: 25 }, (_, i) => bar(20 - i * 0.2))
  const w = { lowVol: 0, reversal: 1, midRev: 0, proximity: 0, liquidity: 0, turnStd: 0 }
  const [sUp, sDown] = compositeScores([computeFactors(up), computeFactors(down)], w)
  assert.ok(sDown > sUp, `超跌应更高：${sDown} vs ${sUp}`)
})

test('compositeScores：event 权重生效；缺省权重(=0)不影响排序', () => {
  const bars = Array.from({ length: 25 }, () => bar(10))
  const base = computeFactors(bars)
  const feats = [
    { ...base, event: 5 },
    { ...base, event: 0 },
    { ...base, event: -5 },
  ]
  const [p, z, n] = compositeScores(feats, { event: 1 })
  assert.ok(p > z && z > n, `越高事件分应越高：${p} / ${z} / ${n}`)
  // 显式把 event 归零 → 只改事件分不改变三者相对（此处三条其它因子完全相同）。
  const [a, b, c] = compositeScores(feats, { event: 0 })
  assert.equal(a, b)
  assert.equal(b, c)
})

// ── regimeTilt ─────────────────────────────────────────────────────────────
const idxBar = (time, close) => ({ time, open: close, high: close, low: close, close, volume: 1000 })
// 构造指数序列：前 20 根价格 base，最后一根 last。
const idxSeq = (last, base = 100) =>
  Array.from({ length: 20 }, (_, i) => idxBar(`2026-01-${String(i + 1).padStart(2, '0')}`, base)).concat(
    idxBar('2026-01-21', last),
  )

test('regimeTilt：指数走强 → 高 tilt；走弱 → 0；不足 21 根 → 0', () => {
  assert.equal(regimeTilt(null), 0)
  assert.equal(regimeTilt(idxSeq(100).slice(0, 10)), 0, '不足 21 根')
  assert.ok(regimeTilt(idxSeq(112)) > 0.9, '大涨应接近 1')
  assert.equal(regimeTilt(idxSeq(90)), 0, '大跌应归 0')
})

test('regimeTilt：tilt>0 把反转权重挪给动量（上涨股得分抬升）', () => {
  const up = Array.from({ length: 25 }, (_, i) => bar(10 + i * 0.2))
  const down = Array.from({ length: 25 }, (_, i) => bar(20 - i * 0.2))
  const feats = [computeFactors(up), computeFactors(down)]
  const w = { reversal: 0.2, midRev: 0.2, upShadow: 0, q: 0 }
  const [up0, down0] = compositeScores(feats, { ...w, tilt: 0 })
  const [up1, down1] = compositeScores(feats, { ...w, tilt: 1 })
  assert.ok(down0 > up0, '纯反转：超跌股更高')
  assert.ok(up1 > up0, '开动量后强势股得分应抬升')
  assert.ok(down1 < down0, '开动量后超跌股得分应下降')
})
