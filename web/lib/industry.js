// 个股行业 + 「一级大类」归并。
//
// 行业来源优先级：
//   1. 本地冻结映射 `config/industry-map.json`（`scripts/build-industry-map.js` 生成，随镜像发布）
//   2. 东财逐只 f127（不稳定，实测常返回 '?'，仅作兜底）
//   3. '?'（缺失）
//
// 为什么本地优先：行业分散是选股的硬约束，结果必须**离线可复现**。历史上逐只 f127 经常
// 取不到，一取不到行业就全落进 '?' 同一个桶，分散约束失效/抽风 —— 这正是当年把
// `maxPerIndustry` 关成 99 的原因。冻结映射后选股不再依赖网络。
//
// 为什么还要归并「大类」：东财行业太细（半导体 / 通用设备 / 其他电子 / 军工电子 / 通信设备 /
// 航空装备是 6 个不同行业，却同属一个 AI 硬件板块）。只在细分行业上设上限拦不住板块整体扎堆，
// 所以上限作用在 `coarseSector()` 归并出的大类上；细分行业仍原样保留在结果里。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cached } from './http.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MAP_PATH =
  process.env.RECOMMEND_INDUSTRY_MAP || path.join(HERE, '..', 'config', 'industry-map.json')

let MAP = null
function mapOf() {
  if (MAP) return MAP
  try {
    MAP = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'))?.industries || {}
  } catch {
    MAP = {} // 没构建过映射文件：退化为旧行为（f127 / '?'）
  }
  return MAP
}

/** 本地冻结映射覆盖的股票数（诊断/日志用）。 */
export const industryMapSize = () => Object.keys(mapOf()).length

const industryCache = new Map()

/** 个股所属东财行业（细分）。`deps.industry` 用于测试/回测注入。 */
export async function industryOf(secid, deps = {}) {
  if (deps.industry) return deps.industry(secid)
  const hit = mapOf()[secid]
  if (hit) return hit
  if (industryCache.has(secid)) return industryCache.get(secid)
  try {
    const json = await cached(`ind:${secid}`, 24 * 60 * 60_000, () =>
      fetch(`https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f127`, {
        headers: { Referer: 'https://quote.eastmoney.com/' },
      }).then((r) => r.json()),
    )
    const v = json?.data?.f127 || '?'
    industryCache.set(secid, v)
    return v
  } catch {
    return '?'
  }
}

// 申万一级行业（与 config/industry-map.json 同一口径）：本地映射里就是这些名字，
// `coarseSector` 直接原样返回。
export const SW1 = new Set([
  '机械设备', '电子', '医药生物', '基础化工', '电力设备', '计算机', '汽车', '轻工制造',
  '建筑装饰', '有色金属', '公用事业', '国防军工', '环保', '交通运输', '通信', '食品饮料',
  '传媒', '农林牧渔', '纺织服饰', '家用电器', '房地产', '商贸零售', '社会服务', '非银金融',
  '建筑材料', '石油石化', '钢铁', '银行', '煤炭', '美容护理', '综合',
])

// 东财细分行业（f127 / f100）→ 申万一级。**顺序敏感**：越具体、越容易误伤的规则放前面
// （例：「军工电子」必须在「电子」之前，「化学制药」必须在「基础化工」之前，
//   「互联网电商」必须在「互联网」之前，「建筑装饰」不能写成裸「建筑」否则会吃掉「建筑材料」）。
// 未命中的行业名**原样各自成类**（不合并），即上限永不误伤未知行业。
const SECTOR_RULES = [
  [/化学制药|中药|生物制品|医药商业|医疗器械|医疗服务|生物医药|制药|原料药|疫苗/, '医药生物'],
  [/军工|国防|航空装备|航天装备|航天航空|兵装|船舶|兵器/, '国防军工'],
  [/半导体|消费电子|电子元件|元件|光学光电子|其他电子|电子化学品|集成电路|面板|PCB|数字芯片|模拟芯片|分立器件/, '电子'],
  [/互联网电商|电子商务|商业百货|贸易|零售|专业连锁|商贸/, '商贸零售'],
  [/软件开发|互联网|IT服务|计算机设备|计算机|信息技术|云服务/, '计算机'],
  [/通信设备|通信服务|通信/, '通信'],
  [/游戏|文化传媒|传媒|影视|广告|出版|数字媒体/, '传媒'],
  [/电池|光伏|风电|电网|电源设备|电机|储能|电力设备|新能源|逆变器/, '电力设备'],
  [/通用设备|专用设备|工程机械|仪器仪表|自动化设备|机床|机械|工业母机|轨交设备/, '机械设备'],
  [/汽车|摩托车|轮胎|乘用车|商用车/, '汽车'],
  [/食品|饮料|酿酒|酒类|乳品|调味|休闲食品/, '食品饮料'],
  [/家电|家用电器|白色家电|小家电/, '家用电器'],
  [/纺织|服装|家纺|珠宝首饰|饰品|鞋帽/, '纺织服饰'],
  [/美容|化妆品|个护/, '美容护理'],
  [/造纸|包装|轻工|家居|文娱用品|文教|家具/, '轻工制造'],
  [/旅游|酒店|餐饮|教育|专业服务|人力资源|体育|景区/, '社会服务'],
  [/银行/, '银行'],
  [/保险|证券|多元金融|非银金融|信托|期货/, '非银金融'],
  [/房地产|住宅开发/, '房地产'],
  [/建筑装饰|装修|工程建设|工程咨询|园林工程|基础建设|房屋建设/, '建筑装饰'],
  [/建筑材料|水泥|玻璃玻纤|非金属材料|管材/, '建筑材料'],
  [/化工|化学原料|化学制品|化纤|塑料|橡胶|农药|兽药|涂料|颜料|日用化学/, '基础化工'],
  [/有色|贵金属|小金属|能源金属|金属新材料|稀土|工业金属|黄金/, '有色金属'],
  [/石油|油气|炼化|油服/, '石油石化'],
  [/煤炭/, '煤炭'],
  [/钢铁/, '钢铁'],
  [/电力行业|电力|燃气|水务|公用事业|供热/, '公用事业'],
  [/环保/, '环保'],
  [/铁路公路|物流|航运|港口|航空机场|高速公路|快递|交通运输/, '交通运输'],
  [/农牧饲渔|农业|种植|养殖|饲料|种业|农产品|渔业|林业/, '农林牧渔'],
  [/综合/, '综合'],
]

/**
 * 任意行业名 → 「一级大类」（申万一级口径）。本地映射里的名字已是申万一级，原样返回；
 * f127 等来源的细分行业按规则归并；未命中返回原名（各自成类，不会被上限误合并）。
 * @param {string} industry
 */
export function coarseSector(industry) {
  const name = String(industry || '').trim()
  if (!name || name === '?') return '?'
  if (SW1.has(name)) return name
  for (const [re, sector] of SECTOR_RULES) {
    if (re.test(name)) return sector
  }
  return name
}