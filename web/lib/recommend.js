import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { streamChat, isOpenCode } from './llm.js'
import { stockNews } from './news.js'
import { sinaKline } from './sina.js'
import { readJson, writeJson } from './store.js'
import { aSharePool, rankByMonthChange, mapLimit } from './rank.js'

// 每日推荐：对近一月涨幅 Top100 逐只做 AI 解读（含 0-100 自评），再由 AI 二次评审挑出
// Top10。产物落 DATA_DIR/recommend/<date>.json，前端「推荐」页签直接读。

const fmt = (n, d = 2) =>
  n == null || Number.isNaN(Number(n)) ? 'NA' : Number(n).toFixed(d)

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
    `近一月涨幅：${fmt(stock.monthPct)}%`,
    `MA5=${fmt(last.ma5)}  MA10=${fmt(last.ma10)}  MA20=${fmt(last.ma20)}`,
    `近20日均价 ${fmt(avg(closes.slice(-20)))}` +
      (closes.length ? `  60日高 ${fmt(Math.max(...closes))}  60日低 ${fmt(Math.min(...closes))}` : ''),
    '',
    '近期相关资讯标题：',
    ...(news.items || []).map((n, i) => `${i + 1}. ${n.title}`),
  ]
  if (!(news.items || []).length) lines.push('（本次未取到相关资讯标题）')
  return lines.join('\n')
}

const INTERPRET_SYSTEM =
  '你是一名克制的证券分析师。只依据给定的行情数据与资讯标题做判断，用简体中文。' +
  '数据里没有的就明说「未取到」，绝不编造事实或传闻。' +
  '只输出一个 JSON 对象，不要 markdown 代码块、不要任何多余文字。'

// 某些 OpenAI 兼容端点会在 ~100 字处把流截断（finish_reason 都不发）。若把 score /
// summary / 明细塞进同一个 JSON，字段一多就半截。对策：**两次请求、各自简短** ——
// 第一次只给 score+summary，第二次只给 catalysts/risks/tags（见 INTERPRET_DETAIL_SYSTEM）。
// 第一次请求：只给评分，输出最短，基本不会被截断。
const interpretUser = (ctx) =>
  `以下是某只 A 股的行情与资讯：\n\n${ctx}\n\n` +
  '评估它的关注价值（越值得关注分越高，不是涨幅大小），只输出 JSON、不要解释：\n' +
  '{"score":0到100的整数}'

const INTERPRET_DETAIL_SYSTEM =
  '你是证券分析师。基于给定数据提炼要点，只输出一个 JSON 对象，不要 markdown、不要多余文字。'

// 第二次请求：summary + 明细。summary 放最后写，这样即便撞上端点截断，规则字段
// （catalysts/risks/tags）也大概率已完整；summary 本身也压到 12 字以内降低风险。
const interpretDetailUser = (ctx) =>
  `以下是某只 A 股的行情与资讯：\n\n${ctx}\n\n` +
  '总结要点，只输出 JSON、不要解释：\n' +
  '{"catalysts":["支撑逻辑,2到3条,每条12字以内"],"risks":["风险,1到2条,每条12字以内"],"tags":["题材标签,2到4个"],"summary":"一句话总结,12字以内"}'

const REVIEW_SYSTEM =
  '你是投资评审。从一批按近一月涨幅初筛、带 AI 摘要的 A 股里挑最值得当日关注的。只输出 JSON。'

/** 拼二次评审的用户消息（导出以便单测）。 */
export function buildReviewRows(candidates) {
  return candidates
    .map((c, i) => `${i + 1}. ${c.code} ${c.name} 月涨${fmt(c.monthPct)}% 评分${c.ai?.score ?? '-'} ${c.ai?.summary || ''}`)
    .join('\n')
}

// 不再让评审单独产出「理由」——那会显著加长输出、撞上端点截断。理由直接复用该股的
// AI 摘要（summary），评审只负责**排序与取舍**。输出因此只剩一句 code 列表。
const reviewUser = (candidates, finalPicks) =>
  `候选（共 ${candidates.length} 只）：\n${buildReviewRows(candidates)}\n\n` +
  `选出最值得关注的 ${finalPicks} 只，只输出它们的代码，如：\n` +
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
 * 跑一次每日推荐。
 * @param {object} opts
 * @param {string} opts.dataDir 数据目录（落盘 recommend/<date>.json）
 * @param {object} opts.cfg     AI 配置（见 settings.aiConfig）
 * @param {number} [opts.poolPages]   候选池页数（每页 100，默认 5 → 500 只）
 * @param {number} [opts.topCandidates] 进入 AI 解读的候选数（默认 100）
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
  onLog(`候选池 ${pool.length} 只，逐只算近一月涨幅…`)

  const ranked = await rankByMonthChange(pool, { limit: 8 })
  onLog(`算得月涨幅 ${ranked.length} 只，取 Top${topCandidates} 做 AI 解读`)

  const candidates = ranked.slice(0, topCandidates)
  let done = 0
  // 两次请求：① 评分 + 一句话；② 明细。分开是为了绕开端点 ~100 字的硬截断 ——
  // 把 5 个字段塞一个 JSON 里必然半截，拆成两小份则各自完整。
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
    let detail = null
    try {
      detail = parseJsonLoose(
        await chatOnce(cfg, [
          { role: 'system', content: INTERPRET_DETAIL_SYSTEM },
          { role: 'user', content: interpretDetailUser(ctx) },
        ]),
      )
    } catch {
      /* 明细拿不到不影响主评分 */
    }
    done += 1
    if (done % 10 === 0 || done === candidates.length) onLog(`  解读 ${done}/${candidates.length}`)
    if (!base || base.error) {
      if (process.env.RECOMMEND_DEBUG) onLog(`  解析失败 ${c.code}: ${JSON.stringify(base)}`)
      return { ...c, ai: { score: null, summary: '', catalysts: [], risks: [], tags: [], ...(base || {}) } }
    }
    const score = Number.isFinite(Number(base.score)) ? Math.max(0, Math.min(100, Math.round(Number(base.score)))) : null
    return {
      ...c,
      ai: {
        score,
        // summary 优先取明细那次（它没有 score 挤占输出预算），回退到 base
        summary: String(detail?.summary || base.summary || '').slice(0, 60),
        catalysts: arr(detail?.catalysts, 6),
        risks: arr(detail?.risks, 6),
        tags: arr(detail?.tags, 8),
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
  // 评审没给出足够结果时，按自评分兜底补齐
  if (top.length < finalPicks) {
    const pickedCodes = new Set(top.map((c) => c.code))
    const fallback = scored
      .filter((c) => !pickedCodes.has(c.code) && c.ai?.score != null)
      .sort((a, b) => b.ai.score - a.ai.score)
      .slice(0, finalPicks - top.length)
      .map((c) => ({ ...c, reason: '按 AI 自评分入选', pickedBy: 'score' }))
    top = [...top, ...fallback]
  }

  const day = date || bjDate()
  const payload = {
    date: day,
    generatedAt: new Date().toISOString(),
    model: cfg.model,
    pool: { size: pool.length, candidates: scored.length },
    top,
    candidates: scored,
  }
  if (!dryRun) await writeJson(path.join(dataDir, 'recommend', `${day}.json`), payload)
  onLog(`${dryRun ? '（dry-run，未落盘）' : '已写入'} ${day}: 候选 ${scored.length} / 推荐 ${top.length}`)
  return payload
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
