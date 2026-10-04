import test from 'node:test'
import assert from 'node:assert/strict'
import { normTxTime, parseTxBars, parseTxQuote, toTxCode } from '../lib/tencent.js'
import { parseSinaLong, toSinaCode } from '../lib/sina.js'
import { dedupeShares, parseFundNavMobile, parseFundNavSina, parseFundRank } from '../lib/fund.js'
import { SOURCES, sourceLabel } from '../lib/market.js'
import { parseEmNewsSearch, filterNewsByKeywords } from '../lib/news.js'
import { parseSinaBoards, parseSinaBoardMembers, sinaSymbolToSecid } from '../lib/board-sina.js'

test('toTxCode: 沪深 / 港股 / 指数 / 美股映射到腾讯代码', () => {
  assert.equal(toTxCode('1.600519'), 'sh600519')
  assert.equal(toTxCode('0.399001'), 'sz399001')
  assert.equal(toTxCode('1.000001'), 'sh000001')
  assert.equal(toTxCode('116.00700'), 'hk00700')
  assert.equal(toTxCode('100.HSI'), 'hkHSI')
  assert.equal(toTxCode('124.HSTECH'), 'hkHSTECH')
  assert.equal(toTxCode('100.DJIA'), 'usDJI')
  assert.equal(toTxCode('100.NDX'), 'usNDX')
  assert.equal(toTxCode('100.SPX'), 'usINX')
  assert.equal(toTxCode('105.AAPL'), 'usAAPL')
  // 板块腾讯没有对应品种
  assert.equal(toTxCode('90.BK0475'), null)
  assert.equal(toTxCode(''), null)
})

/** 按列号拼一行腾讯快照，避免手数 `~` 数错位。 */
function txLine(txCode, fields) {
  const c = Array.from({ length: 46 }, () => '0')
  for (const [i, v] of Object.entries(fields)) c[Number(i)] = String(v)
  return `v_${txCode}="${c.join('~')}";`
}

test('parseTxQuote: 取固定列并把成交额从万元换成元', () => {
  const line = txLine('sh600519', {
    1: '贵州茅台',
    2: '600519',
    3: 1258.62,
    4: 1235.58,
    5: 1239.53,
    6: 38331,
    30: '20260930161458',
    31: 23.04,
    32: 1.86,
    33: 1268.0,
    34: 1236.05,
    37: 479725,
    38: 0.31,
  })
  const q = parseTxQuote(line)
  assert.equal(q.txCode, 'sh600519')
  assert.equal(q.name, '贵州茅台')
  assert.equal(q.code, '600519')
  assert.equal(q.price, 1258.62)
  assert.equal(q.prevClose, 1235.58)
  assert.equal(q.open, 1239.53)
  assert.equal(q.change, 23.04)
  assert.equal(q.changePct, 1.86)
  assert.equal(q.high, 1268)
  assert.equal(q.low, 1236.05)
  assert.equal(q.volume, 38331)
  // 37 列是万元
  assert.equal(q.amount, 479725 * 10_000)
  assert.equal(q.turnover, 0.31)
  assert.equal(q.market, 'cn')
})

test('parseTxQuote: 港美股不给成交额 / 换手 / 市值（口径对不上，宁缺勿错）', () => {
  const line = txLine('usAAPL', { 1: '苹果', 2: 'AAPL', 3: 330.32, 6: 36306346, 37: 119670706 })
  const q = parseTxQuote(line)
  assert.equal(q.market, 'us')
  assert.equal(q.price, 330.32)
  assert.equal(q.volume, 36306346)
  assert.equal(q.amount, null)
  assert.equal(q.turnover, null)
  assert.equal(q.marketCap, null)
})

test('parseTxQuote: 残缺 / 空行返回 null', () => {
  assert.equal(parseTxQuote('v_pv_none_match="1";'), null)
  assert.equal(parseTxQuote(''), null)
  assert.equal(parseTxQuote('garbage'), null)
})

test('normTxTime: 日线与分钟两种写法都归一', () => {
  assert.equal(normTxTime('2026-09-30'), '2026-09-30')
  assert.equal(normTxTime('202609301100'), '2026-09-30 11:00')
  assert.equal(normTxTime('20260930'), '2026-09-30')
  assert.equal(normTxTime('bad'), '')
})

