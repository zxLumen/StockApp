import { Children, isValidElement, type ReactNode } from 'react'
import {
  extractVerdict as findVerdict,
  SECTION_DEFS,
  tokenize,
} from './aiHighlightTokens'

/**
 * AI 解读的「重点高亮」渲染层。
 *
 * 需求是让投资者**一眼**看到结论和量化指标，纯靠模型把关键词加粗不够 ——
 * 加粗在长段落里很容易被划过去。这里在渲染层做确定性高亮：
 *
 *   1. 结论词（看多 / 看空 / 中性…）→ 彩色胶囊，一眼扫到倾向
 *   2. 量化指标（-2.92% / 16092 点 / 1.5 倍 / 1782 亿）→ 等宽数字，感知「指标形态」
 *
 * 分词规则放在 aiHighlightTokens.js（纯函数、无 JSX，可被 node --test 直接测）；
 * 本文件只负责把 token 变成 DOM。**刻意不开 rehype-raw**：全程没有
 * dangerouslySetInnerHTML，所以没有 XSS 面。
 */
export function highlight(text: string): ReactNode[] {
  return tokenize(text).map((t, i) => {
    if (t.type === 'text') return t.value
    // 指标要同时挂 ai-hl-num：光有 ai-hl-up 会继承结论词那套实心胶囊，
    // 「-0.6%」跟「看空」长得一模一样，读者分不清哪个是结论哪个是数据。
    // 带上 ai-hl-num 后由 styles.css 给出等宽数字 + 按涨跌方向淡染的底色。
    // tone 为 'num'（无符号 / 区间）时 ai-hl-num 本身就够了，别重复挂成 ai-hl-num ai-hl-num。
    const cls =
      t.type === 'num' && t.tone !== 'num'
        ? `ai-hl ai-hl-num ai-hl-${t.tone}`
        : `ai-hl ai-hl-${t.tone}`
    return (
      <mark key={`${i}-${t.value}`} className={cls} data-token={t.value}>
        {t.value}
      </mark>
    )
  })
}

/** 递归取子节点的纯文本（给标题分类用）。 */
export function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children)
  return ''
}

/** 包一层，把字符串子节点换成高亮节点；元素子节点原样透传。 */
export function Highlighted({ children }: { children?: ReactNode }) {
  return <>{Children.map(children, (c) => (typeof c === 'string' ? highlight(c) : c))}</>
}

/** 小标题的语义分类 → 左侧色条 + 角标（短期 / 中期 / 长期 / 结论 / 风险）。 */
export function sectionTone(children: ReactNode): { tone: string; tag: string } | null {
  const t = textOf(children)
  return SECTION_DEFS.find((s) => new RegExp(s.re).test(t)) ?? null
}

export type Tone = 'up' | 'down' | 'flat'

/** 顶部结论横幅：抓整段输出里第一个倾向词，抓不到就不显示（不硬凑）。 */
export function extractVerdict(md: string): { tone: Tone; label: string } | null {
  return findVerdict(md)
}
