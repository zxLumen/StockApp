/**
 * AI 解读高亮的**分词规则**（纯函数，无 JSX / 无 React）。
 *
 * 单独拆出来是为了能被 `node --test` 直接测 —— 渲染层（aiHighlight.tsx）
 * 依赖 react-markdown，测不了；高亮的对错全在这几条规则上。
 *
 * 设计取舍：
 *   - 结论词只收「明确的判断词」（看多/看空/中性），**不收** 机会/风险/谨慎 ——
 *     那几个词在正文里出现频率极高，全高亮会把重点淹掉。
 *   - 量化指标要求「数字 + 单位」，裸数字不认：MA5=16834.01 是均线值不是「指标形态」，
 *     全染一遍反而看不清真正的涨跌幅和目标位。
 *   - 不收 `年`：`2026年` 会整段变蓝，纯噪音。
 */

/** 倾向词。顺序即优先级：先匹配的赢。 */
export const VERDICTS = [
  { re: '看多|看好|偏多|看涨', tone: 'up', label: '看多' },
  { re: '看空|看坏|偏空|看跌', tone: 'down', label: '看空' },
  { re: '中性|震荡', tone: 'flat', label: '中性' },
]

/**
 * 量化指标：数字 + 单位。
 *
 * 两个坑：
 *  1. 长单位必须排在短单位前面，否则 `个月` 被 `万` 抢走、`个点` 被 `点` 抢走（正则左优先）。
 *  2. **必须能吃区间**：`13932-14500点` 里那个 `-` 是区间连接符，不是负号。
 *     如果只把 `[+-]?` 放在数字前，`-14500点` 会被当成「跌 14500 点」染成绿色，
 *     而 `1-2 倍` 会变成「跌 2 倍」—— 正好把意思说反。所以区间整体当成一个 token，
 *     并且判定涨跌方向时跳过带区间的。
 */
const NUM = String.raw`\d+(?:\.\d+)?`
const METRIC = `(?:[+-]?${NUM})(?:\\s*[-~]\\s*(?:[+-]?${NUM}))?\\s*(?:个交易日|交易日|万亿元|亿元|万元|万手|亿手|万亿|亿|万|个点|点|%|％|倍|元|手)`

/**
 * 纯时间单位**故意不收**：`1-2 周`、`3 个月`、`2 天` 是时间跨度，不是「量化指标」。
 * 高亮它们只会把真正的点位/涨跌幅淹掉（时间跨度已经由小标题的 短期/中期/长期 标签表达了）。
 *
 * 另外 `亿元` / `万亿元` / `万手` / `亿手` 必须单列：否则正则左优先只吃到 `亿` / `万`，
 * chip 里显示成「4.78亿」而「元」漏成普通文字，看着像渲染坏了。
 */

/** token 里含「数字 - 数字」就是区间，不按涨跌染色。 */
const RANGE_RE = /\d\s*[-~]\s*\d/

const TOKEN_RE = new RegExp(
  `(${VERDICTS.map((v) => v.re).join('|')})|(${METRIC})`,
  'g',
)

/** 命中的究竟是哪个倾向词 —— `m[1]` 是匹配到的**文本**，不是 VERDICTS[i].re。 */
function toneOfVerdict(matched) {
  const hit = VERDICTS.find((v) => new RegExp(`^(?:${v.re})$`).test(matched))
  return hit ? hit.tone : 'flat'
}

/** @returns 依次为普通文本 / 结论词 / 量化指标的片段，顺序与输入一致。 */
export function tokenize(text) {
  const src = String(text ?? '')
  if (!src) return []
  const out = []
  let last = 0
  TOKEN_RE.lastIndex = 0
  let m
  while ((m = TOKEN_RE.exec(src)) !== null) {
    if (m.index > last) out.push({ type: 'text', value: src.slice(last, m.index) })
    if (m[1]) {
      out.push({ type: 'verdict', value: m[0], tone: toneOfVerdict(m[1]), label: m[1] })
    } else {
      // 带符号的按涨跌染色；区间和无符号（3 个月 / 1.5 倍）保持中性底色
      const signed = !RANGE_RE.test(m[2]) && /^[+-]/.test(m[2])
      const tone = signed ? (m[2].startsWith('-') ? 'down' : 'up') : 'num'
      out.push({ type: 'num', value: m[0], tone, signed })
    }
    last = m.index + m[0].length
  }
  if (last < src.length) out.push({ type: 'text', value: src.slice(last) })
  return out
}

