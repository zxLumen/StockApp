import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { streamChat } from './llm.js'
import { stockNews } from './news.js'
import { sinaKline } from './sina.js'
import { getQuotes } from './market.js'
import { cached } from './http.js'
import { readJson, writeJson } from './store.js'
import { aSharePool, objectiveFilter, mapLimit, monthChangeFromBars, ma20Deviation, stablePool, OBJECTIVE } from './rank.js'
import { computeFactors, compositeScores, regimeTilt } from './factors.js'
import { financeFactors } from './finance.js'
import { cachedKline } from './kline-cache.js'
import { tiltThreshold, selectConfig } from './model-config.js'
import { nextTradingDay, addTradingDays } from './trading-days.js'

export { nextTradingDay }

// 策略参数来自可训练配置（web/config/model.json）；代码不写死。
const SEL = selectConfig()

// 每日推荐：稳健池（沪深300+创业板+科创板）→ 客观初筛 → **多因子选股**（低波 + 短期
// 反转 + 贴近 MA20，全部只用截至当日日K，无未来数据）→ AI 逐只解读出 buyScore /
// holdDays / 摘要。产物落 DATA_DIR/recommend/<date>.json，前端「推荐」页签直接读。
// 旧链路（AI 初筛 + 买入评分）保留在 selectMode='ai'（`scripts/recommend.js --strategy ai`）。

const fmt = (n, d = 2) =>
  n == null || Number.isNaN(Number(n)) ? 'NA' : Number(n).toFixed(d)

/** 持仓周期：**不锁档位** —— 由模型按个股自由决定交易日数；这里只做异常值兜底。
 *  上下限仅为挡住荒谬值（0/负数/上千天），**不是"档位"**（历史曾锁 3/5/10/20，已废弃）。 */
export const HOLD_DAYS_MIN = 1
export const HOLD_DAYS_MAX = 60
/** 模型未产出/解析失败时的兜底周期（仅兜底，非"决定"）。 */
export const HOLD_DAYS_FALLBACK = 5
export function normalizeHoldDays(v, fallback = HOLD_DAYS_FALLBACK) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(HOLD_DAYS_MAX, Math.max(HOLD_DAYS_MIN, n))
}

const yi = (n) => (n == null || Number.isNaN(Number(n)) ? 'NA' : `${(Number(n) / 1e8).toFixed(2)} 亿`)

/** 北京时间当天 YYYY-MM-DD。 */
export function bjDate(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
}

/**
 * 宽松解析模型输出里的 JSON：去掉 ``` 代码块围栏，再截取第一个 `{` 到最后一个 `}`。
 * 模型常爱加一句「好的，以下是…」，不能只看整段是否合法 JSON。
 */
export function parseJsonLoose(text) {
  const s = String(text || '')
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s)
  const body = fenced ? fenced[1] : s
  const start = body.indexOf('{')
  if (start < 0) return null
  const end = body.lastIndexOf('}')
  if (end > start) {
    try {
      return JSON.parse(body.slice(start, end + 1))
    } catch {
      /* 落下去修复被截断的 JSON */
    }
  }
  // 修复被截断的 JSON：某些 OpenAI 兼容端点会在 ~100 字处直接砍断流，末尾的
  // `"]}` 没了。做法是补齐未闭合的字符串与括号，再 parse（见 repairTruncatedJson）。
  return repairTruncatedJson(body.slice(start))
}

/**
 * 修补被截断的 JSON 前缀。只做保守处理：补上未闭合的字符串引号，再按栈补齐
 * `}` / `]`。修不好就返回 null（不猜内容）。
 */
export function repairTruncatedJson(s) {
  let str = String(s || '').trim()
  // 去掉以逗号/冒号结尾的残缺尾巴，避免补出非法结构
  str = str.replace(/[,:]\s*$/, '')
  // 逐字符扫描，记录是否处于字符串中以及括号栈
  let inStr = false
  let esc = false
  const stack = []
  for (const ch of str) {
    if (esc) {
      esc = false
      continue
    }
    if (ch === '\\') {
      esc = true
      continue
    }
    if (ch === '"') inStr = !inStr
    else if (!inStr && (ch === '{' || ch === '[')) stack.push(ch)
    else if (!inStr && (ch === '}' || ch === ']')) stack.pop()
  }
  if (inStr) str += '"'
  // 反过来闭合栈
  for (let i = stack.length - 1; i >= 0; i -= 1) str += stack[i] === '{' ? '}' : ']'
  try {
    return JSON.parse(str)
  } catch {
    return null
  }
}

/**
 * 单只标的的解读上下文（行情 + 均线 + 资讯标题）。
 *
 * `deps` 用于**回测**注入历史数据（默认走实时源，行为不变）：
 *   - `deps.kline(secid)` → 返回 bars（回测时已截断到历史日）
 *   - `deps.news(stock)`  → 返回 { items }（回测时只给 ≤ 历史日的资讯）
 * 传了 deps 就不再用 `sinaKline` / `stockNews`。
 */
export async function stockContext(stock, deps = {}) {
  const klineP = deps.kline
    ? Promise.resolve(deps.kline(stock)).catch(() => null)
    : sinaKline(stock.secid, { period: 'd', limit: 70 }).catch(() => null)
  const newsP = deps.news
    ? Promise.resolve(deps.news(stock)).catch(() => ({ items: [] }))
    : stockNews([stock.name, stock.code].filter(Boolean), { limit: 8, scope: 'cn' }).catch(() => ({ items: [] }))
  const [kline, news] = await Promise.all([klineP, newsP])
  const bars = kline?.bars || []
  const closes = bars.map((b) => b.close).filter((v) => v != null)
  const last = bars[bars.length - 1] || {}
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null)
  // 位置指标（回测时也是截断后的，无未来数据）：距 MA20 偏离 + 近5日涨幅
  const dev = ma20Deviation(bars)
  const c5 = bars.length >= 6 ? bars[bars.length - 6]?.close : null
  const chg5 = c5 && last.close != null ? ((last.close / c5 - 1) * 100).toFixed(2) : null
  const lines = [
    `标的：${stock.name}（${stock.code}，A 股）`,
    `最新：${fmt(stock.price)}  当日涨跌：${fmt(stock.changePct)}%`,
    `成交额：${yi(stock.amount)}  换手：${fmt(stock.turnover)}%  总市值：${yi(stock.mktcap)}  流通市值：${yi(stock.floatCap)}`,
    `MA5=${fmt(last.ma5)}  MA10=${fmt(last.ma10)}  MA20=${fmt(last.ma20)}`,
    `**距 MA20 偏离 ${dev == null ? 'NA' : (dev > 0 ? '+' : '') + dev + '%'}  近5日涨幅 ${chg5 == null ? 'NA' : chg5 + '%'}` +
      `  近一月涨幅：${fmt(monthChangeFromBars(bars))}%  近20日均价 ${fmt(avg(closes.slice(-20)))}` +
      (closes.length ? `  60日高 ${fmt(Math.max(...closes))}  60日低 ${fmt(Math.min(...closes))}` : ''),
    '',
    '近期相关资讯标题：',
    ...(news.items || []).map((n, i) => `${i + 1}. ${n.title}`),
  ]
  if (!(news.items || []).length) lines.push('（本次未取到相关资讯标题）')
  return lines.join('\n')
}

