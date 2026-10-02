import { useEffect, useState } from 'react'
import { fetchBoardMembers } from '../api'
import { fmtNum, fmtSigned, trendClass } from '../format'
import SourceBadge from './SourceBadge'
import type { BoardMember, Selection } from '../types'

interface Props {
  selection: Selection
  onPick: (s: Selection) => void
  onBack: () => void
}

/** 板块成分股：点板块后展示其成分股，点个股进详情（东财板块接口挂掉时走新浪）。 */
export default function BoardView({ selection, onPick, onBack }: Props) {
  const [items, setItems] = useState<BoardMember[]>([])
  const [source, setSource] = useState<string>()
  const [sourceLabel, setSourceLabel] = useState<string>()
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const ac = new AbortController()
    setLoading(true)
    setErr('')
    fetchBoardMembers(selection.code, selection.name, ac.signal)
      .then((r) => {
        setItems(r.items)
        setSource(r.source)
        setSourceLabel(r.sourceLabel)
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === 'AbortError') return
        setErr(e instanceof Error ? e.message : '成分股加载失败')
      })
      .finally(() => setLoading(false))
    return () => ac.abort()
  }, [selection.code, selection.name])

  return (
    <div className="detail">
      <div className="detail-head">
        <button className="link" onClick={onBack}>
          ← 返回
        </button>
        <div className="detail-id">
          <h2>{selection.name}</h2>
          <span className="dim">板块成分股</span>
          <SourceBadge source={source} label={sourceLabel} />
        </div>
      </div>

      {err && <div className="note err">{err}</div>}
      {loading && !err && <div className="note">加载中…</div>}
      {!loading && !err && items.length === 0 && <div className="note">暂无成分股数据。</div>}

      {items.length > 0 && (
        <ul className="members">
          {items.map((m) => (
            <li key={m.secid}>
              <button
                className="member-row"
                onClick={() =>
                  onPick({ kind: 'stock', secid: m.secid, code: m.code, name: m.name, market: 'cn' })
                }
              >
                <span className="member-name">{m.name}</span>
                <span className="member-code dim">{m.code}</span>
                <span className="member-price">{fmtNum(m.price)}</span>
                <span className={`member-pct ${trendClass(m.changePct, 'cn')}`}>
                  {fmtSigned(m.changePct, 2, '%')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
