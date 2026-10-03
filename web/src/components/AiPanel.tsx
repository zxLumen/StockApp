import { useEffect, useRef, useState } from 'react'
import { interpret } from '../api'
import { reportAiState } from '../aiStatus'
import type { AiUsage } from '../types'

interface Props {
  secid: string
  name: string
  enabled: boolean
}

const PRESETS = ['这波走势该怎么理解？', '量价和均线有什么信号？', '主要风险在哪？']

export default function AiPanel({ secid, name, enabled }: Props) {
  const [question, setQuestion] = useState('')
  const [out, setOut] = useState('')
  const [usage, setUsage] = useState<AiUsage | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const abortRef = useRef<AbortController | null>(null)

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
          <div className="ai-out">{out}</div>
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