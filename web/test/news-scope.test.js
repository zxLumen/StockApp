import test from 'node:test'
import assert from 'node:assert/strict'

import { marketNewsUrl, newsScope, filterNewsByKeywords } from '../lib/news.js'

test('newsScope: 只有 us 算美股，其余一律归 A 股', () => {
  assert.equal(newsScope('us'), 'us')
  assert.equal(newsScope('US'), 'cn', '不该让前端传什么就吃什么')
  assert.equal(newsScope('cn'), 'cn')
  assert.equal(newsScope(undefined), 'cn')
  assert.equal(newsScope(''), 'cn')
  assert.equal(newsScope('../etc/passwd'), 'cn')
})

test('marketNewsUrl: 美股走海外频道，不能和 A 股同源', () => {
  const cn = marketNewsUrl('cn', 20)
  const us = marketNewsUrl('us', 20)
  assert.notEqual(cn, us, '美股和 A 股必须是两个不同的源')
  // A 股：财经频道
  assert.match(cn, /pageid=155&lid=1686/)
  // 美股：环球市场频道（实测美股相关占比明显更高）
  assert.match(us, /pageid=153&lid=2518/)
  assert.match(cn, /num=20/)
  assert.match(us, /num=20/)
})

test('marketNewsUrl: 缺省 scope 落到 A 股源', () => {
  assert.equal(marketNewsUrl(undefined, 20), marketNewsUrl('cn', 20))
})

test('filterNewsByKeywords: 美股个股兜底不会误收 A 股新闻', () => {
  const cnNews = [
    { title: '贵州茅台上半年净利增长 12%', summary: null },
    { title: '沪指今日震荡走高', summary: null },
  ]
  const usNews = [
    { title: '英伟达盘后涨超 4%，华尔街上调目标价', summary: '科技股' },
    { title: '美国 9 月非农数据公布', summary: '就业' },
  ]
  // A 股新闻里不该出现美股关键词，反之亦然
  assert.equal(filterNewsByKeywords(cnNews, ['英伟达', '非农']).length, 0)
  assert.equal(filterNewsByKeywords(usNews, ['贵州茅台']).length, 0)
  assert.equal(filterNewsByKeywords(usNews, ['英伟达']).length, 1)
  // 单字关键词太宽，忽略（否则「税」「金」之类会命中一片）
  assert.equal(filterNewsByKeywords(cnNews, ['茅']).length, 0)
})