export const INTERPRET_SYSTEM =
  '你是一名严谨、克制的证券分析师。只依据给定的行情数据与资讯标题做判断，用简体中文。' +
  '数据里没有的就明说「未取到」，绝不编造事实或传闻。' +
  '只输出一个 JSON 对象，不要 markdown 代码块、不要任何多余文字。'

// 实测该端点**不截断**：多字段 JSON 也能完整到 200+ 字、finish_reason=stop。
// 评的是**「现在这个价位值不值得买」**（buyScore）。注意：**不要单向地把「涨幅大」当利空**
// —— 上涨既可能是强势（买点也可能是回踩），也可能是过热（追高风险），要结合趋势位置、
// 量能、均线、估值、资讯**综合判断**，而不是见涨就扣分。
//
// `holdDays` 由模型**按这只票的实际状态**判断，不给默认值：选股已由客观因子决定
// （反转 + 上影线 + 年化ROE），持有期就按「这只票的逻辑多久兑现」来定。
// 判据见下方「持有周期判断依据」—— 那是可解释的状态映射，不是拟合出来的数字。
export const interpretUser = (ctx) =>
  `以下是某只 A 股的行情与资讯：\n\n${ctx}\n\n` +
  '从「**当前价位是否值得买入**」的角度，综合所有指标自行判断，只输出 JSON、不要解释：\n' +
  '{\n' +
  ' "buyScore": 0到100的整数（100=现在买很值得，0=完全不值得/应回避）,\n' +
  ' "holdDays": 建议持有交易日数（**正整数；按这只票的逻辑多久兑现自由决定，不要固定档位**，依据见下），\n' +
  ' "holdReason": "为什么是这个持有周期，一句话，20到40字（要能看出依据的是哪条状态）",\n' +
  ' "summary": "一句话概括，40到60字（讲清为什么值得或不值得买）",\n' +
  ' "catalysts": ["买入逻辑/支撑，3到5条，每条20到30字"],\n' +
  ' "risks": ["风险，2到3条，每条20到30字"],\n' +
  ' "tags": ["题材或风格标签，3到5个"]\n' +
  '}\n' +
  '判断要点（务必据此打分，直接决定 buyScore 高低）：\n' +
  '- **「距 MA20 偏离」是最关键的追高风险指标**：偏离 +15% 以上基本是追高，buyScore 应 ≤40；' +
  '+8%~+15% 偏贵，≤55；-3%~+8%（贴近均线）是较舒服的买点，可给高分；跌破 MA20 但趋势未坏' +
  '（缩量回踩）也可关注。\n' +
  '- **近5日/当日大涨要警惕**：短期已大涨（近5日 >+10%）再买入，多为接盘；上升趋势中' +
  '「缩量回踩均线」才是好买点，而非「放量突破新高」。\n' +
  '- 结合换手/成交额（温和放量 vs 巨量滞涨）、均线排列、市值与估值、资讯题材的**可信度与兑现度**。\n' +
  '- 明确过热的（连续涨停、监管函/问询、机构大幅净卖出、泡沫化）直接给低分。\n' +
  '- 数据缺失就按可得指标判断，不要臆测。\n' +
  '- **评分必须拉开区分度**：不要都挤在 60 分附近，好买点给 70-90，勉强给 45-55，追高/风险给 0-40。\n' +
  '持有周期判断依据（**按个股自由给具体天数，不要一律给同一个数，也不限于任何固定档位**）：\n' +
  '- 逻辑兑现越慢、趋势越健康（均线多头排列、题材/业绩有明确催化、近一月刚启动且未大幅偏离 MA20）→ 周期越长（可到十几~几十个交易日）。\n' +
  '- 买点越贵、短期动能越耗（偏离 MA20 偏大、上影线多、巨量滞涨，或只是跟随大盘普涨）→ 周期越短（几个交易日）。\n' +
  '- 已过热 / 技术破位 / 有明确风险事件（连续涨停、放量跌破 MA20、问询/减持/利空）→ 只给很短（1~3 日，反弹就走）。\n' +
  '- 若**买入评分本身很低**（<40）→ 也给短周期：不值得长期持有的票不该挂长周期。\n' +
  '- 请给出**具体天数**（如 4、7、12、23…），不要只挑整数档。'

// 第一步：从客观初筛后的候选里，按「值得买入」挑出 furtherPicks 只（分批喂，省 token）。
const PRESELECT_SYSTEM =
  '你是选股初筛员。只依据给定的量价数据，从候选里挑出**当前价位最值得进一步分析的**股票。只输出 JSON。'

export function buildPreselectRows(candidates) {
  return candidates
    .map(
      (c, i) =>
        `${i + 1}. ${c.code} ${c.name} 现价${fmt(c.price)} 当日${fmt(c.changePct)}% ` +
        `近一月${fmt(c.monthPct)}% 成交额${yi(c.amount)} 换手${fmt(c.turnover)}% 市值${yi(c.mktcap)}`,
    )
    .join('\n')
}

const preselectUser = (batch, want) =>
  `候选（共 ${batch.length} 只）：\n${buildPreselectRows(batch)}\n\n` +
  `从「当前价位值得买入」的角度挑出 ${want} 只。综合判断，**不要因为涨得多就一律排除，` +
  '也不要只挑跌得多的**；过热/高位风险与强势趋势要自己权衡：\n' +
  '{"picks":["600418","000001"]}\n只输出 JSON。'

// 第二步（仅当高分股多于 10 只时）：从这批**高买入评分**的股里，再挑出最值得买的 10 只。
const REVIEW_SYSTEM =
  '你是投资评审。下列候选都已是高买入评分的股票，请从中挑出最值得买入的。只输出 JSON。'

/** 拼二次评审的用户消息（导出以便单测）。 */
export function buildReviewRows(candidates) {
  return candidates
    .map(
      (c, i) =>
        `${i + 1}. ${c.code} ${c.name} 买入评分${c.ai?.buyScore ?? '-'} ${c.ai?.summary || ''}`,
    )
    .join('\n')
}

// 评审只负责**排序与取舍**，不单独产理由（理由复用该股 summary）。输出只剩 code 列表。
const reviewUser = (candidates, finalPicks) =>
  `候选（共 ${candidates.length} 只，已带买入评分）：\n${buildReviewRows(candidates)}\n\n` +
  `选出当前最值得买入的 ${finalPicks} 只（评分低、风险大的不要选），只输出代码：\n` +
  '{"picks":["600418","000001"]}\n只输出 JSON。'

/**
 * 单次对话。**必须关思考链**：deepseek-v4.x / opencode 这类模型默认先写几千字
 * `reasoning_content`，而它与正文共用 max_tokens —— 推荐这种「一次要几十次调用」的
 * 批处理下，思考预算吃光就意味着正文恒为空 / 被截断。统一对所有端点关思考。
 */
async function chatOnce(cfg, messages) {
  // 带重试：批处理下网络瞬时失败（fetch failed / 超时 / 断流）与限流（429）很常见，
  // 重试可避免「选股批次失败 → 退化成交额兜底」污染回测（2025 年 5 月起即因此全空）。
  // 只对网络/限流类重试，鉴权/参数类直接抛。限流退避更长。
  const maxTries = 5
  for (let i = 1; ; i += 1) {
    try {
      const result = await streamChat({
        config: cfg,
        messages,
        sessionId: crypto.randomUUID(),
        noThinking: true,
      })
      return result.text
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const rateLimited = /429|usage limit|rate limit|too many requests/i.test(msg)
      const retriable =
        rateLimited || /fetch failed|超时|网络|中断|ECONN|ETIMEDOUT|socket|other side closed|50[234]/i.test(msg)
      if (!retriable || i >= maxTries) throw e
      await new Promise((r) => setTimeout(r, (rateLimited ? 5000 : 700) * i * i))
    }
  }
}

