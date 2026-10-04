import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { interpret } from '../api'
import { reportAiState } from '../aiStatus'
import {
  extractVerdict,
  Highlighted,
  sectionTone,
  type Tone,
} from '../lib/aiHighlight'
import type { AiUsage } from '../types'

/**
 * 模型回的是 markdown（`**走势结构**`、有序列表、表格…），之前当纯文本塞进
 * div，用户看到的是一堆星号。渲染方式跟主站聊天组件一致：
 * `react-markdown` + `remark-gfm`，**不开 `rehype-raw`** —— 不渲染原始 HTML，
 * 于是不需要 dangerouslySetInnerHTML，也就没有 XSS 面。
 */
const mdComponents: Components = {
  a({ node, ...props }) {
    void node
    return <a {...props} target="_blank" rel="noreferrer noopener" />
  },
  // 正文里的结论词和量化指标统一走高亮，标题额外挂语义分类（短期/中期/长期…）
  p: ({ children, ...props }) => (
    <p {...props}>
      <Highlighted>{children}</Highlighted>
    </p>
  ),
  li: ({ children, ...props }) => (
    <li {...props}>
      <Highlighted>{children}</Highlighted>
    </li>
  ),
  td: ({ children, ...props }) => (
    <td {...props}>
      <Highlighted>{children}</Highlighted>
    </td>
  ),
  th: ({ children, ...props }) => (
    <th {...props}>
      <Highlighted>{children}</Highlighted>
    </th>
  ),
  strong: ({ children, ...props }) => (
    <strong {...props}>
      <Highlighted>{children}</Highlighted>
    </strong>
  ),
  h2: ({ children, ...props }) => <SectionHeading tag="h2" {...props}>{children}</SectionHeading>,
  h3: ({ children, ...props }) => <SectionHeading tag="h3" {...props}>{children}</SectionHeading>,
}

function SectionHeading({
  tag,
  children,
  ...props
}: { tag: 'h2' | 'h3' } & React.ComponentPropsWithoutRef<'h2'>) {
  const sec = sectionTone(children)
  const Tag = tag
  return (
    <Tag
      {...props}
      className={sec ? `ai-sec ai-sec-${sec.tone}` : undefined}
      data-sec={sec?.tag}
    >
      <Highlighted>{children}</Highlighted>
    </Tag>
  )
}

/**
 * 整体结论横幅：把 AI 最后定的「看多 / 中性 / 看空」提到最上面，长文里不用自己找。
 *
 * label 写「整体结论」而不是「结论」，是为了和正文里的 `## 结论` 小节区分开：
 * 横幅给的是**综合所有分项之后**的定论，正文那个小节是同一句话的落点，
 * 两个都叫「结论」会让人以为是两个不同的判断。
 */
function VerdictBanner({ tone, label }: { tone: Tone; label: string }) {
  const hint: Record<Tone, string> = {
    up: '偏多 —— 风险收益比相对有利，仍需设止损',
    down: '偏空 —— 上行空间受限，注意控制仓位',
    flat: '中性 —— 缺乏明确方向，等待信号',
  }
  return (
    <div className={`ai-verdict is-${tone}`}>
      <span className="ai-verdict-label">整体结论</span>
      <strong className="ai-verdict-word">{label}</strong>
      <span className="ai-verdict-hint">{hint[tone]}</span>
    </div>
  )
}

interface Props {
  secid: string
  name: string
  enabled: boolean
}

const PRESETS = [
  '短期该怎么操作？',
  '中长期的逻辑是什么？',
  '主要风险在哪？',
]

export default function AiPanel({ secid, name, enabled }: Props) {
  const [question, setQuestion] = useState('')
  const [out, setOut] = useState('')
  const [usage, setUsage] = useState<AiUsage | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  // 结论横幅跟着流式输出实时出现：模型一旦吐出「看多」就顶上，不用等全文结束
  const verdict = useMemo(() => extractVerdict(out), [out])

  useEffect(() => () => abortRef.current?.abort(), [])

  // 换标的时清掉上一份解读
  useEffect(() => {
    abortRef.current?.abort()
    setOut('')
    setUsage(null)
    setErr('')
    setBusy(false)
  }, [secid])

  /*
   * 挂载 / enabled 变化时把本源报成 idle，**绝不报 blocked**。
   * 「站长还没配 Key」不是需要人介入的阻塞 —— 访客压根没要求 AI 解读，若报 blocked，
   * 主站那盏灯会被推成紫色「需要你」并播「权限请求来啦」语音，打开任意个股详情就中招。
   * blocked 留给真阻塞：限流 429、上游鉴权失败。
   * 顺带清掉上一轮残留的 thinking/working（面板随 DetailView 重挂载）。
   */
  useEffect(() => {
    reportAiState('idle')
  }, [enabled])

  const run = async (q: string) => {
    if (busy) return
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setBusy(true)
    setErr('')
    setOut('')
    setUsage(null)
    reportAiState('thinking', name)
    await interpret(
      { secid, name, question: q },
      {
        onDelta: (t) => {
          setOut((prev) => prev + t)
          reportAiState('working', name)
        },
        onDone: (text, u) => {
          setOut(text)
          setUsage(u)
          setBusy(false)
          reportAiState('success', name)
        },
        onError: (m) => {
          setErr(m)
          setBusy(false)
          reportAiState('error', m)
        },
      },
      ac.signal,
    )
  }

  if (!enabled) {
    return (
      <div className="ai-panel">
        <div className="note">AI 解读未启用。{''}</div>
      </div>
    )
  }

  return (
    <div className="ai-panel">
      <div className="ai-head">
        <span className="ai-title">AI 解读</span>
        <div className="ai-presets">
          {PRESETS.map((p) => (
            <button key={p} className="chip" disabled={busy} onClick={() => void run(p)}>
              {p}
            </button>
          ))}
        </div>
      </div>
      <div className="ai-ask">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy) void run(question)
          }}
          placeholder="想问点别的？回车发送"
          aria-label="提问"
        />
        {busy ? (
          <button className="btn" onClick={() => abortRef.current?.abort()}>
            停止
          </button>
        ) : (
          <button className="btn primary" onClick={() => void run(question)}>
            解读
          </button>
        )}
      </div>
      {err && <div className="note err">{err}</div>}
      {out && (
        <>
          {verdict && <VerdictBanner tone={verdict.tone} label={verdict.label} />}
          {/* ai-md 管排版；外层保留 .ai-out 的边框/滚动/上限 */}
          <div className="ai-out ai-md">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
              {out}
            </ReactMarkdown>
          </div>
          {usage && (
            <div className="ai-usage">
              tokens ↑{usage.input} ↓{usage.output}
            </div>
          )}
        </>
      )}
    </div>
  )
}