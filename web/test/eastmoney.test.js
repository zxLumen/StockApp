import test from 'node:test'
import assert from 'node:assert/strict'
import {
  INDEX_GROUPS,
  KLINE_PERIODS,
  cleanHtml,
  decodeQuote,
  marketOf,
  mapSuggest,
  withDerived,
  withMa,
} from '../lib/eastmoney.js'

test('marketOf: A股 / 港股 / 美股 / 板块', () => {
  assert.equal(marketOf('1.600519'), 'cn')
  assert.equal(marketOf('0.000001'), 'cn')
  assert.equal(marketOf('116.09988'), 'hk')
  assert.equal(marketOf('116.00700'), 'hk')
  assert.equal(marketOf('90.BK0475'), 'board')
  assert.equal(marketOf('106.BABA'), 'us')
  assert.equal(marketOf('100.DJIA'), 'us')
  // 港股指数与美股指数共用 100. 前缀，只能靠代码区分
  assert.equal(marketOf('100.HSI'), 'hk')
  assert.equal(marketOf('124.HSTECH'), 'hk')
  assert.equal(marketOf('100.SPX'), 'us')
})

test('INDEX_GROUPS 覆盖沪 / 深 / 港，且 secid 形态合法', () => {
  const all = [...INDEX_GROUPS.cn, ...INDEX_GROUPS.us]
  assert.ok(all.length >= 8)
  for (const g of all) {
    assert.match(g.secid, /^\d+\.[A-Za-z0-9._-]+$/)
    assert.ok(g.name)
  }
  const cnNames = INDEX_GROUPS.cn.map((g) => g.name)
  assert.ok(cnNames.some((n) => n.includes('上证')))
  assert.ok(cnNames.some((n) => n.includes('深证')))
  assert.ok(cnNames.some((n) => n.includes('恒生')))
})

test('KLINE_PERIODS 覆盖日/周/月与分钟线', () => {
  const keys = KLINE_PERIODS.map((p) => p.key)
  for (const k of ['d', 'w', 'm', 'm60', 'm30', 'm15', 'm5']) assert.ok(keys.includes(k), `缺少 ${k}`)
})

test('withMa: 窗口不足为 null，之后是收盘价均值', () => {
  const bars = Array.from({ length: 22 }, (_, i) => ({
    time: `2026-01-${String(i + 1).padStart(2, '0')}`,
    open: 1,
    close: i + 1,
    high: 1,
    low: 1,
    volume: 1,
    amount: 1,
    amplitude: 1,
    changePct: 1,
    change: 1,
    turnover: 1,
  }))
  const out = withMa(bars)
  assert.equal(out[0].ma5, null)
  assert.equal(out[3].ma5, null)
  assert.equal(out[4].ma5, 3) // (1+2+3+4+5)/5
  assert.equal(out[8].ma5, 7) // (5+6+7+8+9)/5
  assert.equal(out[9].ma10, 5.5) // (1..10)/10
  assert.equal(out[18].ma20, null)
  assert.equal(out[19].ma20, 10.5) // (1..20)/20
  assert.equal(out[21].ma20, 12.5) // (3..22)/20
})

test('decodeQuote: 按 f1 位数还原价格，换手率再除 100', () => {
  const q = decodeQuote({
    f1: 2,
    f2: 1680,
    f3: 120,
    f4: 20,
    f5: 12345678,
    f6: 20000000000,
    f8: 250,
    f12: '600519',
    f13: 1,
    f14: '贵州茅台',
    f15: 1700,
    f16: 1660,
    f17: 1665,
    f18: 1660,
    f20: 2e12,
    f21: 2e12,
  })
  assert.equal(q.secid, '1.600519')
  assert.equal(q.market, 'cn')
  assert.equal(q.price, 16.8)
  assert.equal(q.changePct, 1.2)
  assert.equal(q.change, 0.2)
  assert.equal(q.high, 17)
  assert.equal(q.prevClose, 16.6)
  assert.equal(q.turnover, 2.5)
  assert.equal(q.volume, 12345678)
})