/**
 * 模型选 Top100：把客观初筛后的候选**分批**喂给模型，每批按「值得买入」挑一批，
 * 汇总去重后取前 want 只。某批失败就用该批的成交额顺序兜底（保证凑得够）。
 * 分批是为了不把几百只塞进一次 prompt（超 token / 拖慢）。
 */
export async function selectCandidates(cfg, pool, want, onLog = () => {}, { batchSize = 100 } = {}) {
  const batches = Math.ceil(pool.length / batchSize)
  // 每批应挑多少：想选 100 只、池子 200 只（2 批）→ 每批 50。
  const perBatchTarget = Math.ceil(want / batches)
  const picked = []
  const seen = new Set()
  const take = (c) => {
    if (picked.length >= want || !c || seen.has(c.code)) return
    seen.add(c.code)
    picked.push(c)
  }

  for (let i = 0; i < pool.length && picked.length < want; i += batchSize) {
    const batch = pool.slice(i, i + batchSize)
    const byCode = new Map(batch.map((c) => [c.code, c]))
    let codes = []
    try {
      const text = await chatOnce(cfg, [
        { role: 'system', content: PRESELECT_SYSTEM },
        { role: 'user', content: preselectUser(batch, perBatchTarget) },
      ])
      codes = (parseJsonLoose(text)?.picks || [])
        .map((p) => (typeof p === 'string' ? p : p && p.code))
        .map((s) => String(s || '').trim())
        .filter(Boolean)
    } catch (err) {
      onLog(`  选股批次失败(${err instanceof Error ? err.message : String(err)})，用成交额顺序兜底`)
    }
    const before = picked.length
    for (const code of codes) take(byCode.get(code))
    // 本批模型挑得不够（或批次失败）→ 用该批成交额顺序补到 perBatchTarget
    if (picked.length - before < perBatchTarget) {
      for (const c of batch) {
        if (picked.length - before >= perBatchTarget) break
        take(c)
      }
    }
  }
  onLog(`  模型选出 ${picked.length} 只（每批目标 ${perBatchTarget}）`)
  return picked.slice(0, want)
}

