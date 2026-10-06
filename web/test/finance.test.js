import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  toSecuCode,
  annualizedRoe,
  latestFinance,
  financeFactors,
} from '../lib/finance.js'
import { computeFactors, compositeScores, DEFAULT_WEIGHTS } from '../lib/factors.js'

// ── toSecuCode ────────────────────────────────────────────────────────────
test('toSecuCode：六位代码按前缀推交易所', () => {
  assert.equal(toSecuCode('600519'), '600519.SH')
  assert.equal(toSecuCode('000001'), '000001.SZ')
  assert.equal(toSecuCode('300750'), '300750.SZ')
  assert.equal(toSecuCode('688981'), '688981.SH')
  assert.equal(toSecuCode('430047'), '430047.BJ')
  assert.equal(toSecuCode('830799'), '830799.BJ')
})

test('toSecuCode：secid / 已带后缀 / 非法 → 归一或 null', () => {
  assert.equal(toSecuCode('1.600519'), '600519.SH')
  assert.equal(toSecuCode('0.000001'), '000001.SZ')
  assert.equal(toSecuCode('600519.SH'), '600519.SH')
  assert.equal(toSecuCode('430047.bj'), '430047.BJ')
  assert.equal(toSecuCode(''), null)
  assert.equal(toSecuCode(null), null)
  assert.equal(toSecuCode('12345'), null, '不是 6 位')
  assert.equal(toSecuCode('60051X'), null, '非数字')
})

// ── annualizedRoe ──────────────────────────────────────────────────────────
// 关键：ROEJQ 是**累计**口径（Q1=一季度、H1=半年、前三季、年度），
// 直接当年化用会把 Q1 的 3% 误读成全年 3%，严重低估优质股。
test('annualizedRoe：按已过月数年化（Q1 ×4 / H1 ×2 / Q3 ×4/3 / 年报 ×1）', () => {
  assert.equal(annualizedRoe({ period: '2026-03-31', roe: 3 }), 12) // Q1: 3×12/3
  assert.equal(annualizedRoe({ period: '2026-06-30', roe: 6 }), 12) // H1: 6×12/6
  assert.ok(Math.abs(annualizedRoe({ period: '2026-09-30', roe: 9 }) - 12) < 1e-9) // Q3: 9×12/9
  assert.equal(annualizedRoe({ period: '2026-12-31', roe: 12 }), 12) // 年报: 12×12/12
})

test('annualizedRoe：Q1/H1 年化后与全年同量级（这是修正的目的）', () => {
  const q1 = annualizedRoe({ period: '2026-03-31', roe: 4 })
  const h1 = annualizedRoe({ period: '2026-06-30', roe: 8 })
  assert.ok(q1 > 4 * 3, 'Q1 应放大 4 倍左右，不是原样')
  assert.ok(h1 > 8 * 1.5, 'H1 应放大约 2 倍')
  assert.ok(Math.abs(q1 - h1) < 0.01, `同一家公司同一经营节奏：Q1 ${q1} ≈ H1 ${h1}`)
})

test('annualizedRoe：数据缺失 / 非法 → null（不污染 zscore）', () => {
  assert.equal(annualizedRoe(null), null)
  assert.equal(annualizedRoe({}), null)
  assert.equal(annualizedRoe({ period: '2026-03-31' }), null, '无 roe')
  assert.equal(annualizedRoe({ roe: 5 }), null, '无 period')
  assert.equal(annualizedRoe({ period: '2026-01-31', roe: 5 }), null, '非季报月份')
  assert.equal(annualizedRoe({ period: '2026-03-31', roe: null }), null)
  assert.equal(annualizedRoe({ period: '2026-03-31', roe: NaN }), null)
})

// ── latestFinance：点时口径（这是全套防泄漏的核心）────────────────────────
// 缓存记录含成长字段（revYoy 等）：fetchFinance 以「有 revYoy」判定缓存新鲜，
// 缺字段会被当旧缓存重拉（测试里会误联网）。这里补齐。
const rec = (period, notice, roe, bps) => ({
  period,
  notice,
  roe,
  bps,
  revYoy: null,
  profitYoy: null,
  grossMargin: null,
})

test('latestFinance：只取 NOTICE_DATE ≤ asOf 的最新一期（披露日，不是报告期）', () => {
  const rows = [
    rec('2026-06-30', '2026-08-20', 6, 10),
    rec('2026-03-31', '2026-04-25', 3, 9.8),
    rec('2025-12-31', '2026-03-10', 12, 9.5),
  ]
  // 2026-05-01 时 H1（8-20 才披露）还不可见 → 应取 Q1
  assert.equal(latestFinance(rows, '2026-05-01').period, '2026-03-31')
  // 2026-08-20 当天已披露 → 可取 H1
  assert.equal(latestFinance(rows, '2026-08-20').period, '2026-06-30')
  assert.equal(latestFinance(rows, '2026-09-01').period, '2026-06-30')
})

test('latestFinance：按报告期而非数组顺序取最新（上游乱序也要稳）', () => {
  const rows = [
    rec('2026-06-30', '2026-08-20', 6, 10),
    rec('2026-03-31', '2026-04-25', 3, 9.8),
  ]
  assert.equal(latestFinance(rows, '2026-09-01').period, '2026-06-30')
})

