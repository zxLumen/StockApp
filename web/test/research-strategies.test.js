import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REG = path.resolve(HERE, '../../research/configs/strategies-2026-11.json')

test('research/strategies：注册表结构合法', () => {
  const r = JSON.parse(fs.readFileSync(REG, 'utf8'))
  assert.ok(r.strategies.length >= 20, '至少 20 个候选')
  assert.ok(r.forwardWindow.from >= '2026-10-01', '前瞻窗不得早于 holdout cutoff')
  const ids = new Set()
  for (const s of r.strategies) {
    assert.ok(!ids.has(s.id), `重复 id: ${s.id}`)
    ids.add(s.id)
    assert.ok(r.holdRules[s.hold], `未知 hold: ${s.hold}`)
    assert.ok(['A', 'B', 'dual', 'blend50', 'dual-tilt', 'Btuned'].includes(s.source), `未知 source: ${s.source}`)
    assert.ok(['fixed', 'llm', 'trail'].includes(r.holdRules[s.hold].type))
  }
})