/** 东财个股行业（f127），带缓存；失败返回 '?'。 */
const industryCache = new Map()
export async function industryOf(secid, deps = {}) {
  if (deps.industry) return deps.industry(secid)
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

/**
 * **多因子选股**（客观、可回测、无未来数据）：在候选池上算价量 + 点时财务因子 →
 * 截面 z-score 加权 → 行业分散（同行业 ≤ maxPerIndustry）→ 取 TopN。
 * AI 不参与选股，只负责后续解读。
 *
 * `finance(secid)` 返回 `{ roeAnnual, bps }`（lib/finance.js 的 financeFactors），
 * 按评估日做点时取数；不传则只用价量因子（权重项 `q` 贡献 0）。
 */
export async function selectByFactors(
  pool,
  { kline, finance, event, tilt = 0, indexBars = null, finalPicks = 10, maxPerIndustry = 99, industry, onLog = () => {} } = {},
) {
  // 指数收盘价 Map：供 computeFactors 算 beta / ivol（仅走强时 beta 生效）。
  const idxClose = Array.isArray(indexBars) && indexBars.length
    ? new Map(indexBars.map((b) => [b.time, b.close]))
    : null
  const withFeat = await mapLimit(pool, 12, async (c) => {
    let bars = null
    try {
      bars = (await kline(c.secid))?.bars || null
    } catch {
      bars = null
    }
    if (!bars || bars.length < 21) return null
    // 财务取不到就降级成 null（该票质量项贡献 0），不能因为财务源挂了就丢掉整只票。
    let fin = null
    if (finance) {
      try {
        fin = await finance(c.secid)
      } catch {
        fin = null
      }
    }
    const feat = computeFactors(bars, idxClose, fin)
    if (!feat) return null
    // 公告事件净分（lib/ann-factor.js）：回测/生产注入，失败降级为该项不贡献。
    if (event) {
      try {
        const ev = await event(c)
        if (ev != null) feat.event = ev
      } catch {
        /* 事件源失败不丢整只票 */
      }
    }
    return { ...c, feat }
  })
  const items = withFeat.filter(Boolean)
  if (!items.length) throw new Error('因子选股：无有效候选')
  const finCov = items.filter((x) => x.feat.roeAnnual != null).length
  if (finance) onLog(`因子选股：财务覆盖 ${finCov}/${items.length} 只`)
  const scores = compositeScores(items.map((x) => x.feat), { tilt })
  const ranked = items
    .map((x, i) => ({ ...x, factorScore: Number(scores[i].toFixed(4)) }))
    .sort((a, b) => b.factorScore - a.factorScore)

  // 不做行业分散（maxPerIndustry ≥ finalPicks）：直接取因子分前 N。
  // 目的：① 结果确定（不依赖东财 f127 是否可用）；② 实证本池分散反而拖累。
  if (maxPerIndustry >= finalPicks) {
    onLog(`因子选股：${items.length} 只候选 → Top${finalPicks}（不做行业分散）`)
    return ranked.slice(0, finalPicks)
  }

  const byInd = new Map()
  const picked = []
  const buf = []
  for (const x of ranked) {
    if (picked.length >= finalPicks) break
    const ind = await industryOf(x.secid, { industry })
    const used = byInd.get(ind) || 0
    if (used < maxPerIndustry) {
      byInd.set(ind, used + 1)
      picked.push({ ...x, industry: ind })
    } else {
      buf.push({ ...x, industry: ind })
    }
  }
  for (const x of buf) {
    if (picked.length >= finalPicks) break
    picked.push(x)
  }
  onLog(`因子选股：${items.length} 只候选 → Top${picked.length}（行业分散≤${maxPerIndustry}）`)
  return picked
}

/**
 * 选出最终 Top10。**以买入评分为准**，评审只做「高分股太多」时的取舍：
 *   1. 取 `buyScore ≥ highBar` 的高分股，按分降序。
 *   2. 高分股 ≤ finalPicks 只 → **直接就是结果**（不再调评审）。
 *   3. 高分股 > finalPicks 只 → 把这批高分股喂给评审挑 finalPicks 只；评审返回的
 *      code 必须落在高分区内（防它又选低分），不足则按评分补高分股。
 *   4. 高分股 < finalPicks 只 → 放宽门槛：按评分降序把剩下的（含低分）补到 finalPicks，
 *      但仍优先高分、低分只是垫底。
 * 结果统一按 buyScore 降序。
 */
export async function selectTop10(cfg, scored, finalPicks = 10, onLog = () => {}, { highBar = 60 } = {}) {
  const byScoreDesc = (a, b) => (b.ai?.buyScore ?? -1) - (a.ai?.buyScore ?? -1)
  const withScore = scored.filter((c) => c.ai?.buyScore != null).slice().sort(byScoreDesc)
  const high = withScore.filter((c) => c.ai.buyScore >= highBar)

  // ¥2 高分股不足 finalPicks：直接用（优先高分，再按分把低分垫底补满）
  if (high.length <= finalPicks) {
    onLog(`高分区(≥${highBar}) ${high.length} 只 ≤ ${finalPicks}，直接采用`)
    const picked = high.slice()
    if (picked.length < finalPicks) {
      const have = new Set(picked.map((c) => c.code))
      for (const c of withScore) {
        if (picked.length >= finalPicks) break
        if (!have.has(c.code)) picked.push(c)
      }
    }
    return picked
      .slice(0, finalPicks)
      .map((c) => ({ ...c, reason: c.ai?.summary || '', pickedBy: c.ai.buyScore >= highBar ? 'score' : 'fill' }))
  }

  // ¥3 高分股过多：交给评审取 10；评审结果强制落在高分区内
  onLog(`高分区(≥${highBar}) ${high.length} 只，交评审挑 ${finalPicks} 只`)
  let picks = []
  try {
    const text = await chatOnce(cfg, [
      { role: 'system', content: REVIEW_SYSTEM },
      { role: 'user', content: reviewUser(high, finalPicks) },
    ])
    picks = (parseJsonLoose(text)?.picks || [])
      .map((p) => (typeof p === 'string' ? p : p && p.code))
      .map((s) => String(s || '').trim())
      .filter(Boolean)
  } catch (err) {
    onLog(`评审失败(${err instanceof Error ? err.message : String(err)})，直接按评分取前 ${finalPicks}`)
  }
  const highByCode = new Map(high.map((c) => [c.code, c]))
  const out = []
  const seen = new Set()
  for (const code of picks) {
    const c = highByCode.get(code) // 只认高分区内的（挡住评审乱选低分）
    if (c && !seen.has(c.code)) {
      seen.add(c.code)
      out.push({ ...c, reason: c.ai?.summary || '', pickedBy: 'ai' })
    }
    if (out.length >= finalPicks) break
  }
  // 评审给的不够/无效 → 用高分股按分补齐
  for (const c of high) {
    if (out.length >= finalPicks) break
    if (!seen.has(c.code)) {
      seen.add(c.code)
      out.push({ ...c, reason: c.ai?.summary || '', pickedBy: 'score' })
    }
  }
  return out.sort(byScoreDesc)
}

/**
 * 市场状态 tilt：只用 ≤ basisDate 的沪深300 日K → 动量倾斜（0=纯反转，1=强动量）。
 * 走强时把部分反转权重挪给动量/相对强度，适配普涨行情；走弱则回到反转。
 * @returns {Promise<{tilt:number, idxBars:Array}>} idxBars 是 ≤ basisDate 的指数切片
 *   （供 beta / ivol 计算，别处也用得到，故一并返回）。
 * @param {object} [deps] `tilt` 可显式覆盖（回测/调参）；`indexBars` 可注入历史切片。
 */
export async function resolveTilt(deps = {}, basisDate) {
  let idxBars = []
  try {
    const rawIdx = deps.indexBars
      ? deps.indexBars
      : ((await cachedKline(BENCH_SECID).catch(() => null))?.bars || [])
    idxBars = Array.isArray(rawIdx) ? rawIdx.filter((b) => b.time <= basisDate) : []
  } catch {
    idxBars = []
  }
  return { tilt: Number.isFinite(deps.tilt) ? deps.tilt : regimeTilt(idxBars), idxBars }
}

/**
 * regime 双链路择链：**逐日**看 tilt 决定走 A 还是 B（不是按月）。
 *   tilt >= thr → 'A'：成交额池 + AI 初筛 + 买入评分（激进，强涨市弹性足）
 *   tilt <  thr → 'B'：稳健池 + 客观多因子（保守，跌市/震荡市更稳）
 * 纯函数（无 IO），供单测与调用方共用。
 */
export function pickChain(tilt, thr) {
  if (!Number.isFinite(tilt) || !Number.isFinite(thr)) return 'B'
  return tilt >= thr ? 'A' : 'B'
}

/**
 * 双链路择链时挑哪份 payload 落盘：优先用 tilt 选中的那条；那条缺失（跑挂了）就退回另一条。
 * 两条都没了就返回 null（调用方抛错）。纯函数，供单测。
 * @returns {{payload:object, chain:'A'|'B', fellBack:boolean}|null}
 */
export function resolveChainPayload({ useA, a, b }) {
  if (useA ? a : b) return { payload: useA ? a : b, chain: useA ? 'A' : 'B', fellBack: false }
  if (useA ? b : a) return { payload: b || a, chain: useA ? 'B' : 'A', fellBack: true }
  return null
}

/**
 * 跑一次每日推荐。
 * @param {object} opts
 * @param {string} opts.dataDir 数据目录（落盘 recommend/<date>.json）
 * @param {object} opts.cfg     AI 配置（见 settings.aiConfig）
 * @param {number} [opts.poolPages]   候选池页数（每页 100，默认 5 → 500 只）
 * @param {number} [opts.objTarget]   客观初筛后保留数（默认 200）
 * @param {number} [opts.topCandidates] 模型选出、进入精评的候选数（默认 100）
 * @param {number} [opts.finalPicks]    最终推荐数（默认 10）
 * @param {number} [opts.highBar]       买入评分「高分」门槛（默认 60），只有它才进 Top10 候选
 * @param {number} [opts.concurrency]   解读并发（默认 4）
 * @param {boolean} [opts.dryRun]       只跑不落盘
 * @param {string} [opts.date]          覆盖日期
 * @param {object} [opts.deps]          回测注入（默认走实时源，行为不变）：
 *   `{ pool(), kline(secid), news(stock), finance(secid), basisDate, effectiveDate }`
 *   `kline` 必须已截断到 basisDate（函数入口有断言，越界直接 throw）。
 * @param {string} [opts.fileDate]      覆盖落盘文件名（回测用「生效日」）
 * @param {(m:string)=>void} [opts.onLog]
 */
export async function runRecommendDaily({
  dataDir,
  cfg,
  poolPages = SEL.poolPages,
  objTarget = OBJECTIVE.target,
  topCandidates = SEL.topCandidates,
  finalPicks = SEL.finalPicks,
  concurrency = 4,
  highBar = 60,
  // 选股模式：'ai'=模型初筛+买入评分（旧链路）；'factors'=客观多因子选股（AI 只解读）。
  selectMode = 'ai',
  // 是否调 AI 逐只解读。快速回测可置 false：跳过 AI、买入评分留空、持有周期用 factorHoldDays。
  interpretAi = true,
  // 因子选股的行业分散上限；默认 99 = 不做分散（结果确定、实证更优）。
  maxPerIndustry = SEL.maxPerIndustry,
  // **兜底**持有交易日：只在 AI 未产出解读、或 --bare 快速回测（interpretAi=false）时使用。
  // 正常路径下由 AI 按个股实际状态判断 holdDays（见 interpretUser），不受此值影响。
  factorHoldDays = 10,
  // 产物落盘子目录（默认 recommend）；回测调参可用别的目录与榜单隔离。
  outSubdir = 'recommend',
  dryRun = false,
  date,
  deps = {},
  onLog = () => {},
} = {}) {
  if (interpretAi && !cfg?.apiKey) throw new Error('AI 未配置 API Key（先在站内 ⚙ 设置里配好 provider / Key）')

  // 红线：喂给因子的 K 线末根必须 ≤ 基准日（生产=今日，回测=回测日）。
  // 收口在 `klineOf` 这一个入口，而不是散落在各个调用点 —— deps.kline 由调用方注入，
  // 之前只有 backtest.js 自己在 `filter` 之后检查（filter 完再查 `> asOf` 永远不会触发，
  // 等于没检查），真正的风险正是「调用方忘了截断」。
  const basisDate = deps.basisDate || bjDate()
  const rawKlineOf = deps.kline || ((secid) => sinaKline(secid, { period: 'd', limit: 70 }))
  const klineOf = async (secid) => {
    const r = await rawKlineOf(secid)
    const bars = r?.bars
    if (Array.isArray(bars) && bars.length) {
      const lastTime = bars[bars.length - 1]?.time
      if (lastTime && lastTime > basisDate) {
        throw new Error(`未来数据泄漏：${secid} 日K ${lastTime} > 基准日 ${basisDate}`)
      }
    }
    return r
  }

  // 候选池：默认「稳健池」（沪深300+创业板+科创板）；deps.pool 可覆盖（回测 / A 链路成交额池）。
  onLog(deps.pool ? '拉取注入候选池（成交额池）…' : '拉取稳健候选池（沪深300 + 创业板 + 科创板）…')
  const pool = deps.pool ? await deps.pool() : await stablePool()
  if (!pool.length) throw new Error('候选池为空（新浪成分接口没返回数据）')

  // 市场状态（regime）：口径集中在 resolveTilt，双链路与单链路必须一致。
  const { tilt, idxBars: idxBarsForRegime } = await resolveTilt(deps, basisDate)
  if (selectMode === 'factors') onLog(`市场状态 tilt=${tilt.toFixed(2)}（0=纯反转，1=强动量）`)

  // ① 客观初筛：只用方向中性的规则把 500 压到 objTarget（默认 200），方向交给模型。
  // regime 自适应偏离上限：跌市收紧（15%，避追高）、涨市放宽（40%，纳入强势领涨股）。
  // 与 optimize-factors 的 DEV_LO/DEV_HI 保持一致（先验，经 2026 检验）。
  const devHi = Number(process.env.RECOMMEND_DEV_HI) || OBJECTIVE.devHi
  const maxDeviation = OBJECTIVE.maxDeviation + tilt * (devHi - OBJECTIVE.maxDeviation)
  const filtered = await objectiveFilter(pool, {
    target: objTarget,
    onLog,
    maxDeviation,
    kline: deps.kline ? (secid) => klineOf(secid) : undefined,
  })
  if (!filtered.length) throw new Error('客观初筛后无候选')

  // 选股：默认「AI 初筛」；`selectMode='factors'` 改走客观多因子（AI 不参与选股，只解读）。
  let candidates
  if (selectMode === 'factors') {
    onLog(`因子选股（候选 ${filtered.length} 只 → Top${topCandidates}）…`)
    candidates = await selectByFactors(filtered, {
      kline: (secid) => klineOf(secid),
      // 点时财务：按 basisDate 取「披露日 ≤ basisDate」的报告期。
      // 回测可注入 deps.finance（用已缓存的历史财务，避免联网），生产走默认实现。
      finance:
        deps.finance || ((secid) => financeFactors(secid, basisDate, { dataDir }).catch(() => null)),
      // 公告事件净分：调用方注入 deps.event（按 basisDate 预计算 Map）。
      // 生产见 scripts/recommend.js；回测见 scripts/backtest.js；未注入则该项不贡献。
      event: deps.event,
      // regime 动量倾斜（0=纯反转，1=强动量）：见上方 regimeTilt。
      tilt,
      // 指数切片（≤ basisDate）：供 beta / ivol 计算。
      indexBars: idxBarsForRegime,
      finalPicks: topCandidates,
      maxPerIndustry,
      industry: deps.industry,
      onLog,
    })
  } else {
    // ①.5 给初筛后的候选补「近一月涨幅」（**只喂给模型看，不参与筛选**）。
    onLog(`补近一月涨幅（${filtered.length} 只）…`)
    const enriched = await mapLimit(filtered, 8, async (c) => {
      let monthPct = null
      try {
        const k = await klineOf(c.secid)
        monthPct = monthChangeFromBars(k?.bars)
      } catch {
        monthPct = null
      }
      return { ...c, monthPct }
    })
    const withMonth = enriched.filter(Boolean)

    // ② 模型选 Top100：分批喂精简量价，按「值得买入」挑，汇总去重。
    onLog(`模型从 ${withMonth.length} 只里选 Top${topCandidates}…`)
    candidates = await selectCandidates(cfg, withMonth, topCandidates, onLog)
  }

  // ③ 逐只精评：带资讯 + K 线，输出 buyScore（买入视角）。
  //    `interpretAi=false`（快速回测）跳过 AI：买入评分留空、持有周期用默认 5 日。
  let done = 0
  const arr = (v, n) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean).slice(0, n) : [])
  const noAi = (c) => ({
    ...c,
    ai: {
      buyScore: null,
      holdDays: factorHoldDays,
      holdReason: '',
      summary: '',
      catalysts: [],
      risks: [],
      tags: [],
    },
  })
  const withAi = !interpretAi ? candidates.map(noAi) : await mapLimit(candidates, concurrency, async (c) => {
    const ctx = await stockContext(c, { kline: deps.kline && ((s) => klineOf(s.secid)), news: deps.news })
    let base = null
    try {
      base = parseJsonLoose(
        await chatOnce(cfg, [
          { role: 'system', content: INTERPRET_SYSTEM },
          { role: 'user', content: interpretUser(ctx) },
        ]),
      )
    } catch (err) {
      base = { error: err instanceof Error ? err.message : String(err) }
    }
    done += 1
    if (done % 10 === 0 || done === candidates.length) onLog(`  解读 ${done}/${candidates.length}`)
    if (!base || base.error) {
      if (process.env.RECOMMEND_DEBUG) onLog(`  解析失败 ${c.code}: ${JSON.stringify(base)}`)
      return {
        ...c,
        ai: {
          buyScore: null,
          holdDays: factorHoldDays,
          holdReason: '',
          summary: '',
          catalysts: [],
          risks: [],
          tags: [],
          ...(base || {}),
        },
      }
    }
    const buyScore = Number.isFinite(Number(base.buyScore))
      ? Math.max(0, Math.min(100, Math.round(Number(base.buyScore))))
      : null
    return {
      ...c,
      ai: {
        buyScore,
        holdDays: normalizeHoldDays(base.holdDays),
        holdReason: String(base.holdReason || '').slice(0, 80),
        summary: String(base.summary || '').slice(0, 160),
        catalysts: arr(base.catalysts, 8),
        risks: arr(base.risks, 8),
        tags: arr(base.tags, 10),
      },
    }
  })
  const scored = withAi.filter(Boolean)

  // 持仓周期：A、B 两条链路**都用模型按个股给的 holdDays**，不再由策略统一指定。
  // （历史曾把 B 链路强制成 factorHoldDays，按"参数不写死"要求已移除；factorHoldDays
  //   现在只在 AI 未产出/解析失败时兜底。）

  // 选 Top10：**先按买入评分**，高分才配进榜；评审只在「高分股超过 10 只」时用来取舍。
  // 早先无条件把 100 只交给评审，它会选进 18 分的股（评分才是逐只精评的可靠信号）。
  const top =
    selectMode === 'factors'
      ? scored.slice(0, finalPicks).map((c) => ({ ...c, reason: c.ai?.summary || '', pickedBy: 'factor' }))
      : await selectTop10(cfg, scored, finalPicks, onLog, { highBar })
  onLog(`Top10：${top.map((t) => `${t.code}(${t.ai.buyScore})`).join(' ')}`)

  const generatedOn = bjDate() // 分析发生日（收盘后那天）
  // `date` 可显式覆盖生效日（测试用）；否则 = 生成日的下一交易日。
  // 文件以**生效日**命名：用户看 2026-10-05 就是「10-05 这份推荐」。
  // 回测可传 `deps.effectiveDate`（历史某天 → 其下一交易日）覆盖之。
  const effective = date || deps.effectiveDate || nextTradingDay(generatedOn)
  // 基准价 = 生成日的收盘价（脚本收盘后跑，快照价即当天收盘）。
  // 回测里「生成日」= 回测的那一天 `deps.basisDate`。
  // （`basisDate` 已在函数开头定下 —— 泄漏断言要用它，不能只在这里才算。）
  const payload = {
    date: effective,
    generatedAt: new Date().toISOString(),
    basisDate,
    model: cfg.model,
    pool: { size: pool.length, filtered: filtered.length, candidates: scored.length },
    top,
    candidates: scored,
  }
  if (!dryRun) await writeJson(path.join(dataDir, outSubdir, `${effective}.json`), payload)
  onLog(
    `${dryRun ? '（dry-run，未落盘）' : '已写入'} ${effective}（生成于 ${generatedOn}）：池 ${pool.length} → 初筛 ${filtered.length} → 选${scored.length} → 推荐 ${top.length}`,
  )
  return payload
}

