import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { coarseSector } from '../lib/industry.js'

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

test('coarseSector：东财细分行业归并到申万一级', () => {
  assert.equal(coarseSector('半导体'), '电子')
  assert.equal(coarseSector('其他电子Ⅱ'), '电子')
  assert.equal(coarseSector('电子化学品'), '电子')
  assert.equal(coarseSector('军工电子Ⅱ'), '国防军工')
  assert.equal(coarseSector('航空装备Ⅱ'), '国防军工')
  assert.equal(coarseSector('航空机场'), '交通运输')
  assert.equal(coarseSector('化学制药'), '医药生物')
  assert.equal(coarseSector('电池'), '电力设备')
  assert.equal(coarseSector('电网设备'), '电力设备')
  assert.equal(coarseSector('通用设备'), '机械设备')
  assert.equal(coarseSector('通信设备'), '通信')
  assert.equal(coarseSector('软件开发'), '计算机')
  assert.equal(coarseSector('证券'), '非银金融')
  // 已是申万一级：原样返回（不被二次归并）
  assert.equal(coarseSector('电子'), '电子')
  assert.equal(coarseSector('银行'), '银行')
  assert.equal(coarseSector('非银金融'), '非银金融')
})

test('coarseSector：未命中的行业原样返回（不误合并）', () => {
  assert.equal(coarseSector('某新行业'), '某新行业')
  assert.equal(coarseSector('?'), '?')
  assert.equal(coarseSector(''), '?')
})

test('industryOf：本地冻结映射优先（离线可复现）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ind-map-'))
  const file = path.join(dir, 'map.json')
  fs.writeFileSync(file, JSON.stringify({ industries: { '1.688525': '半导体' } }))
  const prev = process.env.RECOMMEND_INDUSTRY_MAP
  process.env.RECOMMEND_INDUSTRY_MAP = file
  try {
    // cache-busting query：拿到一份重新读 env 的模块实例
    const mod = await import(`../lib/industry.js?t=${Date.now()}`)
    assert.equal(await mod.industryOf('1.688525'), '半导体')
    assert.equal(mod.industryMapSize(), 1)
  } finally {
    if (prev === undefined) delete process.env.RECOMMEND_INDUSTRY_MAP
    else process.env.RECOMMEND_INDUSTRY_MAP = prev
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('industryOf：deps.industry 注入优先于映射', async () => {
  const mod = await import('../lib/industry.js')
  assert.equal(await mod.industryOf('anything', { industry: () => '注入行业' }), '注入行业')
})

test('config/industry-map.json 已就位（随镜像发布，选股读它）', () => {
  const p = path.join(WEB, 'config', 'industry-map.json')
  const j = JSON.parse(fs.readFileSync(p, 'utf8'))
  assert.ok(j.total > 1000, `行业映射覆盖应 > 1000，实际 ${j.total}`)
  assert.equal(j.industries['1.688525'], '电子')
})