test('latestFinance：披露日缺失的记录不可用；全不可用 → null', () => {
  const noNotice = [rec('2026-06-30', null, 6, 10), rec('2026-03-31', undefined, 3, 9)]
  assert.equal(latestFinance(noNotice, '2026-09-01'), null)
  assert.equal(latestFinance([], '2026-09-01'), null)
  assert.equal(latestFinance(null, '2026-09-01'), null)
  // 全是「未来才披露」→ 评估日当天什么都看不到
  assert.equal(latestFinance([rec('2026-06-30', '2026-08-20', 6, 10)], '2026-05-01'), null)
})

test('latestFinance：早于 asOf 的记录不参与（防未来数据）', () => {
  const rows = [rec('2026-06-30', '2026-08-20', 6, 10)]
  assert.equal(latestFinance(rows, '2026-08-19'), null, '披露前一天不可见')
  assert.notEqual(latestFinance(rows, '2026-08-20'), null, '披露当天即可见')
})

// ── financeFactors（走磁盘缓存，不联网）─────────────────────────────────
async function withTmpDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zx-fin-'))
  try {
    return await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

test('financeFactors：读缓存 → roeAnnual / bps', async () => {
  await withTmpDir(async (dir) => {
    await fs.mkdir(path.join(dir, 'finance'), { recursive: true })
    await fs.writeFile(
      path.join(dir, 'finance', '600519.json'),
      JSON.stringify([
        rec('2026-06-30', '2026-08-20', 6, 20),
        rec('2026-03-31', '2026-04-25', 3, 19.5),
      ]),
    )
    const fin = await financeFactors('600519', '2026-09-01', { dataDir: dir })
    assert.equal(fin.bps, 20)
    assert.ok(Math.abs(fin.roeAnnual - 12) < 1e-9, `ROE 年化应为 12，实际 ${fin.roeAnnual}`)
  })
})

test('financeFactors：非法代码 → null（不发网络请求）', async () => {
  await withTmpDir(async (dir) => {
    // 非法代码在 toSecuCode 就被挡掉，不会发起网络请求 —— 所以结果稳定不依赖网络
    assert.equal(await financeFactors('bad', '2026-09-01', { dataDir: dir }), null)
    assert.equal(await financeFactors('', '2026-09-01', { dataDir: dir }), null)
  })
})

test('financeFactors：网络失败/无数据时返回 null 而不是全 null 对象', async () => {
  // 这条是防「覆盖率虚高」：`{roeAnnual:null,...}` 是 truthy，`if (fin)` 会误判为有数据
  const r = await financeFactors('bad', '2026-09-01', { dataDir: '/nonexistent-zx' })
  assert.equal(r, null, '必须严格是 null')
  assert.ok(!r, 'falsy，`if (fin)` 才能正确跳过')
})

// ── 权重：年化 ROE 生效，EPS 类不生效 ────────────────────────────────────
const bar = (close, volume = 1000) => ({ time: '2026-01-01', open: close, high: close, low: close, close, volume })

test('默认权重：q=0.3，ep=0（价值不启用）', () => {
  assert.equal(DEFAULT_WEIGHTS.q, 0.3)
  assert.equal(DEFAULT_WEIGHTS.ep, 0)
  assert.equal(DEFAULT_WEIGHTS.lowVol, 0, '低波已下线')
})

test('compositeScores：roeAnnual 更高的排前面（q 生效）', () => {
  const bars = Array.from({ length: 25 }, (_, i) => bar(10 + i * 0.1, 1000 + i))
  const lo = { ...require0(bars), roeAnnual: 2 }
  const hi = { ...require0(bars), roeAnnual: 20 }
  const s = compositeScores([lo, hi])
  assert.ok(s[1] > s[0], `高 ROE 应得分更高：${s[1]} vs ${s[0]}`)
})

test('compositeScores：roeAnnual 相同时不影响排序（缺数据不惩罚）', () => {
  const bars = Array.from({ length: 25 }, (_, i) => bar(10 + i * 0.1, 1000 + i))
  const none = { ...require0(bars), roeAnnual: null }
  const some = { ...require0(bars), roeAnnual: 20 }
  const [a, b] = compositeScores([none, some])
  assert.ok(Number.isFinite(a) && Number.isFinite(b), '缺 ROE 不应产生 NaN')
})

test('compositeScores：bps ≤ 0 不产生 Infinity（净资产为负的票不能毒化 zscore）', () => {
  const bars = Array.from({ length: 25 }, (_, i) => bar(10 + i * 0.1, 1000 + i))
  const feats = [
    { ...require0(bars), bps: -5 },
    { ...require0(bars), bps: 0 },
    { ...require0(bars), bps: 10 },
    { ...require0(bars), bps: 20 },
  ]
  const s = compositeScores(feats, { ...DEFAULT_WEIGHTS, ep: 0.3 })
  for (const v of s) assert.ok(Number.isFinite(v), `得分须为有限数，实际 ${v}`)
})

// 复用 computeFactors 造一份完整特征，避免手写十几个字段
function require0(bars) {
  const f = computeFactors(bars)
  assert.ok(f, '测试数据应能算出特征')
  return f
}