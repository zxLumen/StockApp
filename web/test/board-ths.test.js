import test from 'node:test'
import assert from 'node:assert/strict'
import {
  matchBoards,
  parseThsConceptList,
  parseThsIndustryList,
  parseThsMembers,
  thsCodeToSecid,
} from '../lib/board-ths.js'
import { CSI_INDUSTRIES } from '../lib/board-csi.js'
import { marketOf } from '../lib/eastmoney.js'
import { SOURCES, sourceLabel } from '../lib/market.js'

/**
 * 下面三段 fixture 是照 2026-10 实抓的同花顺页面 markup 抄的（只留解析用到的最小结构）：
 *   /thshy/            行业列表，12 列表格 + A~Z 侧栏
 *   /gn/               概念列表，内嵌 input#gnSection 的 JSON
 *   /gn/detail/code/300188/  概念详情，主表 + table.series-table 子行业分组
 */

/** 行业列表表头实测：序号|板块|涨跌幅|总成交量|总成交额|净流入|涨家|跌家|均价|领涨股|最新价|涨跌幅 */
function industryRow(code, name, pct, up, down, leader, leaderCode, leaderPct) {
  return `<tr>
    <td>1</td>
    <td><a href="http://q.10jqka.com.cn/thshy/detail/code/${code}/" target="_blank">${name}</a></td>
    <td class="c-rise">${pct}</td>
    <td>878.68</td>
    <td>236.62</td>
    <td>14.36</td>
    <td class="c-rise">${up}</td>
    <td class="c-fall">${down}</td>
    <td>26.93</td>
    <td><a href="http://stockpage.10jqka.com.cn/${leaderCode}/" target="_blank">${leader}</a></td>
    <td class="c-rise">102.64</td>
    <td class="c-rise">${leaderPct}</td>
  </tr>`
}

/** A~Z 侧栏分类：只有代码 + 名称（首页表格没渲染的那 40 个就是长这样）。 */
function sidebarGroup(entries) {
  return `<div class="cate_group">${entries
    .map(([code, name]) => `<a href="http://q.10jqka.com.cn/thshy/detail/code/${code}/" target="_blank">${name}</a>`)
    .join('')}</div>`
}

test('parseThsIndustryList: 表格取统计字段，侧栏补纯名称条目', () => {
  const html =
    industryRow('881142', '生物制品', '4.63', 53, 2, '康希诺', '688185', '20.00') +
    sidebarGroup([
      ['881121', '半导体'],
      ['881114', '通信设备'],
    ])
  const items = parseThsIndustryList(html)
  assert.equal(items.length, 3)

  const bio = items.find((x) => x.code === '881142')
  assert.equal(bio.name, '生物制品')
  assert.equal(bio.changePct, 4.63)
  assert.equal(bio.up, 53)
  assert.equal(bio.down, 2)
  assert.equal(bio.volume, 878.68)
  assert.equal(bio.amount, 236.62)
  assert.equal(bio.netInflow, 14.36)
  assert.equal(bio.leader, '康希诺')
  assert.equal(bio.leaderCode, '688185')
  assert.equal(bio.leaderPct, 20)

  // 侧栏条目要进得来（搜索 / K 线要用），统计字段留 null
  const semi = items.find((x) => x.code === '881121')
  assert.equal(semi.name, '半导体')
  assert.equal(semi.up, null)
  assert.equal(semi.changePct, null)
})

test('parseThsIndustryList: 同一代码在表格和侧栏都出现时只留一条（表格版优先）', () => {
  const html =
    industryRow('881121', '半导体', '-2.92', 10, 179, '晶晨股份', '688099', '7.17') +
    sidebarGroup([['881121', '半导体']])
  const items = parseThsIndustryList(html)
  assert.equal(items.length, 1)
  assert.equal(items[0].up, 10)
  assert.equal(items[0].leader, '晶晨股份')
})

