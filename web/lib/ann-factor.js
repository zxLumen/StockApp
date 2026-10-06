// 公告事件因子：把「≤ D 的公告标题」按**冻结词表**客观分类为利好/利空，聚合为每只股票的
// 事件净分（event score），供多因子选股使用。**不使用任何 LLM**（LLM 情绪分已证无正向预测力）。
//
// 红线：只读 `DATA_DIR/ann-archive/<day>.json`，且条目 `time <= D 23:59:59`；窗口只回看。
//
// ⚠️ 纪律：下面的词表方向来自**领域先验**，必须在看任何样本外（2025-09）结果之前冻结。
// 一旦用于 OOS 验证，就不得再依据 2025-09 的表现增删规则 —— 否则 OOS 失效。
import path from 'node:path'

import { readJson } from './store.js'

const DAY_MS = 86400000

// 分类规则：命中即计入（同一条可命中多条）。`w` 为该类方向分（sign 表方向）。
// 正则锚定公告常用措辞，避免董事会决议 / 会议通知等日常公告误触发。
export const ANN_RULES = [
  // —— 利好 ——
  { type: '业绩预增', sign: 1, w: 3.0, re: /业绩(预增|预盈)|预计.{0,12}(净利润|业绩).{0,8}(大幅)?(增长|上升)|扭亏为盈|实现盈利/ },
  { type: '业绩略增', sign: 1, w: 1.5, re: /业绩(略增|续盈)|预计.{0,12}(利润|业绩).{0,6}(小幅)?增长/ },
  { type: '业绩快报向好', sign: 1, w: 2.0, re: /业绩快报/ },
  { type: '回购', sign: 1, w: 2.0, re: /(股份)?回购(股份|方案|进展|报告书|专用证券账户)?/ },
  { type: '增持', sign: 1, w: 2.0, re: /(股东|控股股东|实际控制人|董监高|董事|高管).{0,8}(增持|拟增持)|增持(计划|公司股份)/ },
  { type: '中标合同', sign: 1, w: 2.0, re: /(中标|重大合同|签订.{0,8}合同|框架协议|采购订单|销售订单)/ },
  { type: '分红送转', sign: 1, w: 1.5, re: /(每10股|每十股|利润分配|权益分派|派息|转增|送股)/ },
  { type: '股权激励', sign: 1, w: 1.5, re: /股权激励|限制性股票(激励|授予)|员工持股计划/ },
  { type: '资产重组', sign: 1, w: 1.5, re: /(重大资产重组|资产注入|发行股份购买资产|要约收购)/ },
  // —— 利空 ——
  { type: '业绩预减', sign: -1, w: 3.0, re: /业绩(预减|预亏)|预计.{0,12}(利润|业绩|净利润).{0,8}(下降|下滑|亏损)|首亏|续亏/ },
  { type: '减持', sign: -1, w: 2.0, re: /(股东|控股股东|实际控制人|董监高|董事|高管).{0,8}(减持|拟减持)|减持(计划|公司股份)/ },
  { type: '解禁', sign: -1, w: 1.5, re: /(限售股|限售股份).{0,8}(上市流通|解除限售)|解除限售|限售股上市/ },
  { type: '质押', sign: -1, w: 1.5, re: /(股权|股份)?质押|补充质押/ },
  { type: '立案处罚', sign: -1, w: 3.0, re: /(立案|被调查|行政处罚|处罚决定|监管措施|警示函)/ },
  { type: '问询函', sign: -1, w: 1.5, re: /(问询函|关注函|监管函|年报问询)/ },
  { type: '退市风险', sign: -1, w: 3.0, re: /(退市风险|终止上市|可能被实施.{0,6}风险警示)/ },
  { type: '诉讼仲裁', sign: -1, w: 1.5, re: /(诉讼|仲裁)/ },
  { type: '会计差错', sign: -1, w: 2.0, re: /(会计差错|前期差错|追溯重述|财务信息更正)/ },
  { type: '商誉减值', sign: -1, w: 2.0, re: /(商誉减值|计提.{0,8}减值准备|资产减值)/ },
  { type: '违规占用', sign: -1, w: 2.0, re: /(违规|资金占用|非经营性占用|舞弊)/ },
]

/** 命中该标题的全部规则（不去重方向；同一类只计一次）。 */
export function classifyAnn(title) {
  const t = String(title || '')
  if (!t) return []
  const hits = []
  const seen = new Set()
  for (const r of ANN_RULES) {
    if (seen.has(r.type)) continue
    if (r.re.test(t)) {
      seen.add(r.type)
      hits.push(r)
    }
  }
  return hits
}

/** 单条公告的事件净分（正=利好，负=利空，0=无有效事件）。 */
export function scoreAnnItem(item) {
  let s = 0
  for (const h of classifyAnn(item?.title)) s += h.sign * h.w
  return s
}

/** [day-(n-1) … day] 的连续日期（YYYY-MM-DD，北京时间）。 */
export function prevDays(day, n) {
  const out = []
  const base = Date.parse(`${day}T12:00:00+08:00`)
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(base - i * DAY_MS)
    out.push(d.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }))
  }
  return out
}

/**
 * 某评估日 D 的个股事件净分：回看 `windowDays` 天（含 D）的公告归档，按 code 累加。
 * 返回 `Map<code(6位), score>`；只保留已上市 A 股（6 位数字代码）。无事件不出现。
 */
export async function eventScores(dataDir, day, { windowDays = 5 } = {}) {
  const limit = Date.parse(`${day}T23:59:59+08:00`)
  const acc = new Map()
  for (const d of prevDays(day, windowDays)) {
    const items = await readJson(path.join(dataDir, 'ann-archive', `${d}.json`), [])
    for (const it of Array.isArray(items) ? items : []) {
      if (it?.time && it.time > limit) throw new Error(`未来数据泄漏：公告 ${it.time} > ${day}`)
      const s = scoreAnnItem(it)
      if (!s) continue
      const codes = Array.isArray(it.codes) && it.codes.length ? it.codes : it.code ? [it.code] : []
      for (const c of codes) {
        const code = String(c)
        if (!/^\d{6}$/.test(code)) continue
        acc.set(code, (acc.get(code) || 0) + s)
      }
    }
  }
  return acc
}