test('parseTxBars: 排序、取尾、丢掉混入的早年脏行', () => {
  const rows = [
    ['2026-09-28', '1', '2', '3', '0.5', '10'],
    ['2026-09-30', '2', '3', '4', '1.5', '20'],
  ]
  const bars = parseTxBars(rows)
  assert.equal(bars.length, 2)
  assert.equal(bars[0].time, '2026-09-28')
  assert.equal(bars[1].close, 3)

  // 腾讯偶尔把美股 IPO 当年那根混在最前面
  const withJunk = [['2011-06-02', '1', '2', '3', '0.5', '10'], ...rows]
  const cleaned = parseTxBars(withJunk)
  assert.equal(cleaned.length, 2)
  assert.equal(cleaned[0].time, '2026-09-28')
})

test('parseTxBars: limit 生效，空输入返回空数组', () => {
  const rows = Array.from({ length: 10 }, (_, i) => [
    `2026-09-${String(i + 1).padStart(2, '0')}`,
    '1',
    '2',
    '3',
    '0.5',
    '10',
  ])
  assert.equal(parseTxBars(rows, { limit: 3 }).length, 3)
  assert.deepEqual(parseTxBars(null), [])
  assert.deepEqual(parseTxBars([['x', '1', '2', '3', '0.5', '1']]), [])
})

test('toSinaCode: 沪深 / 港 / 美股映射', () => {
  assert.equal(toSinaCode('1.600519'), 'sh600519')
  assert.equal(toSinaCode('0.399001'), 'sz399001')
  assert.equal(toSinaCode('1.000001'), 'sh000001')
  assert.equal(toSinaCode('116.00700'), 'hk00700')
  assert.equal(toSinaCode('100.HSI'), 'hkHSI')
  assert.equal(toSinaCode('105.AAPL'), 'gb_aapl')
  assert.equal(toSinaCode('90.BK0475'), null)
})

test('parseSinaLong: A 股长表，成交量由股换成手', () => {
  const body =
    '贵州茅台,1239.530,1235.580,1258.620,1268.000,1236.050,1258.620,1258.650,3833098,4797246636.000'
  const q = parseSinaLong(body, 'sh600519')
  assert.equal(q.name, '贵州茅台')
  assert.equal(q.price, 1258.62)
  assert.equal(q.prevClose, 1235.58)
  assert.equal(q.high, 1268)
  // 3833098 股 → 38331 手，和东财口径一致
  assert.equal(q.volume, 38331)
  assert.equal(q.amount, 4797246636)
  // A 股长表没有涨跌列，用昨收推
  assert.equal(q.changePct, 1.86)
})

test('parseSinaLong: 港股长表（英文名 + 中文名占前两列）', () => {
  const body = 'TENCENT,腾讯控股,422.000,431.000,425.000,419.800,421.200,-9.800,-2.274,421.2,421.4,8059664706.422,19108045'
  const q = parseSinaLong(body, 'hk00700')
  assert.equal(q.name, '腾讯控股')
  assert.equal(q.price, 421.2)
  assert.equal(q.changePct, -2.274)
  assert.equal(q.volume, 19108045)
})

test('parseSinaLong: 美股长表', () => {
  const body = '苹果,330.3200,-0.81,2026-10-02 18:46:03,-2.7000,330.0000,332.4816,325.8100,345.3400,242.8900,36306322'
  const q = parseSinaLong(body, 'gb_aapl')
  assert.equal(q.price, 330.32)
  assert.equal(q.changePct, -0.81)
  assert.equal(q.change, -2.7)
  assert.equal(q.open, 330)
  assert.equal(q.volume, 36306322)
})

test('parseSinaLong: 现价为 0 / 字段不足时返回 null', () => {
  assert.equal(parseSinaLong('苹果,0.0000,0.00', 'gb_aapl'), null)
  assert.equal(parseSinaLong('a,b', 'sh600519'), null)
})

test('parseFundRank: 解析 rankhandler 的 datas CSV', () => {
  const body =
    'var rankData = {datas:["002910,易方达供给改革混合,YFDGJGGHH,2026-09-30,7.9474,7.9474,0.91,-2.55,-6.57,-9.42,101.59,142.68,206.84,192.45,115.67,694.74,2017-01-25,1,694.74,1.50%,0.15%,1,0.15%,1,242.83"],allRecords:9000};'
  const rows = parseFundRank(body)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].code, '002910')
  assert.equal(rows[0].name, '易方达供给改革混合')
  assert.equal(rows[0].nav, 7.9474)
  assert.equal(rows[0].d1, 0.91)
  assert.equal(rows[0].y1, 142.68)
  assert.deepEqual(parseFundRank('nothing here'), [])
})

