import { useEffect, useState } from 'react'
import { fetchBoards, fetchQuotes } from '../api'
import { fmtNum, fmtSigned, trendClass } from '../format'
import type { Board, BoardKind, Market, Quote, Selection, WatchItem } from '../types'

interface Props {
  market: Exclude<Market, 'fund'>
  watchlist: WatchItem[]
  quotes: Record<string, Quote>
  onPick: (s: Selection) => void
  onRemove: (item: WatchItem) => void
}

/** 侧栏：自选股（含实时行情）+ 行业/概念板块榜。 */
export default function Sidebar({ market, watchlist, quotes, onPick, onRemove }: Props) {
  const [kind, setKind] = useState<BoardKind>('industry')
  const [boards, setBoards] = useState<Board[]>([])
  const [err, setErr] = useState('')

  const list = watchlist.filter((w) => (market === 'us' ? w.market === 'us' : w.market !== 'us'))

  useEffect(() => {
    const ac = new AbortController()
    setErr('')
    fetchBoards(kind, 16, ac.signal)
      .then((r) => setBoards(r.items))
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === 'AbortError') return
        setErr(e instanceof Error ? e.message : '板块加载失败')
      })
    return () => ac.abort()
  }, [kind])

  return (
    <aside className="side">
      <section className="side-block">
        <h3 className="side-title">自选（{list.length}）</h3>
        {list.length === 0 && <div className="note">还没有自选。在详情页点「加自选」。</div>}
        <ul className="watch">
          {list.map((w) => {
            const q = quotes[w.secid]
            const pct = q?.changePct ?? null
            return (
              <li key={w.secid} className={trendClass(pct, market)}>
                <button
                  className="watch-main"
                  onClick={() =>
                    onPick({
                      kind: 'stock',
                      secid: w.secid,
                      code: w.code,
                      name: w.name,
                      market,
                    })
                  }
                >
                  <span className="watch-name">{w.name}</span>
                  <span className="watch-code dim">{w.code}</span>
                  <span className="watch-px">{fmtNum(q?.price ?? null, 2)}</span>
                  <span className="watch-pct">{fmtSigned(pct, 2, '%')}</span>
                </button>
                <button className="watch-del" title="移除" onClick={() => onRemove(w)}>
                  ×
                </button>
              </li>
            )
          })}
        </ul>
      </section>

      <section className="side-block">
        <div className="side-head">
          <h3 className="side-title">板块</h3>
          <div className="mini-tabs">
            <button className={`chip${kind === 'industry' ? ' on' : ''}`} onClick={() => setKind('industry')}>
              行业
            </button>
            <button className={`chip${kind === 'concept' ? ' on' : ''}`} onClick={() => setKind('concept')}>
              概念
            </button>
          </div>
        </div>
        {err && <div className="note err small">{err}</div>}
        <ul className="boards">
          {boards.map((b, i) => (
            <li key={b.code}>
              <button
                className="board-row"
                title="按板块名检索相关个股"
                onClick={() => onPick({ kind: 'stock', secid: b.secid, code: b.code, name: b.name, market })}
              >
                <span className="board-rank">{i + 1}</span>
                <span className="board-name">{b.name}</span>
                <span className="board-leader dim">{b.leader ?? ''}</span>
                <span className={`board-pct ${trendClass(b.changePct, 'cn')}`}>
                  {fmtSigned(b.changePct, 2, '%')}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="note small">板块成分股接口暂不可用，点击板块会按板块名检索相关个股。</div>
      </section>
    </aside>
  )
}

/** 自选股行情批量刷新（App 侧用）。 */
export async function loadWatchQuotes(items: WatchItem[]): Promise<Record<string, Quote>> {
  const stockIds = items.filter((i) => i.kind !== 'fund').map((i) => i.secid)
  if (!stockIds.length) return {}
  try {
    const { items: quotes } = await fetchQuotes(stockIds)
    return Object.fromEntries(quotes.map((q) => [q.secid, q]))
  } catch {
    return {}
  }
}