test('decodeQuote: 空值返回 null 而不是 NaN', () => {
  const q = decodeQuote({ f1: '-', f2: '-', f3: '-', f4: '-', f5: '-', f12: 'AAPL', f13: 105, f14: '苹果' })
  assert.equal(q.price, null)
  assert.equal(q.changePct, null)
  assert.equal(q.market, 'us')
})

test('mapSuggest: 优先用 QuoteID，并识别市场', () => {
  const s = mapSuggest({ Code: '09988', Name: '阿里巴巴-W', MktNum: 116, QuoteID: '116.09988', SecurityTypeName: '港股' })
  assert.equal(s.secid, '116.09988')
  assert.equal(s.market, 'hk')
  assert.equal(s.code, '09988')
  const s2 = mapSuggest({ Code: 'HSTECH', Name: '恒生科技指数', MktNum: 124 })
  assert.equal(s2.secid, '124.HSTECH')
  assert.equal(s2.market, 'hk')
})

test('cleanHtml: 去掉标签与多余空白', () => {
  assert.equal(cleanHtml('<b>沪深300</b>指数'), '沪深300指数')
  assert.equal(cleanHtml('  a \n b  '), 'a b')
  assert.equal(cleanHtml(null), '')
})
test('withDerived: OHLCV 缺失时从前收精确还原涨跌幅与振幅', () => {
  // 腾讯日K 只有 OHLCV（无 change / changePct / amplitude），AI 上下文和图表都要这两个值。
  // 600519 2026-10-02：前收 1237.5 → 收 1260.5，真实值 23.04 / 1.86% / 2.59%。
  const bars = withDerived([
    { time: '2026-10-01', open: 1238, high: 1250, low: 1230, close: 1237.5, volume: 100, amount: null, turnover: null },
    { time: '2026-10-02', open: 1245, high: 1266, low: 1234, close: 1260.5, volume: 200, amount: null, turnover: null },
  ])
  const last = bars[1]
  assert.equal(last.change, 23)
  assert.equal(last.changePct, 1.86)
  assert.equal(last.amplitude, 2.59)
  // 成交额 / 换手率在 OHLCV 里根本推不出来，必须留 null 而不是编一个 0
  assert.equal(last.amount, null)
  assert.equal(last.turnover, null)
})

test('withDerived: 已有权威值不覆盖；首根无前收保持 null；空数组安全', () => {
  const bars = withDerived([
    { time: '2026-10-01', close: 10, change: null, changePct: null, amplitude: null },
    { time: '2026-10-02', close: 11, change: 99, changePct: 88, amplitude: 77 },
  ])
  assert.equal(bars[0].changePct, null)
  assert.equal(bars[0].amplitude, null)
  // 东财快照本身带这三个字段，属于权威值，不能被本地算法覆盖
  assert.equal(bars[1].change, 99)
  assert.equal(bars[1].changePct, 88)
  assert.equal(bars[1].amplitude, 77)
  assert.deepEqual(withDerived([]), [])
})

test('withDerived: 前收为 0 / close 缺失时不产生 Infinity 或 NaN', () => {
  const bars = withDerived([
    { time: '2026-10-01', close: 0 },
    { time: '2026-10-02', close: null },
    { time: '2026-10-03', close: 5 },
  ])
  // 算不出来时字段保持「没有值」（key 缺省或 null 都一样，JSON 里都不会出现）
  assert.ok(bars[1].changePct == null)
  // 前一根 close 是 null，不能算出 Infinity 塞进 prompt
  assert.ok(bars[2].changePct == null)
  assert.ok(bars[2].amplitude == null)
  for (const b of bars) {
    for (const k of ['change', 'changePct', 'amplitude']) {
      if (b[k] != null) assert.ok(Number.isFinite(b[k]), `${k} 出现了非有限数`)
    }
  }
})
