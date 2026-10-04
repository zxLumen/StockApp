import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { streamChat, isOpenCode } from './llm.js'
import { stockNews } from './news.js'
import { sinaKline } from './sina.js'
import { getQuotes } from './market.js'
import { cached } from './http.js'
import { readJson, writeJson } from './store.js'
import { aSharePool, objectiveFilter, mapLimit, monthChangeFromBars } from './rank.js'

// 每日推荐：对近一月涨幅 Top100 逐只做 AI 解读（含 0-100 自评），再由 AI 二次评审挑出
// Top10。产物落 DATA_DIR/recommend/<date>.json，前端「推荐」页签直接读。

const fmt = (n, d = 2) =>
  n == null || Number.isNaN(Number(n)) ? 'NA' : Number(n).toFixed(d)

const yi = (n) => (n == null || Number.isNaN(Number(n)) ? 'NA' : `${(Number(n) / 1e8).toFixed(2)} 亿`)

/** 北京时间当天 YYYY-MM-DD。 */
export function bjDate(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
}

/** 周末判定（用 UTC 的星期分量，避免本地时区把日期挪一天）。 */
function isWeekend(iso) {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay()
  return day === 0 || day === 6
}

/**
 * 下一交易日（只跳周末；不含法定节假日 —— 那是要维护一张表的，暂不做）。
 * 推荐脚本在「生成日」收盘后跑，文件名用**推荐生效日**（下一交易日），
 * 这样标题里的日期 = 用户实际参考 / 买入的交易日，而不是分析发生的那天。
 */
export function nextTradingDay(iso) {
  let d = new Date(`${iso}T00:00:00Z`)
  do {
    d = new Date(d.getTime() + 86_400_000)
  } while (isWeekend(d.toISOString().slice(0, 10)))
  return d.toISOString().slice(0, 10)
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

/** 单只标的的解读上下文（行情 + 均线 + 资讯标题）。 */
export async function stockContext(stock) {
  const [kline, news] = await Promise.all([
    sinaKline(stock.secid, { period: 'd', limit: 70 }).catch(() => null),
    stockNews([stock.name, stock.code].filter(Boolean), { limit: 8, scope: 'cn' }).catch(() => ({ items: [] })),
  ])
  const bars = kline?.bars || []
  const closes = bars.map((b) => b.close).filter((v) => v != null)
  const last = bars[bars.length - 1] || {}
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null)
  const lines = [
    `标的：${stock.name}（${stock.code}，A 股）`,
    `最新：${fmt(stock.price)}  当日涨跌：${fmt(stock.changePct)}%`,
    `成交额：${yi(stock.amount)}  换手：${fmt(stock.turnover)}%  总市值：${yi(stock.mktcap)}  流通市值：${yi(stock.floatCap)}`,
    `MA5=${fmt(last.ma5)}  MA10=${fmt(last.ma10)}  MA20=${fmt(last.ma20)}`,
    `近一月涨幅：${fmt(monthChangeFromBars(bars))}%  近20日均价 ${fmt(avg(closes.slice(-20)))}` +
      (closes.length ? `  60日高 ${fmt(Math.max(...closes))}  60日低 ${fmt(Math.min(...closes))}` : ''),
    '',
    '近期相关资讯标题：',
    ...(news.items || []).map((n, i) => `${i + 1}. ${n.title}`),
  ]
  if (!(news.items || []).length) lines.push('（本次未取到相关资讯标题）')
  return lines.join('\n')
}

const INTERPRET_SYSTEM =
  '你是一名严谨、克制的证券分析师。只依据给定的行情数据与资讯标题做判断，用简体中文。' +
  '数据里没有的就明说「未取到」，绝不编造事实或传闻。' +
  '只输出一个 JSON 对象，不要 markdown 代码块、不要任何多余文字。'

// 实测该端点**不截断**：多字段 JSON 也能完整到 200+ 字、finish_reason=stop。
// 评的是**「现在这个价位值不值得买」**（buyScore）。注意：**不要单向地把「涨幅大」当利空**
// —— 上涨既可能是强势（买点也可能是回踩），也可能是过热（追高风险），要结合趋势位置、
// 量能、均线、估值、资讯**综合判断**，而不是见涨就扣分。
const interpretUser = (ctx) =>
  `以下是某只 A 股的行情与资讯：\n\n${ctx}\n\n` +
  '从「**当前价位是否值得买入**」的角度，综合所有指标自行判断，只输出 JSON、不要解释：\n' +
  '{\n' +
  ' "buyScore": 0到100的整数（100=现在买很值得，0=完全不值得/应回避）,\n' +
  ' "summary": "一句话概括，40到60字（讲清为什么值得或不值得买）",\n' +
  ' "catalysts": ["买入逻辑/支撑，3到5条，每条20到30字"],\n' +
  ' "risks": ["风险，2到3条，每条20到30字"],\n' +
  ' "tags": ["题材或风格标签，3到5个"]\n' +
  '}\n' +
  '判断要点（自行权衡，不要机械套用）：\n' +
  '- **涨跌幅要结合位置看**：上升趋势中回踩均线可能是买点，脱离均线过远/连续涨停/高位放量' +
  '滞涨才更要警惕；下跌趋势中即便跌得多也未必是买点。\n' +
  '- 结合换手/成交额（放量突破 vs 缩量阴跌）、均线排列、市值与估值、资讯题材的**可信度与兑现度**。\n' +
  '- 只对「明确」的过热/风险扣分（连续涨停、监管函/问询、机构大幅净卖出、明显泡沫化），' +
  '不要因为「涨了几天」就一律给低分。\n' +
  '- 数据缺失（如某项未取到）就按可得指标判断，不要臆测缺失项。'

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