/** 小标题的语义分类，命中第一条即返回（顺序 = 优先级）。 */
export const SECTION_DEFS = [
  { re: '短期|1\\s*[-~]\\s*2\\s*周', tone: 'short', tag: '短期' },
  { re: '中期|1\\s*[-~]\\s*3\\s*个?月', tone: 'mid', tag: '中期' },
  { re: '长期|6\\s*[-~]\\s*12\\s*个?月', tone: 'long', tag: '长期' },
  { re: '结论|判断', tone: 'verdict', tag: '结论' },
  { re: '风险', tone: 'risk', tag: '风险' },
]

export function sectionOf(text) {
  const t = String(text ?? '')
  const hit = SECTION_DEFS.find((s) => new RegExp(s.re).test(t))
  return hit ? { tone: hit.tone, tag: hit.tag } : null
}

/**
 * 抓整段输出里的倾向判断，给顶部「整体结论」横幅用。抓不到返回 null（不硬凑）。
 *
 * 这里踩过一个很坑的 bug：原来写成「按 VERDICTS 数组顺序扫全文，谁的**类别**先命中
 * 就返回」，而 VERDICTS 的第一项是看多。于是当 `## 结论` 段老实写了「中性」、
 * 但后面的短期/中期段里出现了「偏多」时，横幅会报「看多」—— 和 AI 自己的结论打架。
 *
 * 判据必须是**位置**而不是**类别优先级**，而且要看结论小节：
 *   1. 先定位 `## 结论` 小节，只在里面按位置取第一个倾向词 —— 那是 AI 综合完
 *      所有分项后的定论，正是横幅要表达的东西；
 *   2. 模型没按格式输出（没有结论小节）才回退到全文第一个倾向词；
 *   3. 全文都没有就返回 null。
 */
export function extractVerdict(md) {
  const src = String(md ?? '')
  if (!src) return null

  const inConclusion = sectionBody(src, /结论/)
  for (const scope of [inConclusion, src]) {
    if (!scope) continue
    const hit = firstVerdict(scope)
    if (hit) return hit
  }
  return null
}

/** 全文里**位置最靠前**的倾向词（类别优先级在这里不参与）。 */
function firstVerdict(text) {
  let best = null
  for (const v of VERDICTS) {
    const m = new RegExp(v.re).exec(text)
    if (m && (best === null || m.index < best.index)) {
      best = { index: m.index, tone: v.tone, label: v.label }
    }
  }
  return best ? { tone: best.tone, label: best.label } : null
}

/**
 * 取出 `## 某个标题` 小节的正文（不含标题本身）。
 * 标题里带序号 / 空格 / 加粗都能认；只认 `##`~`####`，避免把正文里的行内 `#` 当标题。
 */
function sectionBody(md, titleRe) {
  const lines = String(md ?? '').split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const m = /^#{2,4}\s*(.+?)\s*$/.exec(lines[i])
    if (m && titleRe.test(stripMarkdown(m[1]))) {
      start = i + 1
      break
    }
  }
  if (start < 0) return null
  const body = []
  for (let i = start; i < lines.length; i++) {
    if (/^#{2,4}\s/.test(lines[i])) break
    body.push(lines[i])
  }
  return body.join('\n')
}

/** 标题里可能带 `**` / `【】` / 序号，比较前先剥掉。 */
function stripMarkdown(s) {
  return String(s ?? '')
    .replace(/[*_`【】[\]]/g, '')
    .replace(/^[（(]?\d+[）).、]/, '')
    .trim()
}