test('dedupeShares: A/C 份额只留一只，优先 A', () => {
  const items = [
    { code: '015140', name: '泰康医疗健康股票发起C' },
    { code: '015139', name: '泰康医疗健康股票发起A' },
    { code: '024632', name: '中欧消费精选混合发起A' },
  ]
  const out = dedupeShares(items)
  assert.equal(out.length, 2)
  const tk = out.find((o) => o.code === '015139')
  assert.ok(tk, '应该保留 A 份额')
})

test('SOURCES: 个股降级链为 东财 → 腾讯 → 新浪，板块追加 同花顺 → 中证', () => {
  assert.deepEqual(
    SOURCES.map((s) => s.id),
    ['eastmoney', 'tencent', 'sina', 'ths', 'csi'],
  )
  assert.equal(sourceLabel('tencent'), '腾讯')
  assert.equal(sourceLabel('sina'), '新浪')
  assert.equal(sourceLabel('eastmoney'), '东财')
})
test('parseFundNavMobile: 东财移动端历史净值倒序且剔除脏行', () => {
  const out = parseFundNavMobile([
    { FSRQ: '2026-09-30', DWJZ: '1.5778', LJJZ: '1.60', JZZZL: '0.29' },
    { FSRQ: '2026-09-29', DWJZ: '1.5733', LJJZ: '1.59', JZZZL: '0.12' },
    { FSRQ: '', DWJZ: '1.5', LJJZ: '1.5', JZZZL: '0' },
    { FSRQ: '2026-09-28', DWJZ: '--', LJJZ: '1.5', JZZZL: '0' },
  ])
  assert.equal(out.length, 2)
  assert.equal(out[0].date, '2026-09-29', '应按日期正序返回')
  assert.equal(out[1].nav, 1.5778)
  assert.equal(out[1].changePct, 0.29)
})

test('parseFundNavSina: 新浪无日涨跌字段，用前一日净值补算', () => {
  const out = parseFundNavSina([
    { fbrq: '2026-09-30 00:00:00', jjjz: '2.0000', ljjz: '3.1000' },
    { fbrq: '2026-09-29 00:00:00', jjjz: '1.9600', ljjz: '3.0600' },
  ])
  assert.equal(out.length, 2)
  assert.equal(out[0].date, '2026-09-29')
  assert.equal(out[0].changePct, null, '首点没有前值')
  assert.equal(out[1].nav, 2)
  assert.equal(out[1].accNav, 3.1)
  assert.equal(out[1].changePct, 2.04)
})

test('parseFundNavMobile: 非法输入不炸', () => {
  assert.deepEqual(parseFundNavMobile(null), [])
  assert.deepEqual(parseFundNavMobile('nope'), [])
  assert.deepEqual(parseFundNavSina(undefined), [])
})

test('腾讯快照：时间戳归一化 + 成交额/换手/市值只对 A 股给出', () => {
  const q = parseTxQuote("v_sh000001=\"1~上证指数~000001~3842.19~3830.45~3839.25~414560247~0~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~~20260930161500~11.74~0.31~3851.22~3833.09~3842.19/414560247/679398992445~414560247~67939899~0.85~16.76~~3851.22~3833.09~0.47~602370.78~682245.82~0.00~-1~-1~0.92~0~3842.53~~~~~~67939899.2445~0.0000~0~ ~ZS~-3.19~-2.78~~~~4258.86~3741.11~-0.57~-3.46~-3.71~4858320758781~~-9.37~-4.50~4858320758781~~~-1.05~-0.02~~CNY~0~~0.00~0~\";")
  assert.equal(q.name, '上证指数')
  assert.equal(q.price, 3842.19)
  assert.equal(q.change, 11.74)
  assert.equal(q.changePct, 0.31)
  assert.equal(q.high, 3851.22)
  assert.equal(q.low, 3833.09)
  assert.equal(q.time, '2026-09-30 16:15', '时间戳应归一成东财那套格式')
  assert.equal(q.market, 'cn')
  assert.equal(q.volume, 414560247)
  assert.equal(q.turnover, 0.85)
  assert.equal(q.amount, 67939899 * 10_000, '成交额那列单位是万元')
  assert.equal(q.floatCap, 602370.78 * 1e8, '流通市值单位是亿元')
  assert.equal(q.marketCap, 682245.82 * 1e8)

  const u = parseTxQuote("v_usAAPL=\"200~苹果~AAPL.OQ~330.32~333.02~330.00~36306346~0~0~330.75~200~0~0~0~0~0~0~0~0~330.80~120~0~0~0~0~0~0~0~0~~2026-10-01 16:00:01~-2.70~-0.81~332.48~325.81~USD~36306346~11967070676~0.25~37.88~~44.28~~2.00~48177.53165~48207.49538~Apple Inc.~8.72~345.34~242.76~80~44.84~0.32~48207.49538~21.83~-1.67~GP~148.75~36.08~-1.98~1.65~5.50~14594180000~14585108878~1.03~36.01~1.06~329.61~~~~~\";")
  assert.equal(u.name, '苹果')
  assert.equal(u.code, 'AAPL.OQ')
  assert.equal(u.market, 'us')
  assert.equal(u.time, '2026-10-01 16:00', '已是常见格式也要归一')
  assert.equal(u.amount, null, '口径没确认的字段宁可留空')
  assert.equal(u.turnover, null)
  assert.equal(u.marketCap, null)
  assert.equal(u.volume, 36306346, '成交量仍照实给')
})