/** 前瞻归档目录：两条链路各一份，标准 payload 格式，可直接喂 `scripts/eval-ab-combo.js`。 */
export const FORWARD_A_DIR = 'recommend-ai-fwd'
export const FORWARD_B_DIR = 'recommend-factors-fwd'

/**
 * 把一条链路的当天结果压成「前瞻归档」：只留 pool + top + 判据（`candidates` 太重且对照用不到），
 * 并带上当天的 `tilt`/`thr` —— 日后重标阈值时直接读它，不必用当前 `regimeTilt` 重算历史。
 *
 * 存在意义：A（LLM）的优势是否来自「模型背过历史行情」现有样本判不了，只能靠**真实前瞻**
 * 积累样本外数据（未来行情模型不可能背过）。两条都归档 = 每天都有 A/B 对照，
 * 攒够后再用 `eval-ab-combo.js --a recommend-ai-fwd --b recommend-factors-fwd` 直接比。
 */
export function forwardArchive({ payload, chain, tilt, thr }) {
  if (!payload) return null
  return {
    date: payload.date,
    generatedAt: payload.generatedAt,
    basisDate: payload.basisDate,
    model: payload.model,
    pool: payload.pool,
    top: payload.top,
    regime: { tilt: Number(tilt.toFixed(4)), thr, chain },
  }
}

