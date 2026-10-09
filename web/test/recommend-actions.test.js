import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { decideActions, dueOn, actionKey, nextTradingDay, exitMinHoldDays, reconcileCross } from '../lib/recommend.js'
import { addTradingDays } from '../lib/trading-days.js'
import { readJson, writeJson } from '../lib/store.js'

const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'recactions-'))
const recTop = (secid, code, name, price, holdDays) => ({ secid, code, name, price, ai: { holdDays } })
const quotesOf = (items) => async () => ({ items })
const decisionsOf = (fn) => async (rows) => rows.map(fn)

async function seedRecommend(dir, date, basisDate, top) {
  await fsp.mkdir(path.join(dir, 'recommend'), { recursive: true })
  await writeJson(path.join(dir, 'recommend', `${date}.json`), { date, basisDate, top })
}

test('exitMinHoldDays：按周期相对化（短周期放宽、长周期封顶 3）', () => {
  assert.equal(exitMinHoldDays(2), 1)
  assert.equal(exitMinHoldDays(3), 1)
  assert.equal(exitMinHoldDays(4), 2)
  assert.equal(exitMinHoldDays(10), 3)
  assert.equal(exitMinHoldDays(120), 3)
  assert.equal(exitMinHoldDays(0), 1)
})

test('decideActions：exit 过护栏（跌幅 ≤ −8% 且持有 ≥ min）后为终态', async () => {
  const dir = await tmp()
  const basis = '2026-10-08'
  const today = addTradingDays(basis, 4) // 已持有 4 个交易日 ≥ min(3, ⌊10/2⌋=5→3)
  await seedRecommend(dir, basis, basis, [recTop('1.600519', '600519', '贵州茅台', 1500, 10)])
  const deps = {
    quotes: quotesOf([{ secid: '1.600519', price: 1350 }]), // −10%
    decide: decisionsOf((r) => ({ id: r.id, action: 'exit', reason: '破位' })),
  }
  const r1 = await decideActions(dir, {}, { chain: 'dual', today, deps })
  assert.equal(r1.changed, 1)
  const key = actionKey('dual', basis, '600519')
  let actions = await readJson(path.join(dir, 'recommend-actions.json'))
  const pos = actions.positions[key]
  assert.equal(pos.exited, true)
  assert.equal(pos.exit.date, nextTradingDay(today), 'exitDate 记生效日')
  assert.equal(pos.exit.pct, Number(((1350 / 1500 - 1) * 100).toFixed(2)))

  // 再跑：已 exited → 跳过，不再变更（防重复终止）
  const r2 = await decideActions(dir, {}, { chain: 'dual', today, deps })
  assert.equal(r2.changed, 0)
  assert.equal(r2.decided, 0, '已终止的票不再进入活跃集合')
  actions = await readJson(path.join(dir, 'recommend-actions.json'))
  assert.equal(actions.positions[key].log.filter((l) => l.action === 'exit').length, 1)
})

test('decideActions：跌幅未到止损线 → 护栏拦截，不终止', async () => {
  const dir = await tmp()
  const basis = '2026-10-08'
  const today = addTradingDays(basis, 4)
  await seedRecommend(dir, basis, basis, [recTop('1.600519', '600519', '贵州茅台', 1500, 10)])
  const deps = {
    quotes: quotesOf([{ secid: '1.600519', price: 1470 }]), // −2%，未到 −8%
    decide: decisionsOf((r) => ({ id: r.id, action: 'exit', reason: '走弱' })),
  }
  const r = await decideActions(dir, {}, { chain: 'dual', today, deps })
  assert.equal(r.changed, 0)
  assert.equal(r.gated, 1)
  const pos = (await readJson(path.join(dir, 'recommend-actions.json'))).positions[actionKey('dual', basis, '600519')]
  assert.equal(!!pos.exited, false, '未触发终止')
  assert.ok(pos.log.some((l) => l.action === 'gated-exit'), '记录一条 gated-exit 便于复盘')
})

