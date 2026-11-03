import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HOLDOUT_CUTOFF, assertTrainRange, assertEvalRange, verifyManifest, sha256,
} from '../scripts/research/guard.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SNAPSHOT = path.resolve(HERE, '../../research/holdout')

test('research/guard：cutoff 是 2026-10-01', () => {
  assert.equal(HOLDOUT_CUTOFF, '2026-10-01')
})

test('research/guard：训练区间不得触及 holdout', () => {
  assert.doesNotThrow(() => assertTrainRange('2026-07-01', '2026-08-31'))
  assert.throws(() => assertTrainRange('2026-09-01', '2026-10-01'), /拒绝训练/)
  assert.throws(() => assertTrainRange('2026-10-08', '2026-10-30'), /拒绝训练/)
})

test('research/guard：评估只能从 cutoff 起', () => {
  assert.doesNotThrow(() => assertEvalRange('2026-10-01', '2026-10-31'))
  assert.throws(() => assertEvalRange('2026-09-30', '2026-10-31'), /拒绝评估/)
})

test('research/guard：真实快照 SHA-256 校验通过', { skip: !fs.existsSync(path.join(SNAPSHOT, 'manifest.json')) }, () => {
  const m = verifyManifest(SNAPSHOT)
  assert.equal(m.cutoff, HOLDOUT_CUTOFF)
  assert.equal(m.files.length, 60)
})

test('research/guard：快照被篡改时抛错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdout-guard-'))
  try {
    const src = path.join(SNAPSHOT, 'forward', 'A', '2026-10-08.json')
    if (!fs.existsSync(src)) return
    const dstDir = path.join(dir, 'forward', 'A')
    fs.mkdirSync(dstDir, { recursive: true })
    const dst = path.join(dstDir, '2026-10-08.json')
    fs.copyFileSync(src, dst)
    const manifest = {
      cutoff: HOLDOUT_CUTOFF,
      files: [{ chain: 'A', date: '2026-10-08', sha256: sha256(fs.readFileSync(dst)) }],
      actions: [],
    }
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
    assert.doesNotThrow(() => verifyManifest(dir))
    fs.appendFileSync(dst, '\n// tampered\n')
    assert.throws(() => verifyManifest(dir), /sha256 mismatch/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
