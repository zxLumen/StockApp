import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { readJson } from '../lib/store.js'
import {
  parseJsonLoose,
  buildReviewRows,
  bjDate,
  nextTradingDay,
  normalizeHoldDays,
  pctFromPick,
  selectTop10,
  pickChain,
  resolveChainPayload,
  forwardArchive,
  archiveForwardChains,
  benchReturns,
  isAshareSession,
  recommendTtlMs,
  entryIsoOf,
  entryAtOpen,
  FORWARD_A_DIR,
  FORWARD_B_DIR,
} from '../lib/recommend.js'

test('pickChain：逐日 tilt 门控（≥阈值走 A 激进链路，否则走 B 保守链路）', () => {
  // 阈值 0.6 的实际分界：2024-09 实测 tilt 只取 0.00 / 1.00 两端。
  assert.equal(pickChain(1.0, 0.6), 'A')
  assert.equal(pickChain(0.6, 0.6), 'A', '边界含等号')
  assert.equal(pickChain(0.59, 0.6), 'B')
  assert.equal(pickChain(0.0, 0.6), 'B')
  // 中间值同样按阈值切（37% 的交易日落在这段）。
  assert.equal(pickChain(0.41, 0.6), 'B')
  assert.equal(pickChain(0.66, 0.6), 'A')
  // 阈值可配（日后用真实前瞻数据重标定）。
  assert.equal(pickChain(0.41, 0.3), 'A')
  // 拿不到 tilt / 阈值非法 → 保守走 B，绝不因为数据缺失去赌激进链路。
  assert.equal(pickChain(NaN, 0.6), 'B')
  assert.equal(pickChain(1.0, NaN), 'B')
})

test('resolveChainPayload：优先落 tilt 选中的那条；那条挂了退回另一条；全挂返回 null', () => {
  const A = { id: 'A' }
  const B = { id: 'B' }
  // 正常：tilt 选 A → 落 A
  assert.deepEqual(resolveChainPayload({ useA: true, a: A, b: B }), { payload: A, chain: 'A', fellBack: false })
  assert.deepEqual(resolveChainPayload({ useA: false, a: A, b: B }), { payload: B, chain: 'B', fellBack: false })
  // A 跑挂了（null）而 tilt 选 A → 退回 B，并标记 fellBack（cron 仍能出当天的排行）
  assert.deepEqual(resolveChainPayload({ useA: true, a: null, b: B }), { payload: B, chain: 'B', fellBack: true })
  assert.deepEqual(resolveChainPayload({ useA: false, a: A, b: null }), { payload: A, chain: 'A', fellBack: true })
  // 两条都挂 → null，交给调用方抛错（当天无产出）
  assert.equal(resolveChainPayload({ useA: true, a: null, b: null }), null)
})

test('forwardArchive：只留 pool+top 并带上当天 tilt/thr（前瞻归档，供真实数据判 A/B）', () => {
  const payload = {
    date: '2026-10-08',
    generatedAt: '2026-10-07T10:00:00.000Z',
    basisDate: '2026-10-07',
    model: 'm',
    pool: { size: 500, filtered: 200, candidates: 100 },
    top: [{ code: 'a' }],
    candidates: [{ code: 'a' }, { code: 'b' }],
  }
  const a = forwardArchive({ payload, chain: 'A', tilt: 0.81234, thr: 0.6 })
  assert.equal(a.date, '2026-10-08')
  assert.equal(a.basisDate, '2026-10-07')
  assert.deepEqual(a.top, [{ code: 'a' }])
  assert.equal(a.candidates, undefined, 'candidates 不归档（太重且对照用不到）')
  assert.deepEqual(a.regime, { tilt: 0.8123, thr: 0.6, chain: 'A' })
  // 该链路当天没产出 → 不归档
  assert.equal(forwardArchive({ payload: null, chain: 'B', tilt: 0, thr: 0.6 }), null)
})

test('archiveForwardChains：两条各写一份到 fwd 目录（真实落盘）', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fwd-'))
  const mk = (code) => ({
    date: '2026-10-08',
    generatedAt: 't',
    basisDate: '2026-10-07',
    model: 'm',
    pool: { size: 1 },
    top: [{ code }],
    candidates: [{ code }],
  })
  await archiveForwardChains(dir, { payloadA: mk('a'), payloadB: mk('b'), tilt: 0.5, thr: 0.6, onLog: () => {} })
  const a = await readJson(path.join(dir, FORWARD_A_DIR, '2026-10-08.json'))
  const b = await readJson(path.join(dir, FORWARD_B_DIR, '2026-10-08.json'))
  assert.equal(a.top[0].code, 'a')
  assert.equal(a.regime.chain, 'A')
  assert.equal(a.candidates, undefined)
  assert.equal(b.top[0].code, 'b')
  assert.equal(b.regime.chain, 'B')
  assert.equal(b.regime.tilt, 0.5)
})