test('decideActions：持有不足最小天数 → 护栏拦截', async () => {
  const dir = await tmp()
  const basis = '2026-10-08'
  const today = nextTradingDay(basis) // 只持有 1 日 < min(3, ⌊10/2⌋)=3
  await seedRecommend(dir, basis, basis, [recTop('1.600519', '600519', '贵州茅台', 1500, 10)])
  const deps = {
    quotes: quotesOf([{ secid: '1.600519', price: 1300 }]), // −13%，跌幅够但太早
    decide: decisionsOf((r) => ({ id: r.id, action: 'exit' })),
  }
  const r = await decideActions(dir, {}, { chain: 'dual', today, deps })
  assert.equal(r.changed, 0)
  assert.equal(r.gated, 1)
  const pos = (await readJson(path.join(dir, 'recommend-actions.json'))).positions[actionKey('dual', basis, '600519')]
  assert.equal(!!pos.exited, false)
})

test('decideActions：allowExit=false 时完全不终止', async () => {
  const dir = await tmp()
  const basis = '2026-10-08'
  const today = addTradingDays(basis, 4)
  await seedRecommend(dir, basis, basis, [recTop('1.600519', '600519', '贵州茅台', 1500, 10)])
  const deps = {
    quotes: quotesOf([{ secid: '1.600519', price: 1300 }]), // −13%，本可终止
    decide: decisionsOf((r) => ({ id: r.id, action: 'exit' })),
  }
  const r = await decideActions(dir, {}, { chain: 'dual', today, allowExit: false, deps })
  assert.equal(r.changed, 0)
  const actions = await readJson(path.join(dir, 'recommend-actions.json'), { positions: {} })
  assert.equal(!!actions.positions[actionKey('dual', basis, '600519')]?.exited, false)
})

test('decideActions：退出落在自然到期日 → 不算提前终止', async () => {
  const dir = await tmp()
  const basis = '2026-10-08'
  // holdDays=1 → 自然到期日 = 10-09；今天 = 10-08（其 nextTradingDay 恰为 10-09）→ 应忽略 exit
  const today = '2026-10-08'
  await seedRecommend(dir, basis, basis, [recTop('1.600519', '600519', '贵州茅台', 1500, 1)])
  const deps = {
    quotes: quotesOf([{ secid: '1.600519', price: 1300 }]), // −13%
    decide: decisionsOf((r) => ({ id: r.id, action: 'exit' })),
  }
  const r = await decideActions(dir, {}, { chain: 'dual', today, deps })
  assert.equal(r.changed, 0)
  const actions = await readJson(path.join(dir, 'recommend-actions.json'), { positions: {} })
  assert.equal(!!actions.positions[actionKey('dual', basis, '600519')]?.exited, false)
})

test('decideActions：extend 更新生效周期、同日去重、上限 clamp', async () => {
  const dir = await tmp()
  await seedRecommend(dir, '2026-10-07', '2026-10-06', [recTop('1.600519', '600519', '贵州茅台', 1500, 10)])
  const key = actionKey('dual', '2026-10-07', '600519')
  const quotes = quotesOf([{ secid: '1.600519', price: 1520 }])

  await decideActions(dir, {}, { chain: 'dual', today: '2026-10-08', deps: { quotes, decide: decisionsOf((r) => ({ id: r.id, action: 'extend', holdDays: 30 })) } })
  let actions = await readJson(path.join(dir, 'recommend-actions.json'))
  assert.equal(actions.positions[key].holdDays, 30)

  // 同一天再 extend 到 50 → 同日去重，保持 30
  await decideActions(dir, {}, { chain: 'dual', today: '2026-10-08', deps: { quotes, decide: decisionsOf((r) => ({ id: r.id, action: 'extend', holdDays: 50 })) } })
  actions = await readJson(path.join(dir, 'recommend-actions.json'))
  assert.equal(actions.positions[key].holdDays, 30, '同日只延长一次')

  // 次日 extend 到 200 → clamp 到 120
  await decideActions(dir, {}, { chain: 'dual', today: '2026-10-09', deps: { quotes, decide: decisionsOf((r) => ({ id: r.id, action: 'extend', holdDays: 200 })) } })
  actions = await readJson(path.join(dir, 'recommend-actions.json'))
  assert.equal(actions.positions[key].holdDays, 120)
})

