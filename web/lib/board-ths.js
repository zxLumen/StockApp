import path from 'node:path'
import { fetchGbk, fetchJsonp, cached } from './http.js'
import { withMa, withDerived } from './eastmoney.js'
import { readJsonWithBak, writeJson } from './store.js'

// 同花顺板块：目前**唯一同时覆盖行业 + 概念**且能拿到 K 线的源（东财 90.BK* 按 IP 掐连接）。
//
// 三个端点都是公开页面 / JSONP，不需要 cookie，也不需要算 hexin-v：
//   列表  https://q.10jqka.com.cn/thshy/   （GBK，表格 50 行 + A~Z 侧栏补齐到 90 个行业）
//         .../thshy/index/field/199112/order/desc/page/2/ajax/1/  （列表第 2 页：补齐那 40 个
//            行业首页表格没给的涨跌家数 / 领涨股。**只有列表的 ajax 是通的**）
//         https://q.10jqka.com.cn/gn/      （GBK，内嵌 input#gnSection，一次给全 293 个概念；
//            概念列表分页无效，涨跌家数 / 领涨股拿不到，只有净流入）
//   K 线  https://d.10jqka.com.cn/v6/line/bk_<platecode>/<01|11|21>/{last|YYYY}.js
//   成分股 同花顺的板块详情页**成分股只内联在「cid 页」**，platecode 页恒为 0 条：
//         行业 /thshy/detail/code/<platecode>/   → 首页内联约 20 条
//         概念 /gn/detail/code/<cid>/           → 首页内联约 13~30 条（cid 来自 gnSection）
//         两者的分片 ajax（.../page/N/ajax/1/）都被 Nginx 403 / 401 挡死，所以只能取首页。
//
// secid 沿用市场里 board 的 `90.` 前缀：marketOf('90.x') === 'board'，不用改路由正则。
//   90.881121  行业（881xxx）
//   90.885333  概念（885xxx）
// 东财自己的板块也是 `90.BK0475` 这种，两者靠「代码段是不是 6 位纯数字」区分。

const Q_HOST = 'https://q.10jqka.com.cn'
const LINE_HOST = 'https://d.10jqka.com.cn/v6/line'
const INDUSTRY_LIST = `${Q_HOST}/thshy/`
/** 行业列表第 2 页：首页表格只渲染前 50 行，剩下 40 个要靠这个 ajax 分页才有统计字段。 */
const INDUSTRY_LIST_PAGE2 = `${Q_HOST}/thshy/index/field/199112/order/desc/page/2/ajax/1/`
const CONCEPT_LIST = `${Q_HOST}/gn/`
const HDRS = { Referer: `${Q_HOST}/` }

/** 同花顺周期码：日 / 周 / 月。 */
const PERIOD_CODE = { d: '01', w: '11', m: '21' }

const INDUSTRY_CODE = /^881\d{3}$/
/** 概念：885xxx（218 个）与 886xxx（75 个）两种前缀，gnSection 里两种都有。 */
const CONCEPT_CODE = /^88[56]\d{3}$/

const CACHE_FILE = path.join(
  process.env.STOCK_DATA_DIR || path.join(process.cwd(), 'data'),
  'cache',
  'board-ths-index.json',
)