test('normTxTime 三种写法都归一到东财格式', () => {
  assert.equal(normTxTime('2026-09-30'), '2026-09-30')
  assert.equal(normTxTime('202609301100'), '2026-09-30 11:00', '分钟 12 位')
  assert.equal(normTxTime('20260930161500'), '2026-09-30 16:15', '快照带秒 14 位')
  assert.equal(normTxTime('2026-10-01 16:00:01'), '2026-10-01 16:00', '已带空格也归一')
  assert.equal(normTxTime(''), '')
  assert.equal(normTxTime(null), '')
  assert.equal(normTxTime('乱码'), '')
})

test('parseEmNewsSearch: 去 <em> 高亮、解析时间与来源', () => {
  const out = parseEmNewsSearch({
    result: {
      cmsArticleWebOld: [
        {
          date: '2026-09-28 15:13:39',
          title: '段永平加仓<em>贵州茅台</em>',
          content: '【大河财立方消息】 <b>正文</b>',
          mediaName: '大河财立方',
          url: 'http://finance.eastmoney.com/a/202609283885177261.html',
        },
        { date: '2026-09-28 14:45:06', title: '', content: '', mediaName: '', url: '' },
      ],
    },
  })
  assert.equal(out.length, 1, '空标题应被剔除')
  assert.equal(out[0].title, '段永平加仓贵州茅台')
  assert.equal(out[0].source, '大河财立方')
  assert.equal(out[0].summary, '【大河财立方消息】 正文')
  assert.ok(typeof out[0].time === 'number' && out[0].time > 0)
  assert.deepEqual(parseEmNewsSearch(null), [])
})

test('parseSinaBoards: 拆 var 前缀、字段映射、涨跌家数留空', () => {
  const text =
    'var S_Finance_bankuai_sinaindustry = {"new_blhy":"new_blhy,玻璃行业,19,16.733157894737,0.0010526315789474,0.0062910886728949,410050588,9066360698,sz300395,2.395,94.920,2.220,菲利华"};'
  const out = parseSinaBoards(text)
  assert.equal(out.length, 1)
  assert.equal(out[0].code, 'new_blhy')
  assert.equal(out[0].name, '玻璃行业')
  assert.equal(out[0].changePct, 0.0062910886728949)
  assert.equal(out[0].leader, '菲利华')
  assert.equal(out[0].leaderPct, 2.395)
  assert.equal(out[0].up, null)
  assert.equal(out[0].down, null)
})

test('sinaSymbolToSecid + parseSinaBoardMembers', () => {
  assert.equal(sinaSymbolToSecid('sh600519'), '1.600519')
  assert.equal(sinaSymbolToSecid('sz300395'), '0.300395')
  assert.equal(sinaSymbolToSecid('usAAPL'), null)
  const rows = parseSinaBoardMembers([
    { symbol: 'sz300395', code: '300395', name: '菲利华', trade: '94.920', changepercent: 2.395 },
    { symbol: '', code: '', name: '', trade: '1', changepercent: 0 },
  ])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].secid, '0.300395')
  assert.equal(rows[0].code, '300395')
  assert.equal(rows[0].price, 94.92)
  assert.equal(rows[0].changePct, 2.395)
  assert.deepEqual(parseSinaBoardMembers(null), [])
})

test('filterNewsByKeywords: 单字关键词忽略', () => {
  const news = [
    { title: '贵州茅台发布三季报', summary: '' },
    { title: '比亚迪销量创新高', summary: '' },
  ]
  assert.equal(filterNewsByKeywords(news, ['茅台', '贵州茅台']).length, 1)
  assert.equal(filterNewsByKeywords(news, ['茅']).length, 0, '单字太宽不放行')
})
