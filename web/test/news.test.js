import test from 'node:test'
import assert from 'node:assert/strict'
import { filterNewsByKeywords } from '../lib/news.js'

const NEWS = [
  { title: '茅台上半年净利增长12%', summary: '贵州茅台发布业绩', url: 'a' },
  { title: '央行开展逆回购操作', summary: '流动性投放', url: 'b' },
  { title: '贵州茅台回应渠道价格波动', summary: null, url: 'c' },
  { title: 'NVIDIA 发布新财报', summary: 'AI 芯片需求', url: 'd' },
]

test('按名称命中标题与摘要', () => {
  const hit = filterNewsByKeywords(NEWS, ['茅台'])
  assert.equal(hit.length, 2)
  assert.deepEqual(
    hit.map((x) => x.url),
    ['a', 'c'],
  )
})

test('按代码命中', () => {
  const hit = filterNewsByKeywords(NEWS, ['600519'])
  assert.equal(hit.length, 0)
})

test('大小写无关；单字关键词太宽，被忽略', () => {
  assert.equal(filterNewsByKeywords(NEWS, ['nvidia']).length, 1)
  assert.equal(filterNewsByKeywords(NEWS, ['行']).length, 0)
})

test('多关键词任一命中即可，空关键词返回空数组', () => {
  assert.equal(filterNewsByKeywords(NEWS, ['茅台', 'NVIDIA']).length, 3)
  assert.equal(filterNewsByKeywords(NEWS, []).length, 0)
  assert.equal(filterNewsByKeywords(NEWS, ['']).length, 0)
})

test('limit 生效', () => {
  assert.equal(filterNewsByKeywords(NEWS, ['茅台'], { limit: 1 }).length, 1)
})