test('parseThsConceptList: 从 input#gnSection 取 platecode→cid 映射', () => {
  // 实页面把整个 JSON 塞在 value='...' 的单引号里
  const data = {
    885333: { platecode: '885333', platename: '移动支付', cid: '300188', '199112': '-0.36', zjjlr: '-4.78' },
    886000: { platecode: '886000', platename: '一体化压铸', cid: '308984', '199112': '1.25', zjjlr: '2.10' },
    // 非概念（行业 platecode）要被过滤掉
    881121: { platecode: '881121', platename: '半导体', cid: '', '199112': '-2.92', zjjlr: '' },
  }
  const html = `<html><body><input id="gnSection" value='${JSON.stringify(data)}' /></body></html>`
  const items = parseThsConceptList(html)
  assert.equal(items.length, 2, '881xxx 行业不该混进概念')

  const pay = items.find((x) => x.code === '885333')
  assert.equal(pay.name, '移动支付')
  assert.equal(pay.cid, '300188', 'cid 是概念成分股页的关键')
  assert.equal(pay.changePct, -0.36)
  assert.equal(pay.netInflow, -4.78)
  assert.equal(pay.up, null, '概念列表没有涨跌家数')
  assert.equal(items.find((x) => x.code === '886000').cid, '308984')
})

test('parseThsConceptList: 缺 gnSection / JSON 坏了都返回空数组', () => {
  assert.deepEqual(parseThsConceptList('<html></html>'), [])
  assert.deepEqual(parseThsConceptList(`<input id="gnSection" value='{oops' />`), [])
})

/** 概念详情主表首行（实测）：代码|名称|最新价|涨跌幅|涨跌额|… */
function memberRow(rank, code, name, price, pct, change) {
  return `<tr>
    <td>${rank}</td>
    <td><a href="http://stockpage.10jqka.com.cn/${code}/" target="_blank">${code}</a></td>
    <td><a href="http://stockpage.10jqka.com.cn/${code}" target="_blank">${name}</a></td>
    <td class="c-rise">${price}</td>
    <td class="c-rise">${pct}</td>
    <td class="c-rise">${change}</td>
    <td class="">0.00</td><td>8.70</td><td>12.65</td>
  </tr>`
}

test('parseThsMembers: 主表 + series-table 子行业分组都要抓', () => {
  const html = `<html><body>
    <table class="table"><tbody>
      ${memberRow(1, '920748', '路桥信息', '34.20', '10.07', '3.13')}
      ${memberRow(2, '600577', '精达股份', '12.00', '-1.00', '-0.12')}
    </tbody></table>
    <table class="series-table"><tbody>
      <tr><td><a class="label label-m"><p class="title">支付终端</p></a></td></tr>
      <tr><td>
        <a href="http://stockpage.10jqka.com.cn/002711/" target="_blank" class="label label-s">
          <p class="title">欧浦退</p>
          <p class="data c-rise">+6.67%&nbsp;&nbsp;+0.32</p>
          <span class="line"></span>
        </a>
        <a href="http://stockpage.10jqka.com.cn/000861/" target="_blank" class="label label-s">
          <p class="title">海印股份</p>
          <p class="data c-rise">+0.00%&nbsp;&nbsp;+0.00</p>
          <span class="line"></span>
        </a>
      </td></tr>
    </tbody></table></body></html>`
  const items = parseThsMembers(html)
  const byCode = Object.fromEntries(items.map((x) => [x.code, x]))

  assert.ok(byCode['920748'], '主表成员')
  assert.ok(byCode['600577'])
  assert.ok(byCode['002711'], '子行业分组里的成员')
  assert.ok(byCode['000861'])

  const road = byCode['920748']
  assert.equal(road.name, '路桥信息')
  assert.equal(road.price, 34.2)
  assert.equal(road.changePct, 10.07)
  assert.equal(road.change, 3.13)
  assert.equal(road.secid, '0.920748', '北交所 920 要映射成 0.')

  // label-s 分组条目只有「名称 + 涨跌幅」：没有最新价，第二个数字不是涨跌额（实测是别的口径），
  // 所以 change 一律留 null，别拿它当涨跌额显示。
  const op = byCode['002711']
  assert.equal(op.name, '欧浦退')
  assert.equal(op.changePct, 6.67)
  assert.equal(op.change, null)
  assert.equal(op.price, null)
})