test('parseJsonLoose：裸 JSON', () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 })
})

test('parseJsonLoose：```json 代码块围栏', () => {
  assert.deepEqual(parseJsonLoose('好的：\n```json\n{"score": 80}\n```\n以上'), { score: 80 })
})

test('parseJsonLoose：前后夹带文字也能截出 JSON', () => {
  assert.deepEqual(parseJsonLoose('前面的话 {"score": 12, "tags": ["a"]} 后面的话'), {
    score: 12,
    tags: ['a'],
  })
})

test('parseJsonLoose：不是 JSON → null', () => {
  assert.equal(parseJsonLoose('完全不是 json'), null)
  assert.equal(parseJsonLoose(''), null)
})

test('buildReviewRows：把候选拼成评审用的行', () => {
  const rows = buildReviewRows([
    { code: '600418', name: '江淮汽车', monthPct: 30.81, ai: { buyScore: 88, summary: '整车放量' } },
  ])
  assert.match(rows, /600418 江淮汽车/)
  assert.match(rows, /买入评分88/)
  assert.match(rows, /整车放量/)
  assert.match(rows, /整车放量/)
})

test('bjDate：返回 YYYY-MM-DD', () => {
  assert.match(bjDate(new Date('2026-10-04T06:00:00Z')), /^\d{4}-\d{2}-\d{2}$/)
})

test('nextTradingDay：周中 → 次日；周五 → 下周一；周六 → 周一；节假日跳过', () => {
  assert.equal(nextTradingDay('2026-10-08'), '2026-10-09', '周三 → 周四')
  assert.equal(nextTradingDay('2026-10-09'), '2026-10-12', '周五 → 下周一')
  assert.equal(nextTradingDay('2026-10-10'), '2026-10-12', '周六 → 周一')
  assert.equal(nextTradingDay('2026-10-06'), '2026-10-08', '国庆(10-01~10-07)后首日')
  assert.equal(nextTradingDay('2026-10-01'), '2026-10-08', '节假日当天 → 节后首日')
  assert.equal(nextTradingDay('2026-02-13'), '2026-02-24', '春节前最后交易日 → 节后首日')
})

test('pctFromPick：正常计算、除零/缺值返回 null', () => {
  assert.equal(pctFromPick(10, 12), 20)
  assert.equal(pctFromPick(100, 88), -12)
  assert.equal(pctFromPick(0, 12), null)
  assert.equal(pctFromPick(null, 12), null)
  assert.equal(pctFromPick(10, null), null)
})

// selectTop10 在不触发评审（高分 ≤ finalPicks）时不需要 cfg。
const st = (code, buyScore) => ({ code, name: code, ai: { buyScore, summary: '' } })

test('selectTop10：高分不足10只 → 有多少取多少 + 低分垫底（不调评审）', async () => {
  const scored = [st('a', 80), st('b', 70), st('c', 40), st('d', 30)]
  const top = await selectTop10(null, scored, 10, () => {}, { highBar: 60 })
  // 先高分（a,b），再按分把 c,d 垫底补满
  assert.deepEqual(top.map((t) => t.code), ['a', 'b', 'c', 'd'])
  assert.equal(top[0].pickedBy, 'score')
  assert.equal(top[2].pickedBy, 'fill')
})

test('selectTop10：高分恰好≤10 → 不会混入 < highBar 的股', async () => {
  const scored = [st('a', 72), st('b', 65), st('c', 18)]
  const top = await selectTop10(null, scored, 10, () => {}, { highBar: 60 })
  // 只有 2 只高分，补齐时会带上低分（<10 只），但顺序必须高分在前
  assert.deepEqual(top.map((t) => t.code), ['a', 'b', 'c'])
  assert.ok(top[0].ai.buyScore >= 60 && top[1].ai.buyScore >= 60)
})

test('selectTop10：无高分时按分降序取（低分也保留，不崩）', async () => {
  const scored = [st('a', 30), st('b', 20)]
  const top = await selectTop10(null, scored, 10, () => {}, { highBar: 60 })
  assert.deepEqual(top.map((t) => t.code), ['a', 'b'])
})

// ── normalizeHoldDays：模型按个股自由给持仓周期（不锁档位）──────────────────
test('normalizeHoldDays：任意正整数原样保留（不再锁 3/5/10/20）', () => {
  for (const n of [1, 3, 4, 5, 7, 10, 12, 20, 23, 45, 60]) assert.equal(normalizeHoldDays(n), n)
})

test('normalizeHoldDays：小数四舍五入', () => {
  assert.equal(normalizeHoldDays('20'), 20)
  assert.equal(normalizeHoldDays(3.4), 3)
  assert.equal(normalizeHoldDays(19.6), 20)
})

