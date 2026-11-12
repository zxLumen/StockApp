import test from 'node:test'
import assert from 'node:assert/strict'

import { MODEL, objectiveDeviationRange } from '../lib/model-config.js'

/** 临时清掉/恢复 env，避免调参环境变量影响默认值断言。 */
function withEnv(overrides, fn) {
  const keys = ['RECOMMEND_DEV_LO', 'RECOMMEND_DEV_HI']
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  try {
    for (const k of keys) delete process.env[k]
    for (const [k, v] of Object.entries(overrides)) process.env[k] = v
    return fn()
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

test('objectiveDeviationRange：默认值来自 config/model.json 的 objective，不写死 15/40', () => {
  withEnv({}, () => {
    assert.deepEqual(objectiveDeviationRange(), {
      lo: MODEL.objective.maxDeviation,
      hi: MODEL.objective.devHi,
    })
  })
})

test('objectiveDeviationRange：RECOMMEND_DEV_LO/HI 可覆盖；非法值回落模型', () => {
  withEnv({ RECOMMEND_DEV_LO: '12', RECOMMEND_DEV_HI: '38' }, () => {
    assert.deepEqual(objectiveDeviationRange(), { lo: 12, hi: 38 })
  })
  withEnv({ RECOMMEND_DEV_LO: 'nope', RECOMMEND_DEV_HI: '' }, () => {
    assert.deepEqual(objectiveDeviationRange(), {
      lo: MODEL.objective.maxDeviation,
      hi: MODEL.objective.devHi,
    })
  })
})