test('parseThsMembers: 同一代码在主表和分组表重复出现只留一条', () => {
  const html = `<table><tbody>
      ${memberRow(1, '000001', '平安银行', '11.00', '2.00', '0.22')}
      <tr><td><a href="http://stockpage.10jqka.com.cn/000001/" class="label label-s">
        <p class="title">平安银行</p><p class="data">+2.00% +0.22</p></a></td></tr>
    </tbody></table>`
  assert.equal(parseThsMembers(html).length, 1)
})

test('thsCodeToSecid: 沪 / 科创 / 深 / 创业板 / 北交所', () => {
  assert.equal(thsCodeToSecid('600519'), '1.600519')
  assert.equal(thsCodeToSecid('688099'), '1.688099')
  assert.equal(thsCodeToSecid('000001'), '0.000001')
  assert.equal(thsCodeToSecid('002711'), '0.002711')
  assert.equal(thsCodeToSecid('300750'), '0.300750')
  assert.equal(thsCodeToSecid('920748'), '0.920748')
  assert.equal(thsCodeToSecid('12345'), null, '不是 6 位要拒')
  assert.equal(thsCodeToSecid(''), null)
})

test('matchBoards: 代码 > 前缀 > 名称 > 去后缀包含，逐级降权', () => {
  const list = [
    { code: '881121', name: '半导体', changePct: -2.92 },
    { code: '885908', name: '第三代半导体', changePct: 1.5 },
    { code: '885966', name: '跨境支付(CIPS)', changePct: 0.8 },
    { code: '881273', name: '白酒', changePct: 3.0 },
  ]
  assert.equal(matchBoards(list, '881121')[0].code, '881121', '代码完全命中排第一')
  // 前缀命中可能多个，同分按涨跌幅降序（热门板块排前面）
  assert.deepEqual(
    matchBoards(list, '8859').map((x) => x.code),
    ['885908', '885966'],
    '代码前缀命中，同分按涨跌幅',
  )
  // 名称完全命中（score 2）优于名称包含（score 4）
  assert.deepEqual(
    matchBoards(list, '半导体').map((x) => x.code),
    ['881121', '885908'],
  )
  assert.equal(matchBoards(list, '跨境支付(CIPS)')[0].code, '885966')
  assert.equal(matchBoards(list, '白酒')[0].code, '881273')
  assert.deepEqual(matchBoards(list, ''), [])
  assert.deepEqual(matchBoards(list, 'zzz不存在'), [])
})

test('matchBoards: 去后缀匹配，「行业」「指数」这类尾巴不参与', () => {
  const list = [{ code: '000928', name: '中证能源指数', changePct: 0.5 }]
  assert.equal(matchBoards(list, '中证能源')[0].code, '000928')
  assert.equal(matchBoards(list, '能源')[0].code, '000928', '应剥掉「指数」后缀再匹配')
})

test('板块 secid 归类：90.<code> 与 91.<code> 都算 board', () => {
  assert.equal(marketOf('90.881121'), 'board', '同花顺行业')
  assert.equal(marketOf('90.885333'), 'board', '同花顺概念')
  assert.equal(marketOf('91.000928'), 'board', '中证行业')
  assert.equal(marketOf('90.BK0475'), 'board', '东财板块')
  assert.equal(marketOf('1.600519'), 'cn')
  assert.equal(marketOf('105.AAPL'), 'us')
})

test('同花顺 / 中证接进了 SOURCES 且有中文名', () => {
  const ids = SOURCES.map((s) => (typeof s === 'string' ? s : s.id))
  assert.ok(ids.includes('ths'), 'ths 要在 SOURCES 里')
  assert.ok(ids.includes('csi'), 'csi 要在 SOURCES 里')
  assert.equal(sourceLabel('ths'), '同花顺')
  assert.ok(sourceLabel('csi'), 'csi 要有中文名')
})

test('CSI_INDUSTRIES: 10 个一级行业，代码连续且不重复', () => {
  assert.equal(CSI_INDUSTRIES.length, 10)
  assert.deepEqual(
    CSI_INDUSTRIES.map((x) => x.code),
    ['000928', '000929', '000930', '000931', '000932', '000933', '000934', '000935', '000936', '000937'],
  )
  for (const x of CSI_INDUSTRIES) {
    assert.match(x.code, /^\d{6}$/)
    assert.ok(x.name, `${x.code} 要有名称`)
  }
})
