import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { decideActions, dueOn, actionKey, nextTradingDay } from '../lib/recommend.js'
import { readJson, writeJson } from '../lib/store.js'

const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'recactions-'))
const recTop = (secid, code, name, price, holdDays) => ({ secid, code, name, price, ai: { holdDays } })
const quotesOf = (items) => async () => ({ items })
const decisionsOf = (fn) => async (rows) => rows.map(fn)

async function seedRecommend(dir, date, basisDate, top) {
  await fsp.mkdir(path.join(dir, 'recommend'), { recursive: true })
  await writeJson(path.join(dir, 'recommend', `${date}.json`), { date, basisDate, top })
}

test('decideActions：exit 为终态（重复跑不重复终止）', async () => {
  const dir = await tmp()
  await seedRecommend(dir, '2026-10-07', '2026-10-06', [recTop('1.600519', '600519', '贵州茅台', 1500, 10)])
  const deps = {
    quotes: quotesOf([{ secid: '1.600519', price: 1600, changePct: 1.2 }]),
    decide: decisionsOf((r) => ({ id: r.id, action: 'exit', reason: '破位' })),
  }
  const r1 = await decideActions(dir, {}, { chain: 'dual', today: '2026-10-08', deps })
  assert.equal(r1.changed, 1)
  const key = actionKey('dual', '2026-10-07', '600519')
  let actions = await readJson(path.join(dir, 'recommend-actions.json'))
  const pos = actions.positions[key]
  assert.equal(pos.exited, true)
  assert.equal(pos.exit.date, nextTradingDay('2026-10-08'), 'exitDate 记生效日')
  assert.equal(pos.exit.pct, Number(((1600 / 1500 - 1) * 100).toFixed(2)))

  // 再跑：已 exited → 跳过，不再变更（防重复终止）
  const r2 = await decideActions(dir, {}, { chain: 'dual', today: '2026-10-08', deps })
  assert.equal(r2.changed, 0)
  assert.equal(r2.decided, 0, '已终止的票不再进入活跃集合')
  actions = await readJson(path.join(dir, 'recommend-actions.json'))
  assert.equal(actions.positions[key].log.filter((l) => l.action === 'exit').length, 1)
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
