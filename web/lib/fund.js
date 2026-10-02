import { fetchJson, fetchText, cached } from './http.js'
import { fundNav, fundQuotes } from './eastmoney.js'

// 场外基金的「首页内容」：一块实时净值榜（东财排名接口）+ 一组按分类精选的代表性基金。
// 榜单是全市场几千只基金按区间涨幅排的，波动很大，只当「行情速览」用，不做任何推荐。
const RANK_HOST = 'https://fund.eastmoney.com/data/rankhandler.aspx'
const RANK_ENCODING = 'utf-8'
const RANK_FIELDS = {
  code: 0,
  name: 1,
  date: 3,
  nav: 4,
  accNav: 5,
  d1: 6,
  w1: 7,
  m1: 8,
  y1: 11,
}

/** 榜单可排序的区间。 */
export const FUND_RANK_SORTS = [
  { key: 'd1', label: '日涨幅' },
  { key: 'w1', label: '近1周' },
  { key: 'm1', label: '近1月' },
  { key: 'y1', label: '近1年' },
]

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * 解析 rankhandler 的 `datas` 数组：每行一条逗号分隔的 CSV。
 * 单独抽出来是为了能离线单测。
 */
export function parseFundRank(body) {
  const start = body.indexOf('datas:[')
  const end = body.indexOf('],allRecords')
  if (start < 0 || end < start) return []
  const rows = body.slice(start + 'datas:['.length, end + 1).match(/"([^"]*)"/g) || []
  return rows
    .map((raw) => raw.slice(1, -1).split(','))
    .filter((c) => c.length > RANK_FIELDS.y1 && c[RANK_FIELDS.code])
    .map((c) => ({
      code: c[RANK_FIELDS.code],
      name: c[RANK_FIELDS.name],
      date: c[RANK_FIELDS.date],
      nav: num(c[RANK_FIELDS.nav]),
      accNav: num(c[RANK_FIELDS.accNav]),
      d1: num(c[RANK_FIELDS.d1]),
      w1: num(c[RANK_FIELDS.w1]),
      m1: num(c[RANK_FIELDS.m1]),
      y1: num(c[RANK_FIELDS.y1]),
    }))
}

/**
 * 去掉 A/C/E/I 等份额分级造成的重复：同一只基金的 A、C 份额名字只差后缀。
 * 榜单里它们涨幅完全一样，不去重的话前几名会被同一只基金刷屏。
 */
export function dedupeShares(items) {
  const key = (name) => String(name || '').replace(/[\s]*[ACEIHO]\s*$/, '')
  // 份额分级在名字末尾（A/C），代码末位没有意义
  const isC = (name) => /[\s]*C$/.test(String(name || ''))
  const byKey = new Map()
  for (const it of items) {
    const k = key(it.name)
    const kept = byKey.get(k)
    if (!kept) {
      byKey.set(k, it)
      continue
    }
    // 两只都在时优先留 A 份额（更常见、费率一般更低）
    if (isC(kept.name) && !isC(it.name)) byKey.set(k, it)
  }
  return [...byKey.values()]
}

/**
 * 场外基金区间涨幅榜。`sort` 为 d1/w1/m1/y1。
 * sc=rzdf 只取「混合型」以外的常规基金，避免榜单被一堆 QDII/债基占满。
 */
export async function fundRank({ sort = 'd1', limit = 20 } = {}) {
  const sc = { d1: 'rzdf', w1: '1zzf', m1: '1yzf', y1: '1nzf' }[sort] || 'rzdf'
  const want = Math.min(60, Math.max(5, limit))
  const url =
    `${RANK_HOST}?op=ph&dt=kf&ft=all&rs=&gs=0&sc=${sc}&st=desc` +
    `&qdii=&tabSubtype=,,,,,&pi=1&pn=${want}&dx=1`
  const body = await cached(`fr:${sort}:${want}`, 10 * 60_000, () =>
    fetchText(url, {
      headers: { Referer: 'https://fund.eastmoney.com/data/fundranking.html' },
      timeout: 12_000,
    }),
  )
  const items = dedupeShares(parseFundRank(body)).slice(0, limit)
  if (!items.length) throw new Error('基金榜单暂不可用')
  return { sort, items }
}

/**
 * 按分类精选的代表性场外基金（每类 1~2 只），用来给「基金」页签一个稳定的落地面。
 * 代码是长期存在的宽基/行业/QDII/债券/黄金 ETF 联接，不随行情变动。
 */