test('normalizeHoldDays：越界钳到 [1,60]，非法/缺失回落兜底 5', () => {
  assert.equal(normalizeHoldDays(0), 5, '0 非法 → 兜底')
  assert.equal(normalizeHoldDays(-3), 5)
  assert.equal(normalizeHoldDays(999), 60, '上限 60')
  for (const v of [null, undefined, 'abc', NaN]) assert.equal(normalizeHoldDays(v), 5)
})

// ── benchReturns：基准指数同期涨跌（接实时点位，盘中不再恒为 0）─────────────
const BENCH = [
  { time: '2020-01-02', close: 4000 },
  { time: '2020-01-03', close: 4050 },
  { time: '2020-01-06', close: 4100 },
]

test('benchReturns：无实时点位时退回日K最后一根', () => {
  // basisDate 是周末（01-05）→ 取 ≤ 它的最后一根 01-03；至今 = 最后一根 01-06。
  const r = benchReturns(BENCH, '2020-01-05', '2020-01-06', null)
  assert.equal(r.sinceIdxPct, Number(((4100 / 4050 - 1) * 100).toFixed(2)))
  assert.equal(r.holdIdxPct, Number(((4100 / 4050 - 1) * 100).toFixed(2)))
})

test('benchReturns：盘中无当日日K时用实时点位（否则会算成 0.00%）', () => {
  // 模拟盘中：日K最后一根停在基准 01-03，实时点位 4090.5；持有结束日在未来 → 用实时。
  const intradayBars = BENCH.slice(0, 2)
  const r = benchReturns(intradayBars, '2020-01-03', '2099-12-31', 4090.5)
  assert.equal(r.sinceIdxPct, Number(((4090.5 / 4050 - 1) * 100).toFixed(2)))
  assert.equal(r.holdIdxPct, Number(((4090.5 / 4050 - 1) * 100).toFixed(2)))
})

test('benchReturns：持有窗口已走完则按结束日收盘，不跟到实时', () => {
  // 结束日 01-06 已是过去交易日 → 用 01-06 收盘 4100，而不是实时点位 9999。
  const r = benchReturns(BENCH, '2020-01-03', '2020-01-06', 9999)
  assert.equal(r.holdIdxPct, Number(((4100 / 4050 - 1) * 100).toFixed(2)))
  // 至今窗口仍取实时
  assert.equal(r.sinceIdxPct, Number(((9999 / 4050 - 1) * 100).toFixed(2)))
})

// ── R2 生效日口径：开买开卖（entryAnchor）────────────────────────────────
test('entryIsoOf/entryAtOpen：新推荐锚生效日、旧推荐锚生成日', () => {
  const nu = { date: '2026-10-08', basisDate: '2026-10-07', entryAnchor: 'effective' }
  assert.equal(entryIsoOf(nu), '2026-10-08')
  assert.equal(entryAtOpen(nu), true)
  const old = { date: '2026-10-08', basisDate: '2026-10-07' }
  assert.equal(entryIsoOf(old), '2026-10-07')
  assert.equal(entryAtOpen(old), false)
})

test('benchReturns：开买开卖用生效日开盘做基准、结束日开盘卖出', () => {
  const bars = [
    { time: '2020-01-02', close: 4000, open: 3900 },
    { time: '2020-01-03', close: 4050, open: 3950 },
    { time: '2020-01-06', close: 4100, open: 4080 },
  ]
  // atOpen：基准 = 01-03 开盘 3950；持有结束 01-06 已走完 → 用 01-06 开盘 4080
  const r = benchReturns(bars, '2020-01-03', '2020-01-06', 9999, { atOpen: true })
  assert.equal(r.holdIdxPct, Number(((4080 / 3950 - 1) * 100).toFixed(2)))
  // 至今：实时点位，但基准仍是开盘 3950
  assert.equal(r.sinceIdxPct, Number(((9999 / 3950 - 1) * 100).toFixed(2)))
})


// ── 盘中窗口 & 读路径缓存 TTL ──────────────────────────────────────────────
test('isAshareSession / recommendTtlMs：盘中 6min、盘后 30min、非交易日不拉', () => {
  // 2026-10-08 是交易日；用 UTC+8 换算构造北京时间。
  const bj = (h, m, day = 8) => new Date(Date.UTC(2026, 9, day, h - 8, m))
  assert.equal(isAshareSession(bj(10, 0)), true)
  assert.equal(isAshareSession(bj(9, 5)), false, '9:15 前不算盘中')
  assert.equal(isAshareSession(bj(16, 0)), false, '收盘后停拉')
  assert.equal(isAshareSession(bj(10, 0, 10)), false, '周六')
  assert.equal(recommendTtlMs(bj(10, 0)), 6 * 60_000)
  assert.equal(recommendTtlMs(bj(20, 0)), 12 * 60 * 60_000)
})
