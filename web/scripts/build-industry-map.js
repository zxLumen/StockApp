// 一次性构建「个股 → 申万一级行业」本地映射（默认写 config/industry-map.json，随镜像发布）。
//
// 为什么需要它：B 链路选股要做行业分散，但逐只的东财 f127 接口不稳定（实测常返回 '?'），
// 当年正因如此把 maxPerIndustry 关成 99（结果确定、但等于不分散）。这里改用东财
// datacenter-web 的 F10「所属板块」报表，一次性把**全市场**的申万一级行业抓下来冻结成
// 静态表；选股只读本地表，不依赖网络、结果可复现（见 lib/industry.js）。
//
//   node scripts/build-industry-map.js [--out config/industry-map.json] [--sleep 800]
//
// 数据源：datacenter-web.eastmoney.com `RPT_F10_CORETHEME_BOARDTYPE`
//   filter = (BOARD_TYPE="行业")(BOARD_LEVEL="1")   → 每只票一行「申万一级行业」
// 为什么选申万一级而不是东财细分（f100）：细分行业太细（半导体 / 通用设备 / 其他电子 /
//   军工电子 / 通信设备 / 航空装备是 6 个不同行业，却同属 AI 硬件一个板块），只在细分上设
//   上限拦不住板块整体扎堆；一级大类才是「板块」粒度。
// 覆盖范围：data/kline-cache/universe-*.json 的并集（稳健池 + 成交额池）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DATA_DIR } from '../lib/scope.js'
import { fetchJson } from '../lib/http.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.join(HERE, '..')

const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf(n)
  return i >= 0 ? argv[i + 1] : d
}
const OUT = path.resolve(WEB, opt('--out', path.join('config', 'industry-map.json')))
const SLEEP = Math.max(0, Number(opt('--sleep', 800)))

const API = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
const FILTER = encodeURIComponent('(BOARD_TYPE="行业")(BOARD_LEVEL="1")')
const PAGE_SIZE = 500
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 读 kline-cache 下所有 universe-*.json，取（secid, code, name）并集。 */
async function loadUniverse() {
  const dir = path.join(DATA_DIR, 'kline-cache')
  const seen = new Map()
  for (const f of fs.readdirSync(dir).filter((x) => /^universe-.*\.json$/.test(x)).sort()) {
    let list
    try {
      list = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
    } catch {
      console.log(`[map] 跳过坏文件 ${f}`)
      continue
    }
    if (!Array.isArray(list)) continue
    for (const x of list) if (x?.code && !seen.has(x.code)) seen.set(x.code, x)
    console.log(`[map] ${f}: ${list.length} 只（累计 ${seen.size}）`)
  }
  return [...seen.values()]
}

/** 拉全市场「申万一级行业」表：`code(6位) → 行业名`。 */
async function fetchSw1() {
  const byCode = {}
  let page = 1
  let pages = 1
  do {
    const url =
      `${API}?reportName=RPT_F10_CORETHEME_BOARDTYPE&columns=SECUCODE,SECURITY_CODE,BOARD_NAME,BOARD_TYPE,BOARD_LEVEL` +
      `&filter=${FILTER}&pageSize=${PAGE_SIZE}&pageNumber=${page}&sortColumns=SECUCODE&sortTypes=1`
    const j = await fetchJson(url, { headers: { Referer: 'https://data.eastmoney.com/' }, timeout: 15000 })
    const data = j?.result?.data
    if (!Array.isArray(data)) throw new Error(`第 ${page} 页无数据：${JSON.stringify(j).slice(0, 120)}`)
    pages = j.result.pages || 1
    for (const r of data) {
      const code = String(r.SECURITY_CODE || String(r.SECUCODE || '').split('.')[0]).trim()
      const name = String(r.BOARD_NAME || '').trim()
      if (code && name) byCode[code] = name
    }
    console.log(`[map] 全市场一级行业 ${page}/${pages}（已 ${Object.keys(byCode).length} 只）`)
    page += 1
    await sleep(SLEEP)
  } while (page <= pages)
  return byCode
}

async function main() {
  const uni = await loadUniverse()
  console.log(`[map] 目标 ${uni.length} 只 → ${OUT}`)

  const byCode = await fetchSw1()
  const industries = {}
  const missing = []
  for (const x of uni) {
    if (byCode[x.code]) industries[x.secid] = byCode[x.code]
    else missing.push(`${x.code}(${x.name || ''})`)
  }

  const sorted = Object.fromEntries(Object.keys(industries).sort().map((k) => [k, industries[k]]))
  const count = {}
  for (const v of Object.values(sorted)) count[v] = (count[v] || 0) + 1
  const top = Object.entries(count).sort((a, b) => b[1] - a[1])

  const payload = {
    _note:
      '个股→申万一级行业静态映射；由 scripts/build-industry-map.js 生成。选股行业分散用（离线可复现，不依赖逐只 f127）。',
    generatedAt: new Date().toISOString(),
    source: 'datacenter-web.eastmoney.com RPT_F10_CORETHEME_BOARDTYPE (BOARD_TYPE=行业, BOARD_LEVEL=1)',
    level: 'sw1',
    total: Object.keys(sorted).length,
    industries: sorted,
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`)

  console.log(`[map] 已写 ${OUT}：覆盖 ${payload.total}/${uni.length} 只，行业 ${top.length} 个`)
  console.log(`[map] 分布：${top.map(([k, v]) => `${k}×${v}`).join('  ')}`)
  if (missing.length) console.log(`[map] 未覆盖 ${missing.length} 只：${missing.slice(0, 30).join(',')}${missing.length > 30 ? '…' : ''}`)
}

main().catch((err) => {
  console.error('[map] 失败：', err)
  process.exit(1)
})