export const FUND_PICKS = [
  {
    key: 'broad',
    label: '宽基指数',
    hint: '跟住大盘，长期定投的底仓',
    funds: [
      { code: '000961', name: '天弘沪深300ETF联接A' },
      { code: '001051', name: '华夏上证50ETF联接A' },
      { code: '003096', name: '中欧医疗健康混合A' },
    ],
  },
  {
    key: 'theme',
    label: '行业主题',
    hint: '单一赛道，波动更大',
    funds: [
      { code: '161725', name: '招商中证白酒指数A' },
      { code: '001631', name: '天弘食品饮料指数A' },
    ],
  },
  {
    key: 'qdii',
    label: '海外 / QDII',
    hint: '美股、港股与全球资产',
    funds: [
      { code: '270042', name: '广发纳斯达克100指数A' },
      { code: '000834', name: '大成纳斯达克100指数A' },
    ],
  },
  {
    key: 'bond',
    label: '债券固收',
    hint: '波动小，接近类固收',
    funds: [{ code: '000032', name: '易方达信用债债券A' }],
  },
  {
    key: 'gold',
    label: '商品 / 黄金',
    hint: '对冲货币与地缘风险',
    funds: [{ code: '000216', name: '华安黄金ETF联接A' }],
  },
]

/** 精选基金的实时净值；精选代码对不上时退回按代码查，尽量不空着。 */
export async function fundHot() {
  const wanted = FUND_PICKS.flatMap((g) => g.funds.map((f) => f.code))
  const quotes = await fundQuotes(wanted)
  const byCode = new Map(quotes.map((q) => [q.code, q]))
  return FUND_PICKS.map((g) => ({
    ...g,
    funds: g.funds.map((f) => {
      const q = byCode.get(f.code)
      return {
        code: f.code,
        name: q?.name || f.name,
        nav: q?.nav ?? null,
        accNav: q?.accNav ?? null,
        changePct: q?.changePct ?? null,
        date: q?.date ?? null,
      }
    }),
  }))
}
// ---- 净值曲线：主源 + 两个备用源 ----
// api.fund.eastmoney.com/f10/lsjz 限流很凶（返回 200 但 Data 为 null），
// 备用：同厂的移动端历史接口，再不行用新浪。三个源的字段名各不相同，各自单独解析。
const MOB_HIS = 'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNHisNetList'
const SINA_NAV = 'https://stock.finance.sina.com.cn/fundInfo/api/openapi.php/CaihuiFundInfoService.getNav'

/** 东财移动端历史净值：[{FSRQ, DWJZ, LJJZ, JZZZL}]，倒序。 */
export function parseFundNavMobile(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((r) => ({
      date: r.FSRQ,
      nav: num(r.DWJZ),
      accNav: num(r.LJJZ),
      changePct: num(r.JZZZL),
    }))
    .filter((p) => p.date && p.nav != null)
    .reverse()
}

/** 新浪历史净值：[{fbrq, jjjz, ljjz}]，倒序。新浪没有日涨跌，用前一日净值算。 */
export function parseFundNavSina(rows) {
  const points = (Array.isArray(rows) ? rows : [])
    .map((r) => ({
      date: String(r.fbrq || '').slice(0, 10),
      nav: num(r.jjjz),
      accNav: num(r.ljjz),
      changePct: null,
    }))
    .filter((p) => p.date && p.nav != null)
    .reverse()
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1].nav
    points[i].changePct = prev
      ? Number((((points[i].nav - prev) / prev) * 100).toFixed(2))
      : null
  }
  return points
}

function toSeries(code, points) {
  if (!points.length) return null
  const last = points[points.length - 1]
  return { code, nav: last.nav, accNav: last.accNav, changePct: last.changePct, points }
}

// 顺序按实测可靠性：移动端接口 honor pageSize 且不怎么限流；f10 每页只给 20 条
// 且频繁返回 Data=null；新浪最稳但字段少（无日涨跌，靠前一日净值补算）。
/** 净值曲线：东财移动端 → 东财 f10 → 新浪。 */
export async function fundNavSeries(code, { limit = 180 } = {}) {
  const size = Math.min(600, Math.max(20, limit))
  const errors = []
  const attempts = [
    {
      id: 'eastmoney',
      run: async () => {
        const json = await cached(`fnm:${code}:${size}`, 10 * 60_000, () =>
          fetchJson(
            `${MOB_HIS}?FCODE=${code}&pageIndex=1&pageSize=${size}` +
              '&deviceid=stock-web&plat=Android&appType=ttjj&product=EFund&Version=1' +
              '&Fields=FSRQ%2CDWJZ%2CLJJZ%2CJZZZL',
            { headers: { Referer: 'https://fund.eastmoney.com/' } },
          ),
        )
        return toSeries(code, parseFundNavMobile(json?.Datas))
      },
    },
    { id: 'eastmoney-f10', run: () => fundNav(code, { limit: size }) },
    {
      id: 'sina',
      run: async () => {
        const json = await cached(`fns:${code}:${size}`, 10 * 60_000, () =>
          fetchJson(`${SINA_NAV}?symbol=${code}&page=1&num=${size}`, {
            headers: { Referer: 'https://finance.sina.com.cn' },
          }),
        )
        return toSeries(code, parseFundNavSina(json?.result?.data?.data))
      },
    },
  ]
  for (const a of attempts) {
    try {
      const out = await a.run()
      if (out) return { ...out, source: a.id }
    } catch (err) {
      errors.push(`${a.id}：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  throw new Error(`净值暂不可用（${errors.join('；') || '各源均无数据'}）`)
}