test('decideActions：已到期持仓不再决策', async () => {
  const dir = await tmp()
  // basis 2026-09-30 + 1 交易日 = 2026-10-08（到期日）
  await seedRecommend(dir, '2026-10-08', '2026-09-30', [recTop('1.600519', '600519', '贵州茅台', 1500, 1)])
  const deps = { quotes: quotesOf([{ secid: '1.600519', price: 1600 }]), decide: decisionsOf((r) => ({ id: r.id, action: 'exit' })) }
  const r = await decideActions(dir, {}, { chain: 'dual', today: '2026-10-08', deps })
  assert.equal(r.decided, 0, 'holdEndDate == today 视为已到期')
})

test('dueOn：合并「周期到期」与「当日提前终止」两路，终止优先', async () => {
  const dir = await tmp()
  // 周期到期来源：basis 2026-09-30 + 1 交易日 = 2026-10-08
  await seedRecommend(dir, '2026-10-08', '2026-09-30', [recTop('1.600519', '600519', '贵州茅台', 1500, 1)])
  // 提前终止来源：exitDate == 2026-10-08
  await writeJson(path.join(dir, 'recommend-actions.json'), {
    version: 1,
    positions: {
      [actionKey('dual', '2026-09-28', '000001')]: {
        chain: 'dual', recDate: '2026-09-28', secid: '0.000001', code: '000001', name: '平安银行',
        holdDays: 5, basisDate: '2026-09-24', pickPrice: 10, exited: true,
        exit: { date: '2026-10-08', basisDate: '2026-10-07', price: 11, pct: 10, reason: '' },
      },
    },
  })
  const items = await dueOn(dir, '2026-10-08', { chain: 'dual' })
  const byCode = new Map(items.map((x) => [x.code, x]))
  assert.equal(byCode.get('600519').terminated, false)
  assert.equal(byCode.get('000001').terminated, true)
  assert.equal(byCode.get('000001').exitPct, 10)
})

test('reconcileCross：交叉票 AI 二选一（keep 撤销终止 / sell 剔除并滚动回填）', async () => {
  const dir = await tmp()
  const E = '2026-10-12'
  const s = (code) => ({ secid: `1.${code}`, code, name: code, ai: { buyScore: 80, summary: '' } })
  // 当日 payload：top=[X,Y,Z]，候选池里还有 W、V 用于回填
  await fsp.mkdir(path.join(dir, 'recommend'), { recursive: true })
  await writeJson(path.join(dir, 'recommend', `${E}.json`), {
    date: E,
    top: [s('X'), s('Y'), s('Z')],
    candidates: [s('X'), s('Y'), s('Z'), s('W'), s('V')],
  })
  // X、Y 都是「当日被提前终止」的持仓（交叉票）
  const mkPos = (code) => ({
    chain: 'dual', recDate: '2026-10-08', secid: `1.${code}`, code, name: code,
    holdDays: 3, basisDate: '2026-10-08', pickPrice: 10, exited: true,
    exit: { date: E, basisDate: '2026-10-09', price: 9.5, pct: -5, reason: '走弱' }, log: [],
  })
  await writeJson(path.join(dir, 'recommend-actions.json'), {
    version: 1,
    positions: {
      [actionKey('dual', '2026-10-08', 'X')]: mkPos('X'),
      [actionKey('dual', '2026-10-08', 'Y')]: mkPos('Y'),
    },
  })
  const deps = { crossDecide: async (row) => ({ action: row.code === 'X' ? 'keep' : 'sell' }) }
  const r = await reconcileCross(dir, {}, { chain: 'dual', effective: E, finalPicks: 3, deps })
  assert.equal(r.arbitrated, 2)
  assert.equal(r.dropped, 1)
  const payload = await readJson(path.join(dir, 'recommend', `${E}.json`))
  assert.deepEqual(payload.top.map((t) => t.code), ['X', 'Z', 'W'], 'Y 被剔除、X 保留、回填 W')
  const actions = await readJson(path.join(dir, 'recommend-actions.json'))
  assert.equal(actions.positions[actionKey('dual', '2026-10-08', 'X')].exited, false, 'keep → 撤销终止')
  assert.equal(actions.positions[actionKey('dual', '2026-10-08', 'Y')].exited, true, 'sell → 保持终止')
})