/** 两条链路都归档；任一条挂了就只归档另一条（不阻断当日产出）。 */
export async function archiveForwardChains(dataDir, { payloadA, payloadB, tilt, thr, onLog }) {
  const a = forwardArchive({ payload: payloadA, chain: 'A', tilt, thr })
  const b = forwardArchive({ payload: payloadB, chain: 'B', tilt, thr })
  if (a) await writeJson(path.join(dataDir, FORWARD_A_DIR, `${a.date}.json`), a)
  if (b) await writeJson(path.join(dataDir, FORWARD_B_DIR, `${b.date}.json`), b)
  const wrote = [a && `${FORWARD_A_DIR}/${a.date}.json`, b && `${FORWARD_B_DIR}/${b.date}.json`].filter(Boolean)
  onLog(`前瞻归档：${wrote.length ? wrote.join('、') : '两条都无产出，未归档'}`)
}

/**
 * regime **双链路**每日推荐：两条链路都跑，再按当日 tilt 选一份落盘。
 *
 *   tilt >= thr → A 链路（激进）：成交额池（aSharePool）+ AI 初筛 100 + 买入评分 Top10
 *   tilt <  thr → B 链路（保守）：稳健池（stablePool）+ 客观多因子 Top10
 *
 * 择链口径与回测评估 `scripts/eval-ab-combo.js --thr 0.6` 完全一致（逐日 tilt，非按月），
 * 2024-09 / 2025-08 / 2025-09 / 2026 各窗均按此口径验过。
 *
 * 两条都用 dryRun 跑 —— 复用 runRecommendDaily 的全部选股逻辑而不复制一份，
 * 只有**被选中的**那份写进 outSubdir（所以前端读法完全不变）。
 * 「两条都跑」是有意的：既满足「每天产出可对照」，也能在事后核对当天的 tilt 到底选对了没有。
 *
 * 顺序执行 A 再 B（不并发）：上游东财/新浪按 IP 限流，并发翻倍容易踩熔断。
 *
 * @param {object} opts 透传给 runRecommendDaily（dataDir/cfg/concurrency/deps/dryRun 等）
 * @param {number} [opts.thr=0.6] tilt 阈值，≥ 走 A
 * @param {number} [opts.poolPages=5] A 链路成交额池页数（每页 100 → 500 只）
 * @param {number} [opts.finalPicks=10] B 链路候选数 / 两条的最终推荐数
 */
export async function runRecommendRegime(opts = {}) {
  const { dataDir, cfg, thr = tiltThreshold(), poolPages = SEL.poolPages, finalPicks = SEL.finalPicks, deps = {}, onLog = () => {} } = opts

  const basisDate = deps.basisDate || bjDate()
  const { tilt } = await resolveTilt(deps, basisDate)
  const chain = pickChain(tilt, thr)
  const useA = chain === 'A'
  onLog(
    `市场状态 tilt=${tilt.toFixed(2)}（阈值 ${thr}）→ ${useA ? 'A 链路：成交额池 + AI 选股（激进）' : 'B 链路：稳健池 + 客观因子（保守）'}`,
  )

  // A 注入成交额池；B 必须把 pool 显式打回 undefined，否则会继承 A 的注入。
  // 单条链路失败不阻断整体：cron 每天必须出排行，哪怕只剩一条链路可用。
  const safeRun = async (label, cfgArgs) => {
    try {
      return await runRecommendDaily({
        ...opts,
        ...cfgArgs,
        dryRun: true,
        onLog: (m) => onLog(`[${label}] ${m}`),
      })
    } catch (e) {
      onLog(`[${label}] 链路失败（不阻断，另一条继续）：${e instanceof Error ? e.message : String(e)}`)
      return null
    }
  }

  const payloadA = await safeRun('A', {
    selectMode: 'ai',
    topCandidates: 100,
    deps: { ...deps, pool: () => aSharePool({ pages: poolPages }) },
  })
  const payloadB = await safeRun('B', {
    selectMode: 'factors',
    topCandidates: finalPicks,
    deps: { ...deps, pool: undefined },
  })

  const picked = resolveChainPayload({ useA, a: payloadA, b: payloadB })
  if (!picked) throw new Error('A / B 两条链路都失败，今天没有推荐产出')

  const { payload: chosen, chain: actualChain, fellBack } = picked
  // 记下当天的判据：事后复盘「tilt 选链」对不对，全靠这几个字段。
  chosen.regime = {
    tilt: Number(tilt.toFixed(4)),
    thr,
    chain: actualChain,
    intended: useA ? 'A' : 'B',
    fellBack,
    ranBoth: !!(payloadA && payloadB),
  }
  if (fellBack) onLog(`⚠ tilt 选中的 ${useA ? 'A' : 'B'} 链路不可用，已退回 ${actualChain} 链路`)
  const outSubdir = opts.outSubdir || 'recommend'
  if (!opts.dryRun) {
    await writeJson(path.join(dataDir, outSubdir, `${chosen.date}.json`), chosen)
    onLog(`已写入 ${outSubdir}/${chosen.date}.json（链路 ${actualChain}，tilt=${tilt.toFixed(2)}）`)
    // 无论选中哪条，两条都归档一份，供日后用真实前瞻数据判 A/B、重标 thr。
    await archiveForwardChains(dataDir, { payloadA, payloadB, tilt, thr, onLog })
  } else {
    onLog(`（dry-run，未落盘）链路 ${actualChain}，tilt=${tilt.toFixed(2)}`)
  }
  return chosen
}