// 第二步：从 Top100（已带各只 buyScore/摘要）里挑最终 Top10。
const REVIEW_SYSTEM =
  '你是投资评审。从一批已评估「值得买入」程度的 A 股里，挑出最值得买入的。只输出 JSON。'

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
 * 批处理下，思考预算吃光就意味着正文恒为空 / 被截断。server.js 的实时解读走的是
 * 同一条 `noThinking` 判断（`isOpenCode`），这里对齐。
 */
async function chatOnce(cfg, messages) {
  const result = await streamChat({
    config: cfg,
    messages,
    sessionId: crypto.randomUUID(),
    noThinking: isOpenCode(cfg.baseURL),
  })
  return result.text
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

/**
 * 跑一次每日推荐。
 * @param {object} opts
 * @param {string} opts.dataDir 数据目录（落盘 recommend/<date>.json）
 * @param {object} opts.cfg     AI 配置（见 settings.aiConfig）
 * @param {number} [opts.poolPages]   候选池页数（每页 100，默认 5 → 500 只）
 * @param {number} [opts.objTarget]   客观初筛后保留数（默认 200）
 * @param {number} [opts.topCandidates] 模型选出、进入精评的候选数（默认 100）
 * @param {number} [opts.finalPicks]    最终推荐数（默认 10）
 * @param {number} [opts.concurrency]   解读并发（默认 4）
 * @param {boolean} [opts.dryRun]       只跑不落盘
 * @param {string} [opts.date]          覆盖日期
 * @param {(m:string)=>void} [opts.onLog]
 */
export async function runRecommendDaily({
  dataDir,
  cfg,
  poolPages = 5,
  objTarget = 200,
  topCandidates = 100,
  finalPicks = 10,
  concurrency = 4,
  dryRun = false,
  date,
  onLog = () => {},
} = {}) {
  if (!cfg?.apiKey) throw new Error('AI 未配置 API Key（先在站内 ⚙ 设置里配好 provider / Key）')

  onLog(`拉取成交额候选池（前 ${poolPages * 100} 只）…`)
  const pool = await aSharePool({ pages: poolPages })
  if (!pool.length) throw new Error('候选池为空（新浪榜单接口没返回数据）')

  // ① 客观初筛：只用方向中性的规则把 500 压到 objTarget（默认 200），方向交给模型。
  const filtered = await objectiveFilter(pool, { target: objTarget, onLog })
  if (!filtered.length) throw new Error('客观初筛后无候选')

  // ①.5 给初筛后的候选补「近一月涨幅」（**只喂给模型看，不参与筛选**）—— 模型多次抱怨
  // 缺中期趋势参考。objectiveFilter 已经拉过日 K，这里复用同一份（有 cached）。
  onLog(`补近一月涨幅（${filtered.length} 只）…`)
  const enriched = await mapLimit(filtered, 8, async (c) => {
    let monthPct = null
    try {
      const k = await sinaKline(c.secid, { period: 'd', limit: 30 })
      monthPct = monthChangeFromBars(k?.bars)
    } catch {
      monthPct = null
    }
    return { ...c, monthPct }
  })
  const withMonth = enriched.filter(Boolean)

  // ② 模型选 Top100：分批喂精简量价，按「值得买入」挑，汇总去重。
  onLog(`模型从 ${withMonth.length} 只里选 Top${topCandidates}…`)
  const candidates = await selectCandidates(cfg, withMonth, topCandidates, onLog)

  // ③ 逐只精评：带资讯 + K 线，输出 buyScore（买入视角）。
  let done = 0
  const arr = (v, n) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean).slice(0, n) : [])
  const withAi = await mapLimit(candidates, concurrency, async (c) => {
    const ctx = await stockContext(c)
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
      return { ...c, ai: { buyScore: null, summary: '', catalysts: [], risks: [], tags: [], ...(base || {}) } }
    }
    const buyScore = Number.isFinite(Number(base.buyScore))
      ? Math.max(0, Math.min(100, Math.round(Number(base.buyScore))))
      : null
    return {
      ...c,
      ai: {
        buyScore,
        summary: String(base.summary || '').slice(0, 160),
        catalysts: arr(base.catalysts, 8),
        risks: arr(base.risks, 8),
        tags: arr(base.tags, 10),
      },
    }
  })
  const scored = withAi.filter(Boolean)

  onLog('AI 二次评审挑 Top10…')
  let picks = []
  try {
    const text = await chatOnce(cfg, [
      { role: 'system', content: REVIEW_SYSTEM },
      { role: 'user', content: reviewUser(scored, finalPicks) },
    ])
    const raw = parseJsonLoose(text)?.picks || []
    // 兼容两种形状：新式 ["600418", …] 与旧式 [{code, reason}, …]
    picks = raw
      .map((p) => (typeof p === 'string' ? p : p && p.code))
      .map((s) => String(s || '').trim())
      .filter(Boolean)
    if (process.env.RECOMMEND_DEBUG) onLog(`评审返 ${picks.length} 个：${picks.join(',')}`)
  } catch (err) {
    onLog(`二次评审失败(${err instanceof Error ? err.message : String(err)})，改用评分兜底`)
  }
  const byCode = new Map(scored.map((c) => [c.code, c]))
  let top = picks
    .map((code) => {
      const c = byCode.get(code)
      // 理由直接用该股的 AI 摘要，不再让评审单独产 reason（输出一长就撞端点截断）
      return c ? { ...c, reason: c.ai?.summary || '', pickedBy: 'ai' } : null
    })
    .filter(Boolean)
    .slice(0, finalPicks)
  // 评审没给出足够结果时，按买入评分兜底补齐（低分也留，不硬排除）
  if (top.length < finalPicks) {
    const pickedCodes = new Set(top.map((c) => c.code))
    const fallback = scored
      .filter((c) => !pickedCodes.has(c.code) && c.ai?.buyScore != null)
      .sort((a, b) => b.ai.buyScore - a.ai.buyScore)
      .slice(0, finalPicks - top.length)
      .map((c) => ({ ...c, reason: c.ai?.summary || '', pickedBy: 'score' }))
    top = [...top, ...fallback]
  }
  // 展示顺序统一按买入评分降序（评审顺序之外更贴「值不值得买」）
  top = top.sort((a, b) => (b.ai?.buyScore ?? -1) - (a.ai?.buyScore ?? -1))

  const generatedOn = bjDate() // 分析发生日（收盘后那天）
  // `date` 可显式覆盖生效日（测试用）；否则 = 生成日的下一交易日。
  // 文件以**生效日**命名：用户看 2026-10-05 就是「10-05 这份推荐」。
  const effective = date || nextTradingDay(generatedOn)
  // 基准价 = 生成日的收盘价（脚本收盘后跑，快照价即当天收盘）。每只的 perf 都以它为基准。
  const basisDate = generatedOn
  const payload = {
    date: effective,
    generatedAt: new Date().toISOString(),
    basisDate,
    model: cfg.model,
    pool: { size: pool.length, filtered: filtered.length, candidates: scored.length },
    top,
    candidates: scored,
  }
  if (!dryRun) await writeJson(path.join(dataDir, 'recommend', `${effective}.json`), payload)
  onLog(
    `${dryRun ? '（dry-run，未落盘）' : '已写入'} ${effective}（生成于 ${generatedOn}）：池 ${pool.length} → 初筛 ${filtered.length} → 选${scored.length} → 推荐 ${top.length}`,
  )
  return payload
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
export async function listRecommendDates(dataDir) {
  try {
    const files = await fsp.readdir(path.join(dataDir, 'recommend'))
    return files
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort()
      .reverse()
  } catch {
    return []
  }
}