const num = (v) => {
  if (v == null) return null
  const s = String(v).replace(/[,%\s]/g, '')
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** `<td>` 纯文本。 */
function tdText(row, idx) {
  const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
  const cell = cells[idx]
  if (!cell) return ''
  return cell[1]
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim()
}

/** 一行里第 idx 个 `<td>` 的链接（取 href 里的 6 位代码）。 */
function tdCode(row, idx) {
  const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
  const cell = cells[idx]
  const m = cell ? /stockpage\.10jqka\.com\.cn\/(\d{6})/.exec(cell[1]) : null
  return m ? m[1] : null
}

/**
 * 行业列表页解析。
 *
 * 表头（实测）：序号|板块|涨跌幅(%)|总成交量(万手)|总成交额(亿元)|净流入(亿元)|
 *              上涨家数|下跌家数|均价|领涨股|最新价|涨跌幅(%)
 * 表格只渲染 50 行，剩下 40 个在 A~Z 侧栏里（只有代码 + 名称），所以两边合并、
 * 侧栏独有的条目其余字段留 null（K 线仍可取，页面按缺字段渲染）。
 */
export function parseThsIndustryList(html) {
  const text = String(html || '')
  const out = new Map()

  for (const m of text.matchAll(/<tr[^>]*>([\s\S]{0,1200}?)<\/tr>/g)) {
    const row = m[1]
    if (!/detail\/code\/881\d{3}/.test(row)) continue
    const name = tdText(row, 1)
    const codeM = /detail\/code\/(881\d{3})/.exec(row)
    if (!codeM || !name) continue
    out.set(codeM[1], {
      code: codeM[1],
      name,
      changePct: num(tdText(row, 2)),
      volume: num(tdText(row, 3)),
      amount: num(tdText(row, 4)),
      netInflow: num(tdText(row, 5)),
      up: num(tdText(row, 6)),
      down: num(tdText(row, 7)),
      avgPrice: num(tdText(row, 8)),
      leader: tdText(row, 9) || null,
      leaderCode: tdCode(row, 9),
      leaderPrice: num(tdText(row, 10)),
      leaderPct: num(tdText(row, 11)),
    })
  }

  // A~Z 侧栏补齐表格没有的
  for (const m of text.matchAll(/detail\/code\/(881\d{3})\/?['"]?[^>]*>\s*([^<]{1,20}?)\s*</g)) {
    const code = m[1]
    const name = m[2].trim()
    if (!name || out.has(code)) continue
    out.set(code, {
      code,
      name,
      changePct: null,
      volume: null,
      amount: null,
      netInflow: null,
      up: null,
      down: null,
      avgPrice: null,
      leader: null,
      leaderCode: null,
      leaderPrice: null,
      leaderPct: null,
    })
  }

  return [...out.values()]
}

/**
 * 概念列表页解析：内嵌 `<input id="gnSection" value='{...}'>`，一次给全 293 个。
 * 每项：platecode(885xxx，K 线用) / platename / cid(30xxxx，**成分股页用**) /
 *       199112(涨跌幅%) / zjjlr(主力净流入) / zfl。
 */
export function parseThsConceptList(html) {
  const text = String(html || '')
  const m = /id="gnSection"[^>]*value='([^']+)'/.exec(text)
  if (!m) return []
  let raw
  try {
    raw = JSON.parse(m[1])
  } catch {
    return []
  }
  const out = []
  const seen = new Set()
  for (const x of Object.values(raw || {})) {
    const code = String(x?.platecode || '')
    const name = String(x?.platename || '').trim()
    if (!CONCEPT_CODE.test(code) || !name || seen.has(code)) continue
    seen.add(code)
    out.push({
      code,
      name,
      cid: String(x?.cid || '') || null,
      changePct: num(x['199112']),
      netInflow: num(x?.zjjlr),
      up: null,
      down: null,
      volume: null,
      amount: null,
      leader: null,
      leaderCode: null,
      leaderPct: null,
    })
  }
  return out
}

/** 统一成前端板块榜的结构，并补上 secid。 */
function toBoardItem(x, kind) {
  return {
    code: x.code,
    secid: `90.${x.code}`,
    kind,
    name: x.name,
    index: null,
    changePct: x.changePct ?? null,
    up: x.up ?? null,
    down: x.down ?? null,
    volume: x.volume ?? null,
    amount: x.amount ?? null,
    netInflow: x.netInflow ?? null,
    leader: x.leader ?? null,
    leaderCode: x.leaderCode ?? null,
    leaderPct: x.leaderPct ?? null,
    // 概念成分股页要用 cid，列表里带着走
    ...(kind === 'concept' ? { cid: x.cid || null } : {}),
  }
}

/**
 * 板块全量索引。内存 30 分钟 + 磁盘快照（上游改版/抽风时不至于整页空白）。
 * 行业 ~90 个、概念 ~293 个，搜索直接在这份全量上做，不需要分页。
 *
 * 行业列表分两页：`thshy/` 首页表格只给前 50 个的涨跌家数 / 领涨股，另外 40 个
 * 只出现在侧边分类里（纯代码+名称）。但 `/thshy/index/field/.../page/2/ajax/1/`
 * 这个 ajax 分页是通的，把缺的 40 条补齐 —— 注意只有**列表**的 ajax 通，
 * 详情页的成分股 ajax（`/thshy/detail/.../ajax/1/`、`/gn/detail/.../ajax/1/`）一律 401。
 */
export async function thsBoardIndex(kind = 'industry') {
  const k = kind === 'concept' ? 'concept' : 'industry'
  const url = k === 'concept' ? CONCEPT_LIST : INDUSTRY_LIST
  const fetchOne = async () => {
    const html = await cached(`thsidx:${k}`, 30 * 60_000, () => fetchGbk(url, { headers: HDRS }))
    let items = k === 'concept' ? parseThsConceptList(html) : parseThsIndustryList(html)
    if (!items.length) throw new Error('同花顺板块列表为空')
    if (k === 'industry') items = await mergeIndustryPage2(items)
    const shaped = items.map((x) => toBoardItem(x, k))
    // 列表是「尽力而为」的：ajax 第 2 页被限流就只剩 50 个行业有涨跌家数。
    // 快照要**单调变好** —— 用新数据填空，但别把旧快照里更全的统计值抹掉，
    // 否则限流一次就把磁盘上的 90 条富数据降级成 50 条，下次还得重新抓。
    await mergeSnapshot(k, shaped)
    return shaped
  }
  try {
    return await fetchOne()
  } catch {
    const snap = await readSnapshot(k)
    if (snap?.length) return snap
    throw new Error('同花顺板块列表暂不可用')
  }
}

/**
 * 用 ajax 第 2 页补齐首页表格漏掉的行业（按 code 覆盖，首页已有的字段不动）。
 *
 * 这个 ajax 会间歇性 401（同花顺按请求频率掐）。`cached()` 不缓存失败，所以这里
 * 自己记一个冷却窗口 —— 不加的话每次 `/api/market/board` 都会重试一遍，
 * 被掐狠了连首页列表 / K 线 / 成分股一起完蛋。冷却 10 分钟，够它恢复又不至于刷屏。
 */
let industryPage2CooldownUntil = 0
const PAGE2_COOLDOWN_MS = 10 * 60_000

async function mergeIndustryPage2(items) {
  const missing = items.filter((x) => x.up == null).length
  if (!missing) return items
  if (Date.now() < industryPage2CooldownUntil) return items
  try {
    const html = await cached('thsidx:industry:p2', 30 * 60_000, () =>
      fetchGbk(INDUSTRY_LIST_PAGE2, { headers: HDRS }),
    )
    const page2 = parseThsIndustryList(html)
    if (!page2.length) {
      industryPage2CooldownUntil = Date.now() + PAGE2_COOLDOWN_MS
      return items
    }
    const byCode = new Map(page2.map((x) => [x.code, x]))
    let filled = 0
    for (const x of items) {
      if (x.up != null) continue
      const hit = byCode.get(x.code)
      if (!hit || hit.up == null) continue
      for (const f of STAT_FIELDS) if (x[f] == null) x[f] = hit[f] ?? null
      filled += 1
    }
    if (filled === missing) industryPage2CooldownUntil = 0
    else industryPage2CooldownUntil = Date.now() + PAGE2_COOLDOWN_MS
    return items
  } catch {
    industryPage2CooldownUntil = Date.now() + PAGE2_COOLDOWN_MS
    return items
  }
}

async function readSnapshot(kind) {
  const all = await readJsonWithBak(CACHE_FILE, null)
  if (!all || typeof all !== 'object') return null
  return Array.isArray(all[kind]) ? all[kind] : null
}

async function readSnapshotAll() {
  return readJsonWithBak(CACHE_FILE, null)
}

/** 落盘快照（成功抓取后调用；失败不影响返回）。 */
async function saveSnapshot(kind, items) {
  try {
    const all = (await readSnapshotAll()) || {}
    all[kind] = items
    all.savedAt = new Date().toISOString()
    await writeJson(CACHE_FILE, all)
  } catch {
    /* 只读文件系统时降级为纯内存缓存 */
  }
}

/**
 * 写快照前先和旧快照合并：新条目补进缺的位置，统计字段取「新旧谁更全」——
 * 旧的有 `up` 就保留旧的，否则用新的。板块增删要以新列表为准（不然新板块永远进不来）。
 */
async function mergeSnapshot(kind, items) {
  try {
    const prev = await readSnapshot(kind)
    if (prev?.length) {
      const byCode = new Map(prev.map((x) => [x.code, x]))
      for (const x of items) {
        const old = byCode.get(x.code)
        if (!old) continue
        for (const f of STAT_FIELDS) {
          if (x[f] == null && old[f] != null) x[f] = old[f]
        }
        // 名称以新为准，但旧快照给过 cid 就别弄丢
        if (!x.cid && old.cid) x.cid = old.cid
      }
    }
  } catch {
    /* 读不到旧快照就直接覆盖 */
  }
  await saveSnapshot(kind, items)
}

/** 会随「有没有限流」时有时无的统计字段。 */
const STAT_FIELDS = [
  'changePct', 'up', 'down', 'volume', 'amount', 'netInflow',
  'leader', 'leaderCode', 'leaderPct',
]

/** 板块搜索：全量索引上做「代码前缀 / 名称包含 / 去后缀包含」。 */
export function matchBoards(list, q, { limit = 20 } = {}) {
  const query = String(q || '').trim()
  if (!query) return []
  const lower = query.toLowerCase()
  const scored = []
  for (const x of list) {
    const name = String(x.name || '')
    let score = -1
    if (x.code === query) score = 0
    else if (String(x.code).startsWith(query)) score = 1
    else if (name === query) score = 2
    else if (name.startsWith(query)) score = 3
    else if (name.includes(query)) score = 4
    else if (name.toLowerCase().includes(lower)) score = 5
    else {
      // 「行业」「概念」「板块」等后缀对搜索没帮助
      const bare = name.replace(/(行业|概念|板块|指数)$/g, '')
      if (bare && (bare.includes(query) || bare.toLowerCase().includes(lower))) score = 6
    }
    if (score >= 0) scored.push({ x, score })
  }
  return scored
    .sort((a, b) => a.score - b.score || (b.x.changePct ?? -99) - (a.x.changePct ?? -99))
    .slice(0, limit)
    .map((s) => s.x)
}

/**
 * 按 code 找板块（板块详情页要拿涨跌家数 / 领涨股 / cid，列表已经落盘，这里纯内存）。
 * `kind` 传 'all'（默认）时行业 + 概念一起找 —— 881/885/886 前缀不会撞。
 */
export async function thsBoardByCode(code, kind = 'all') {
  const want = String(code || '').trim()
  if (!want) return null
  const kinds = kind === 'all' ? ['industry', 'concept'] : [kind]
  for (const k of kinds) {
    const list = await thsBoardIndex(k)
    const hit = list.find((x) => x.code === want)
    if (hit) return hit
  }
  return null
}

export async function searchThsBoards(q, { kind = '', limit = 20 } = {}) {
  const kinds = kind ? [kind] : ['industry', 'concept']
  const out = []
  for (const k of kinds) {
    const list = await thsBoardIndex(k)
    out.push(...matchBoards(list, q, { limit }))
  }
  return out.slice(0, limit)
}

// ---- K 线 ----

/** `20250102,open,high,low,close,volume,amount,,,,0` → bar。 */
function parseThsBars(csv) {
  const out = []
  for (const line of String(csv || '').split(';')) {
    const c = line.split(',')
    if (c.length < 7) continue
    const time = String(c[0] || '').trim()
    if (!/^\d{8}$/.test(time)) continue
    const bar = {
      time: `${time.slice(0, 4)}-${time.slice(4, 6)}-${time.slice(6, 8)}`,
      open: num(c[1]),
      high: num(c[2]),
      low: num(c[3]),
      close: num(c[4]),
      volume: num(c[5]),
      amount: num(c[6]),
      amplitude: null,
      changePct: null,
      change: null,
      turnover: null,
    }
    if (bar.close == null) continue
    out.push(bar)
  }
  return out
}

const lineUrl = (code, period, file) => `${LINE_HOST}/bk_${code}/${PERIOD_CODE[period]}/${file}.js`

/**
 * 板块 K 线。`last.js` 给最近 140 根 + 名称 + 各年根数；不够时用 `YYYY.js` 从最近的
 * 年份往前回补（只补日线，周/月线的年文件没验证过，缺了就返回已有的）。
 */
export async function thsBoardKline(platecode, { period = 'd', limit = 240 } = {}) {
  const code = String(platecode || '').trim()
  if (!INDUSTRY_CODE.test(code) && !CONCEPT_CODE.test(code)) throw new Error('非同花顺板块代码')
  const p = PERIOD_CODE[period] ? period : 'd'
  const want = Math.min(600, Math.max(20, limit))

  const head = await cached(`thsk:${code}:${p}:last`, 10 * 60_000, () =>
    fetchJsonp(lineUrl(code, p, 'last')),
  )
  const recent = parseThsBars(head?.data)
  if (!recent.length) throw new Error('同花顺板块无 K 线数据')

  // 用 map 累计：last.js 的 140 根与当年年文件是重叠的，按数组长度判「够了」会提前收手
  // （半导体 limit=240 时 2026 一叠加就 break，实际只回补到 181 根）。
  const byTime = new Map()
  for (const b of recent) byTime.set(b.time, b)

  if (byTime.size < want) {
    const years = Object.entries(head?.year || {})
      .filter(([, n]) => Number(n) > 0)
      .map(([y]) => y)
      .sort((a, b) => Number(b) - Number(a))
    for (const y of years) {
      if (byTime.size >= want) break
      let file
      try {
        file = await cached(`thsk:${code}:${p}:${y}`, 30 * 60_000, () =>
          fetchJsonp(lineUrl(code, p, y)),
        )
      } catch {
        continue
      }
      for (const b of parseThsBars(file?.data)) byTime.set(b.time, b)
    }
  }

  const merged = [...byTime.values()]
    .sort((a, b) => a.time.localeCompare(b.time))
    .slice(-want)

  return {
    secid: `90.${code}`,
    code,
    market: 'board',
    name: head?.name || null,
    bars: withDerived(withMa(merged)),
  }
}

// ---- 成分股 ----

/** 6 位代码 → 市场前缀。沪 60/68/90 → 1，其余（00/30/20/8/4）→ 0。 */
export function thsCodeToSecid(code) {
  const c = String(code || '').trim()
  if (!/^\d{6}$/.test(c)) return null
  return `${/^(60|68|90)/.test(c) ? 1 : 0}.${c}`
}

/**
 * 板块详情页的成分股。页面里有**两套 markup**，两套都要吃，否则会漏掉一大半：
 *
 * 1) 主表 `<tr>`：序号|代码|名称|最新价|涨跌幅(%)|涨跌额|…（行业页只有这一套）
 * 2) 子行业分组表 `table.series-table`：概念的成员按子行业分组（零部件 / 整机 / … / 其他），
 *    条目是 `<a class="label label-s"><p class="title">名称</p><p class="data">+8.70% +0.25</p>`，
 *    **只有名称 + 涨跌幅 + 涨跌额，没有最新价**。
 *
 * 概念页两者相加才是完整首页成员（实测 10 + 20 = 30）。
 */
export function parseThsMembers(html) {
  const text = String(html || '')
  const out = []
  const seen = new Set()

  const clean = (s) =>
    String(s || '')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .trim()

  const push = (code, name, price, changePct, change) => {
    if (seen.has(code)) return
    const secid = thsCodeToSecid(code)
    if (!secid) return
    // 名称不能是纯数字（否则多半是抓到错位的单元格）
    if (!name || /^\d+$/.test(name)) return
    seen.add(code)
    out.push({ secid, code, name, price: num(price), changePct: num(changePct), change: num(change) })
  }

  for (const m of text.matchAll(/<tr[^>]*>([\s\S]{0,1200}?)<\/tr>/g)) {
    const row = m[1]
    const link = /stockpage\.10jqka\.com\.cn\/(\d{6})"/.exec(row)
    if (!link) continue
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => clean(c[1]))
    const at = cells.indexOf(link[1])
    if (at < 0) continue
    push(link[1], cells[at + 1], cells[at + 2], cells[at + 3], cells[at + 4])
  }

  // 分组表条目的 `<p class="data">` 有重复嵌套（`<p class="data><p class="data>…`），
  // 所以不在正则里硬拼结构，先截一段窗口再从文本里挑数字。
  // 注意 class 可能是 `label label-s` 也可能是 `label label-s hide`（隐藏股），所以不能写死。
  // 窗口里只有涨跌幅是可信的：第二个数字（实测 +27.06 / +33.33，中航光电价约 40）不是涨跌额，
  // 是别的口径，所以 change 一律留 null，最新价这组根本不提供。
  const seriesRe =
    /stockpage\.10jqka\.com\.cn\/(\d{6})\/?"[^>]*class="label label-s[^"]*"[^>]*>\s*<p class="title">([^<]{1,20}?)<\/p>([\s\S]{0,200}?)<\/p>/g
  for (const m of text.matchAll(seriesRe)) {
    const pct = /([+-]?[\d.]+)%/.exec(clean(m[3]))
    if (!pct) continue
    push(m[1], clean(m[2]), null, pct[1], null)
  }

  return out
}

/**
 * 板块成分股。`board` 需要 `{ kind, code }`，概念还要带 `cid`
 * （**概念必须用 cid 页**，platecode 页恒为 0 条成员）。
 * 同花顺只内联首页，分片 ajax 被 Nginx 挡死，所以这里最多约 20~30 条。
 */
export async function thsBoardMembers(board = {}, { limit = 30 } = {}) {
  const kind = board.kind === 'concept' ? 'concept' : 'industry'
  const code = String(board.code || '').trim()
  const n = Math.min(50, Math.max(5, limit))
  let url
  if (kind === 'concept') {
    let cid = String(board.cid || '').trim()
    if (!cid && CONCEPT_CODE.test(code)) {
      const list = await thsBoardIndex('concept')
      cid = String(list.find((x) => x.code === code)?.cid || '')
    }
    if (!/^\d{6}$/.test(cid)) return []
    url = `${Q_HOST}/gn/detail/code/${cid}/`
  } else {
    if (!INDUSTRY_CODE.test(code)) return []
    url = `${Q_HOST}/thshy/detail/code/${code}/`
  }
  const html = await cached(`thsm:${url}`, 10 * 60_000, () => fetchGbk(url, { headers: HDRS }))
  return parseThsMembers(html).slice(0, n)
}