/** 「推荐失效」表现：给定推荐日价与最新价，返回涨跌百分比；任一为空/为 0 则 null。 */
export function pctFromPick(pickPrice, latestPrice) {
  // 注意 Number(null) === 0、Number('') === 0，会把「缺值」误当成 0 价格，
  // 所以先显式挡掉 null / undefined / 空串，再转数字。
  const bad = (v) => v == null || v === ''
  if (bad(pickPrice) || bad(latestPrice)) return null
  const p = Number(pickPrice)
  const l = Number(latestPrice)
  if (!Number.isFinite(p) || !Number.isFinite(l) || p === 0) return null
  return Number(((l / p - 1) * 100).toFixed(2))
}

/** 已有的推荐日期列表（新→旧）。 */
/**
 * 回测/调参用过的日期区间 —— **不在应用里对外展示**。
 *
 * 这些天的推荐是「训练集 / 验证集」样本（用于拟合与检验因子权重），展示出来等于
 * 把样本内数据当成实盘推荐，会让访客误以为策略当时真在跑、并污染「整体盈亏」的口径。
 * 应用只应展示**训练窗口之后**的前瞻推荐。
 *
 * 窗口：2026-03-01 ~ 2026-09-30（验证 3-6 月 + 训练 7-9 月）。2026-10 起是真正的前瞻。
 */
export const HIDDEN_RECOMMEND_FROM = '2026-03-01'
export const HIDDEN_RECOMMEND_TO = '2026-09-30'
export const isHiddenRecommendDate = (d) => d >= HIDDEN_RECOMMEND_FROM && d <= HIDDEN_RECOMMEND_TO

/** 链路 → 子目录：dual=每日按 regime 选中的那份；A/B=两条链路各自的前瞻归档。 */
export const CHAIN_SUBDIR = { dual: 'recommend', A: FORWARD_A_DIR, B: FORWARD_B_DIR }
const chainSubdir = (chain) => CHAIN_SUBDIR[chain] || 'recommend'

export async function listRecommendDates(dataDir, chain = 'dual', { includeHidden = false } = {}) {
  try {
    const files = await fsp.readdir(path.join(dataDir, chainSubdir(chain)))
    return files
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.slice(0, 10))
      .filter((d) => includeHidden || !isHiddenRecommendDate(d))
      .sort()
      .reverse()
  } catch {
    return []
  }
}

const pad2 = (n) => String(n).padStart(2, '0')

