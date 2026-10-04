/**
 * aiHighlightTokens.js 的类型声明。
 *
 * 高亮规则刻意写成不带类型的 .js —— 这样 `node --test` 能直接 import 它跑测试
 * （项目测试栈是纯 node --test，不带 TS/JSX transform）。代价是 TS 侧看不到类型，
 * 所以在这里补一份声明。两边必须同步改：token 的 `tone` 只有这几种。
 */

export type Tone = 'up' | 'down' | 'flat' | 'num'

export interface Verdict {
  /** 匹配用的正则源串（不含分隔符） */
  re: string
  tone: 'up' | 'down' | 'flat'
  /** 顶部横幅上显示的中文标签 */
  label: string
}

export interface Token {
  type: 'text' | 'verdict' | 'num'
  /** 原文片段；拼起来必须等于输入（高亮不能吃掉字符） */
  value: string
  tone: Tone
  /** 仅 verdict：命中的倾向词 */
  label?: string
  /** 仅 num：是否带 + / - 符号 */
  signed?: boolean
}

export interface SectionDef {
  re: string
  tone: string
  tag: string
}

export declare const VERDICTS: Verdict[]
export declare const SECTION_DEFS: SectionDef[]

/** 把文本切成 普通片段 / 结论词 / 量化指标 三类片段。 */
export declare function tokenize(text: unknown): Token[]

/** 小标题语义分类，命中即返回 `{ tone, tag }`，没命中返回 null。 */
export declare function sectionOf(text: unknown): { tone: string; tag: string } | null

/** 抓整段输出里第一个倾向词；没有则返回 null。 */
export declare function extractVerdict(md: unknown): { tone: 'up' | 'down' | 'flat'; label: string } | null
