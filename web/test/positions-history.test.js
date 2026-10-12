import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// 注意：`lib/scope.js` 在**模块加载时**读取 STOCK_DATA_DIR，所以必须在**动态 import** positions.js
// 之前把 env 设好；本文件因此不能静态 import 任何会（间接）加载 scope.js 的模块，一律动态 import。
// 依赖 `node --test` 默认的「每个测试文件独立子进程」隔离。
//
// 日期取**可见窗口**内的固定日（2026-10-01 起才对外展示；更早是训练/验证样本，被隐藏）：
//   买入 B=10-08；原始周期 1 天 → S0=10-09；后来延长到 5 天 → S1=10-15。
//   回看 asOf=10-09（=S0）：用当日快照(1 天)应显示**已了结**，用当前(5 天)才会显示持仓中。
test('buildPositionsAll：回看历史日用当日 actions 快照，且不把未来生效的推荐算进来', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pos-hist-'))
  process.env.STOCK_DATA_DIR = dir

  const { buildPositionsAll } = await import('../lib/positions.js')
  const { addTradingDays } = await import('../lib/trading-days.js')
  const { bjDate } = await import('../lib/recommend.js')
  const { writeJson } = await import('../lib/store.js')

  const SECID = '1.600000'
  const CODE = '600000'
  const BENCH = '1.000300'

  const B = '2026-10-08'
  const S0 = addTradingDays(B, 1) // 2026-10-09
  const asOf = '2026-10-09'
  const S1 = addTradingDays(B, 5) // 2026-10-15
  assert.ok(S0 <= asOf && asOf < S1, '构造区间：S0 ≤ asOf < S1')
  assert.ok(asOf < bjDate(), 'asOf 必须是过去日（否则走「最新」口径）')

  const bars = (dates) => dates.map((t, i) => ({ time: t, open: 10 + i, close: 10 + i }))
  await writeJson(path.join(dir, 'kline-cache', `${SECID}.json`), { bars: bars([B, S0, asOf]) })
  await writeJson(path.join(dir, 'kline-cache', `${BENCH}.json`), { bars: bars([B, asOf]) })

  // 生效日 B 的推荐（开买开卖）。另放一条**更晚生效**的推荐，回看 asOf 时不能把它算进来。
  await writeJson(path.join(dir, 'recommend', `${B}.json`), {
    date: B,
    basisDate: '2026-10-07',
    entryAnchor: 'effective',
    model: 'm',
    pool: { size: 1 },
    top: [{ secid: SECID, code: CODE, name: '测试股', price: 10, ai: { holdDays: 1, buyScore: 88 } }],
  })
  const F = '2026-10-12' // 晚于 asOf 才生效
  await writeJson(path.join(dir, 'recommend', `${F}.json`), {
    date: F,
    basisDate: asOf,
    entryAnchor: 'effective',
    model: 'm',
    pool: { size: 1 },
    top: [{ secid: '1.600001', code: '600001', name: '未来股', price: 20, ai: { holdDays: 5, buyScore: 90 } }],
  })

  // 当前 actions：已被延长到 5 天
  await writeJson(path.join(dir, 'recommend-actions.json'), {
    version: 1,
    positions: { [`dual:${B}:${CODE}`]: { chain: 'dual', recDate: B, holdDays: 5, exited: false } },
  })
  // 回看日 asOf 的**当日快照**：当时还是 1 天
  await writeJson(path.join(dir, 'actions-archive', `${asOf}.json`), {
    version: 1,
    positions: { [`dual:${B}:${CODE}`]: { chain: 'dual', recDate: B, holdDays: 1, exited: false } },
  })

  const p = await buildPositionsAll(dir, { asOf })
  assert.equal(p.asOf, asOf)
  assert.equal(p.actionsAsOf, asOf)
  assert.equal(p.actionsFaithful, true)
  // 只有 B 那天的一笔（F 生效日晚于 asOf → 未建仓）
  assert.equal(p.chains.dual.orig.summary.count, 1, '未来生效的推荐不计入历史持仓')
  // AI 口径用快照的 1 天 → S0=asOf ≤ asOf → 已了结（若误用当前的 5 天则会显示为持仓中）
  assert.equal(p.chains.dual.ai.summary.closedCount, 1)
  assert.equal(p.chains.dual.ai.summary.openCount, 0)
  assert.ok(p.dates.includes(B) && p.dates.includes(asOf))

  // 更早、且无快照的日子 → 回退当前 actions（标不忠实），5 天周期 → 仍持仓中
  const asOf2 = B
  const p2 = await buildPositionsAll(dir, { asOf: asOf2 })
  assert.equal(p2.actionsFaithful, false)
  assert.equal(p2.actionsAsOf, null)
  assert.equal(p2.chains.dual.ai.summary.openCount, 1)

  delete process.env.STOCK_DATA_DIR
})