/** ISO 日期减 n 个自然日（本地实现，避免依赖 trading-days 的内部 helper）。 */
function dateMinus(iso, n) {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d - n))
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`
}

/**
 * 「按历史推荐的 AI 持有周期，指定日应卖出」的股票。
 *
 * 到期日 = basisDate 往后第 holdDays 个交易日（与 holdReturn / 页面「按 AI 持有周期」同口径）。
 * 只收**到期日恰好等于 targetDate** 的（不含逾期）；同票多天命中**合并为一条**，
 * 取最早推荐日（持仓最久）展示，命中次数记在 `times`。扫描范围限定在 targetDate 前
 * 约 lookbackDays 天（holdDays ≤ 60，无需更早）。
 */
export async function dueOn(dataDir, targetDate, { chain = 'dual', lookbackDays = 140 } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(targetDate || ''))) return []
  const from = dateMinus(targetDate, lookbackDays)
  const dates = (await listRecommendDates(dataDir, chain, { includeHidden: true })).filter(
    (d) => d >= from && d <= targetDate,
  )
  const byStock = new Map()
  for (const d of dates) {
    const payload = await readJson(path.join(dataDir, chainSubdir(chain), `${d}.json`), null)
    if (!payload || !Array.isArray(payload.top)) continue
    const basis = payload.basisDate || d
    for (const s of payload.top) {
      const holdDays = s.ai?.holdDays ?? s.holdDays
      if (!s.secid || holdDays == null) continue
      let sell
      try {
        sell = addTradingDays(basis, Number(holdDays))
      } catch {
        continue
      }
      if (sell !== targetDate) continue
      const item = {
        secid: s.secid,
        code: s.code,
        name: s.name,
        holdDays: Number(holdDays),
        fromDate: payload.date || d,
        basisDate: basis,
        pickPrice: s.price ?? null,
        holdReason: s.ai?.holdReason ?? '',
      }
      const prev = byStock.get(s.secid)
      if (!prev) byStock.set(s.secid, { ...item, times: 1 })
      else {
        prev.times += 1
        if (item.fromDate < prev.fromDate) byStock.set(s.secid, { ...item, times: prev.times })
      }
    }
  }
  return [...byStock.values()].sort((a, b) => (a.fromDate < b.fromDate ? -1 : a.fromDate > b.fromDate ? 1 : 0))
}

/** 读某天（默认最新）的推荐文件；没有就返回 null。chain: dual（默认）| A | B。 */
export async function loadRecommend(dataDir, date, chain = 'dual') {
  const sub = chainSubdir(chain)
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
    // 训练/验证窗口的推荐不对外（见 isHiddenRecommendDate）：显式指定日期也读不到，
    // 避免用 `?date=2026-08-15` 绕过列表过滤。
    if (isHiddenRecommendDate(date)) return null
    return readJson(path.join(dataDir, sub, `${date}.json`), null)
  }
  const dates = await listRecommendDates(dataDir, chain)
  if (!dates.length) return null
  return readJson(path.join(dataDir, sub, `${dates[0]}.json`), null)
}

/**
 * 给某天的推荐补上「自推荐日到最新」的涨跌。
 *
 * 基准 = 该股在**生成日**的收盘价（payload.top[].price 就是这个快照），
 * 现价走行情降级链（东财→腾讯→新浪）的**最新价** —— 收盘后即当天收盘价。
 * 结果按天缓存 5 分钟（价格易变，但也不必每次请求都打上游）。
 * 取不到现价的条 sincePickPct 为 null（前端显示 —）。
 */
/**
 * 「按 AI 建议持有周期」的涨幅：基准 = 生成日(basisDate)收盘，卖出 = 其后第 holdDays 个
 * 交易日收盘。周期未走完（还没有那根 K 线）→ holdPct=null、holdDone=false。
 * 只读日K的历史切片，无未来数据。
 */
async function holdReturn(secid, basisDate, holdDays, livePrice = null) {
  if (!secid || !basisDate || !holdDays) return { holdPct: null, holdEndDate: null, holdDone: false }
  try {
    const bars = (await cachedKline(secid))?.bars || []
    // 取「≤ basisDate 的最后一根」而不是严格等于：basisDate 可能是节假日（如国庆），
    // 严格相等会查不到、整列变 null。与 benchReturns 同口径，两边才可相减出超额。
    let idx = -1
    for (let k = bars.length - 1; k >= 0; k -= 1) {
      if (bars[k].time <= basisDate && bars[k].close) {
        idx = k
        break
      }
    }
    if (idx < 0) return { holdPct: null, holdEndDate: null, holdDone: false }
    const base = bars[idx].close
    if (!base) return { holdPct: null, holdEndDate: null, holdDone: false }
    const sell = bars[idx + holdDays]
    // 周期没走完（还没有「basis 往后第 holdDays 个交易日」那根 K 线）→ 按现价折算到当日：
    // 优先拿实时价（盘中就有数），没有才退到最新一根日K。holdDone 仍为 false（前端标
    // 「未走完」），但持有收益与基准同期都能实时给出，不会一直「暂无数据」。
    if (!sell?.close) {
      const lastBar = bars[bars.length - 1]
      const eff = livePrice != null ? Number(livePrice) : lastBar?.close
      if (!eff) return { holdPct: null, holdEndDate: null, holdDone: false }
      return {
        holdPct: Number(((eff / base - 1) * 100).toFixed(2)),
        holdEndDate: livePrice != null ? bjDate() : lastBar.time,
        holdDone: false,
      }
    }
    return {
      holdPct: Number(((sell.close / base - 1) * 100).toFixed(2)),
      holdEndDate: sell.time,
      holdDone: true,
    }
  } catch {
    return { holdPct: null, holdEndDate: null, holdDone: false }
  }
}

/** 基准指数：沪深300。前端「整体盈亏」要拿它做同期对照。 */
export const BENCH_SECID = '1.000300'
export const BENCH_NAME = '沪深300'

/**
 * 基准指数在两个窗口的涨跌（%），与个股用**同一批交易日**对齐：
 *   - 持有窗口：basisDate 收盘 → holdEndDate（个股各自 AI 持有周期走完那天）收盘
 *   - 至今窗口：basisDate 收盘 → 指数最新（盘中为实时点位）
 * 这样前端等权平均后，就是「同一持有窗口下，大盘涨了多少」的可比数。
 *
 * 指数日K在盘中**不含当日那根**，若只按日K口径，最后一根恰好停在基准那根，
 * 两个窗口都会算成 0.00%（看起来像没数据）。所以这里额外接实时点位 liveIndex
 * （与个股 q.price 同一口径）：盘中拿实时，收盘后实时≈当日收盘，无缝衔接。
 */
export function benchReturns(bars, basisDate, holdEndDate, liveIndex = null) {
  // 取「≤ basisDate 的最后一根」而不是严格等于：basisDate 可能是节假日（如国庆），
  // 严格相等会查不到、整列变 null。个股那份基准价同样是「≤ basisDate 的最后一根收盘」，
  // 两边口径一致才能相减出超额。
  let i = -1
  for (let k = bars.length - 1; k >= 0; k -= 1) {
    if (bars[k].time <= basisDate && bars[k].close) {
      i = k
      break
    }
  }
  if (i < 0) return { holdIdxPct: null, sinceIdxPct: null }
  const base = bars[i].close
  const last = bars[bars.length - 1]
  // 至今窗口：优先实时点位（盘中即时、收盘后即当日收盘）；拿不到才退回日K最后一根。
  // 最后一根就是基准那根时旧口径会返回 0（「取不到」与「恰好为 0」分不开），实时点位能直接破掉这点。
  const live = Number(liveIndex)
  const liveOk = Number.isFinite(live) && live > 0
  const sinceIdxPct = liveOk
    ? Number(((live / base - 1) * 100).toFixed(2))
    : last?.close
      ? Number(((last.close / base - 1) * 100).toFixed(2))
      : null
  let holdIdxPct = null
  if (holdEndDate) {
    // 与 base/sinceIdxPct 同口径：取「≤ holdEndDate 的最后一根」，个股/指数停牌日差一天也能对上。
    let end = null
    for (let k = bars.length - 1; k >= 0; k -= 1) {
      if (bars[k].time <= holdEndDate && bars[k].close) {
        end = bars[k]
        break
      }
    }
    // 窗口已走完（结束日本身已是过去的交易日）→ 按结束日收盘，保持「同一持有窗口」语义；
    // 未走完 / 结束日就是今天（日K尚未出当日根）→ 用实时点位，与个股 holdReturn 实时折算对齐。
    const closed = !!end && !!holdEndDate && holdEndDate < bjDate()
    if (closed) holdIdxPct = Number(((end.close / base - 1) * 100).toFixed(2))
    else if (liveOk) holdIdxPct = Number(((live / base - 1) * 100).toFixed(2))
    else if (end) holdIdxPct = Number(((end.close / base - 1) * 100).toFixed(2))
  }
  return { holdIdxPct, sinceIdxPct }
}

export async function attachPerformance(payload, { quoteFn = getQuotes, ttlMs = 5 * 60_000 } = {}) {
  if (!payload || !Array.isArray(payload.top) || !payload.top.length) return payload
  const secids = [...new Set(payload.top.map((s) => s.secid).filter(Boolean))]
  let quotes = new Map()
  try {
    // 缓存键带 secid 集合：A/B 链路标的集不同，共用一个键会让先加载的链路把
    // 另一条链路的个股行情顶掉（sincePickPct 全变 null）。同链路内多次刷新仍命中。
    const key = `recperf:${payload.date}:${[...secids].sort().join('+')}`
    const { items } = await cached(key, ttlMs, async () => {
      // 基准指数与个股同批取：一次请求（≤11 个）就够，盘中能拿到沪深300实时点位。
      const q = await quoteFn([...secids, BENCH_SECID])
      return { items: q.items || [] }
    })
    quotes = new Map(items.map((q) => [q.secid, q]))
  } catch {
    /* 上游挂了就整段 null，不阻断展示 */
  }
  // 基准指数日K只取一次（算基准价与已走完窗口的收盘）；拿不到就整列 null（前端显示 —），不阻断个股盈亏。
  const benchBars = (await cachedKline(BENCH_SECID).catch(() => null))?.bars || []
  const indexLive = quotes.get(BENCH_SECID)?.price ?? null
  const withPerf = await mapLimit(payload.top, 8, async (s) => {
    const q = quotes.get(s.secid)
    const holdDays = s.ai?.holdDays ?? null
    const hr = await holdReturn(s.secid, payload.basisDate, holdDays, q?.price)
    const bench = benchBars.length
      ? benchReturns(benchBars, payload.basisDate, hr.holdEndDate, indexLive)
      : {}
    return {
      ...s,
      latestPrice: q?.price ?? null,
      // 「今日涨幅」列：优先实时行情（有效日之后 = 自推荐日的真实涨跌），
      // 别用生成时写入的快照 changePct（那是上一个交易日的涨幅）。基准价 price 不动。
      changePct: q?.changePct ?? s.changePct ?? null,
      sincePickPct: pctFromPick(s.price, q?.price),
      holdDays,
      holdPct: hr.holdPct,
      holdEndDate: hr.holdEndDate,
      holdDone: hr.holdDone,
      holdIdxPct: bench.holdIdxPct ?? null,
      sinceIdxPct: bench.sinceIdxPct ?? null,
    }
  })
  return { ...payload, top: withPerf, benchName: BENCH_NAME }
}
