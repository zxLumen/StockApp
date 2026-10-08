import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { dueOn, listRecommendDates } from '../lib/recommend.js'
import { writeJson } from '../lib/store.js'

const tmpdir = () => fsp.mkdtemp(path.join(os.tmpdir(), 'dueon-'))
const rec = (date, basisDate, top) => ({ date, basisDate, top })
const pick = (secid, code, name, price, holdDays) => ({ secid, code, name, price, ai: { holdDays } })

test('dueOn：纳入隐藏窗口、精确匹配、同票合并取最早推荐日', async () => {
  const dir = await tmpdir()
  await fsp.mkdir(path.join(dir, 'recommend'), { recursive: true })
  // 隐藏窗口（2026-03-01~09-30）内的推荐：09-24 基准 + 4 交易日 → 到期 10-08
  // （09-25~27 中秋休市、10-01~07 国庆休市，都由交易日历跳过）。
  // 同文件里再放一只 holdDays=1（到期 09-28，不匹配）验证精确匹配。
  await writeJson(
    path.join(dir, 'recommend', '2026-09-28.json'),
    rec('2026-09-28', '2026-09-24', [
      pick('1.600519', '600519', '贵州茅台', 1500, 4),
      pick('0.000002', '000002', '万科A', 8, 1),
    ]),
  )
  // 同票另一次推荐：09-29 基准 + 2 交易日 → 也到期 10-08（应与上条合并，取最早 09-28）
  await writeJson(
    path.join(dir, 'recommend', '2026-09-30.json'),
    rec('2026-09-30', '2026-09-29', [pick('1.600519', '600519', '贵州茅台', 1400, 2)]),
  )

  const items = await dueOn(dir, '2026-10-08')
  assert.equal(items.length, 1, '只应命中贵州茅台一条（合并后）')
  assert.equal(items[0].secid, '1.600519')
  assert.equal(items[0].times, 2, '同票两次命中合并计数')
  assert.equal(items[0].fromDate, '2026-09-28', '取最早推荐日')
  assert.equal(items[0].holdDays, 4)
  assert.equal(items[0].pickPrice, 1500)

  assert.deepEqual(await dueOn(dir, '2026-10-09'), [], '无精确到期')
})

test('dueOn：随链路切换（B 链路读 recommend-factors-fwd）', async () => {
  const dir = await tmpdir()
  await fsp.mkdir(path.join(dir, 'recommend'), { recursive: true })
  await fsp.mkdir(path.join(dir, 'recommend-factors-fwd'), { recursive: true })
  await writeJson(
    path.join(dir, 'recommend', '2026-09-30.json'),
    rec('2026-09-30', '2026-09-29', [pick('1.600519', '600519', '贵州茅台', 1500, 2)]),
  )
  await writeJson(
    path.join(dir, 'recommend-factors-fwd', '2026-09-30.json'),
    rec('2026-09-30', '2026-09-29', [pick('0.399001', '399001', '深证成指', 10, 2)]),
  )
  const dual = await dueOn(dir, '2026-10-08', { chain: 'dual' })
  const b = await dueOn(dir, '2026-10-08', { chain: 'B' })
  assert.deepEqual(dual.map((x) => x.secid), ['1.600519'])
  assert.deepEqual(b.map((x) => x.secid), ['0.399001'])
})

test('listRecommendDates：默认排除隐藏窗口，includeHidden 纳入', async () => {
  const dir = await tmpdir()
  await fsp.mkdir(path.join(dir, 'recommend'), { recursive: true })
  await writeJson(path.join(dir, 'recommend', '2026-09-25.json'), rec('2026-09-25', '2026-09-24', []))
  await writeJson(path.join(dir, 'recommend', '2026-10-08.json'), rec('2026-10-08', '2026-10-07', []))
  assert.deepEqual(await listRecommendDates(dir), ['2026-10-08'])
  assert.deepEqual(await listRecommendDates(dir, 'dual', { includeHidden: true }), ['2026-10-08', '2026-09-25'])
})
