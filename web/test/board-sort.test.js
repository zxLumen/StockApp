import test from 'node:test'
import assert from 'node:assert/strict'
import {
  countMissing,
  DEFAULT_SORT,
  sortBoards,
  sortableKeys,
} from '../src/lib/boardSort.js'

/** 只给排序用得到的字段，别的省略。 */
const b = (code, name, extra = {}) => ({ code, name, secid: `90.${code}`, kind: 'concept', ...extra })

/** 排完取 code 序列，断言起来最短。 */
const codes = (list, key, dir) => sortBoards(list, key, dir).map((x) => x.code)

test('sortBoards: 默认按涨幅降序，概念那种无序输入也能排出名次', () => {
  const list = [
    b('885333', '移动支付', { changePct: -0.36 }),
    b('885334', '重组蛋白', { changePct: 3.78 }),
    b('885335', 'CRO概念', { changePct: 1.2 }),
  ]
  assert.deepEqual(codes(list, 'changePct', 'desc'), ['885334', '885335', '885333'])
  assert.deepEqual(codes(list, 'changePct', 'asc'), ['885333', '885335', '885334'])
})

test('sortBoards: 缺数据恒沉底 —— 升序也不能把 null 顶到最前', () => {
  // 40 个行业因上游第 2 页限流没有 changePct。若按 null→0 处理，
  // 它们会被夹在中间，读者会误以为那是「涨跌幅接近 0」的一批。
  const list = [
    b('881201', '有数据-跌', { changePct: -2 }),
    b('881202', '缺数据A', { changePct: null }),
    b('881203', '缺数据B', { changePct: undefined }),
    b('881204', '有数据-涨', { changePct: 5 }),
    b('881205', '缺数据C', {}),
  ]
  assert.deepEqual(codes(list, 'changePct', 'desc'), ['881204', '881201', '881202', '881203', '881205'])
  assert.deepEqual(codes(list, 'changePct', 'asc'), ['881201', '881204', '881202', '881203', '881205'])
  // NaN / Infinity 也要当缺数据，不能让比较结果变成 NaN 而打乱顺序
  const nan = [b('1', 'a', { changePct: NaN }), b('2', 'b', { changePct: 1 })]
  assert.deepEqual(codes(nan, 'changePct', 'desc'), ['2', '1'])
})

test('sortBoards: 全部缺数据时不炸，退化成按 code 稳定排序', () => {
  const list = [b('881300', '丙'), b('881100', '甲'), b('881200', '乙')]
  // changePct 全缺 → 三者在数值上等价，按 code 兜底
  assert.deepEqual(codes(list, 'changePct', 'desc'), ['881100', '881200', '881300'])
  // name 仍按拼音排（bing < jia < yi），跟 code 顺序刻意不同，用来确认两条路径是分开的
  assert.deepEqual(codes(list, 'name', 'asc'), ['881300', '881100', '881200'])
})

test('sortBoards: 同值按 code 兜底，两次排序结果必须一致（不能自己重排）', () => {
  const list = [
    b('885340', '丁', { changePct: 1.5 }),
    b('885336', '乙', { changePct: 1.5 }),
    b('885337', '丙', { changePct: 1.5 }),
    b('885338', '甲', { changePct: 1.5 }),
  ]
  const once = codes(list, 'changePct', 'desc')
  const twice = codes([...list].reverse(), 'changePct', 'desc')
  assert.deepEqual(once, ['885336', '885337', '885338', '885340'])
  assert.deepEqual(twice, once, '输入顺序不同也必须排出同一个名次')
})

test('sortBoards: name 按中文拼音排，direction 反向生效', () => {
  const list = [b('1', '移动支付'), b('2', '白酒'), b('3', '人工智能')]
  assert.deepEqual(codes(list, 'name', 'asc'), ['2', '3', '1'])
  assert.deepEqual(codes(list, 'name', 'desc'), ['1', '3', '2'])
})

test('sortBoards: 主力净流入 / 成交额 / 涨跌家数 都能排', () => {
  const list = [
    b('1', '甲', { changePct: 1, netInflow: -4.78, amount: 100, up: 10 }),
    b('2', '乙', { changePct: 1, netInflow: 12.3, amount: 90, up: 30 }),
    b('3', '丙', { changePct: 1, netInflow: null, amount: null, up: null }),
  ]
  assert.deepEqual(codes(list, 'netInflow', 'desc'), ['2', '1', '3'])
  assert.deepEqual(codes(list, 'amount', 'desc'), ['1', '2', '3'])
  assert.deepEqual(codes(list, 'up', 'desc'), ['2', '1', '3'])
})

test('sortBoards: 不修改入参', () => {
  const list = [b('2', '乙', { changePct: 1 }), b('1', '甲', { changePct: 9 })]
  const before = list.map((x) => x.code)
  sortBoards(list, 'changePct', 'desc')
  assert.deepEqual(list.map((x) => x.code), before)
})

test('DEFAULT_SORT: 行业/概念按涨幅降序，中证没行情所以按名称', () => {
  assert.deepEqual(DEFAULT_SORT.industry, { key: 'changePct', dir: 'desc' })
  assert.deepEqual(DEFAULT_SORT.concept, { key: 'changePct', dir: 'desc' })
  assert.deepEqual(DEFAULT_SORT.csi, { key: 'name', dir: 'asc' })
})

test('sortableKeys: 没有数据的列不给排（点了不会动）', () => {
  // 概念：只有涨幅和主力净流入，成交额/涨跌家数全为 null
  const concept = [b('1', '甲', { changePct: 1, netInflow: 2 })]
  assert.deepEqual([...sortableKeys(concept)].sort(), ['changePct', 'name', 'netInflow'])
  // 中证：10 个静态名单，什么行情都没有，只有名称可排
  assert.deepEqual([...sortableKeys([b('000928', '能源', {})])], ['name'])
})

test('countMissing: 数出缺数据的板块数，用于「N 个已排在末尾」提示', () => {
  const list = [
    b('1', '甲', { changePct: 1 }),
    b('2', '乙', { changePct: null }),
    b('3', '丙', { changePct: undefined }),
    b('4', '丁', { changePct: -1 }),
  ]
  assert.equal(countMissing(list, 'changePct'), 2)
  // name 没有「缺数据」的概念
  assert.equal(countMissing(list, 'name'), 0)
})