/** 读某天（默认最新）的推荐文件；没有就返回 null。 */
export async function loadRecommend(dataDir, date) {
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
    return readJson(path.join(dataDir, 'recommend', `${date}.json`), null)
  }
  const dates = await listRecommendDates(dataDir)
  if (!dates.length) return null
  return readJson(path.join(dataDir, 'recommend', `${dates[0]}.json`), null)
}

/**
 * 给某天的推荐补上「自推荐日到最新」的涨跌。
 *
 * 基准 = 该股在**生成日**的收盘价（payload.top[].price 就是这个快照），
 * 现价走行情降级链（东财→腾讯→新浪）的**最新价** —— 收盘后即当天收盘价。
 * 结果按天缓存 5 分钟（价格易变，但也不必每次请求都打上游）。
 * 取不到现价的条 sincePickPct 为 null（前端显示 —）。
 */
export async function attachPerformance(payload, { quoteFn = getQuotes, ttlMs = 5 * 60_000 } = {}) {
  if (!payload || !Array.isArray(payload.top) || !payload.top.length) return payload
  const secids = [...new Set(payload.top.map((s) => s.secid).filter(Boolean))]
  let quotes = new Map()
  try {
    const { items } = await cached(`recperf:${payload.date}`, ttlMs, async () => {
      const q = await quoteFn(secids)
      return { items: q.items || [] }
    })
    quotes = new Map(items.map((q) => [q.secid, q]))
  } catch {
    /* 上游挂了就整段 null，不阻断展示 */
  }
  const withPerf = payload.top.map((s) => {
    const q = quotes.get(s.secid)
    return {
      ...s,
      latestPrice: q?.price ?? null,
      sincePickPct: pctFromPick(s.price, q?.price),
    }
  })
  return { ...payload, top: withPerf }
}
