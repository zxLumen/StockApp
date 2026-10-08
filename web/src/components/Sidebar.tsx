import { fetchQuotes } from '../api'
import { fmtNum, fmtSigned, trendClass } from '../format'
import type { Market, Quote, Selection, WatchItem } from '../types'

interface Props {
  market: Exclude<Market, 'fund' | 'board' | 'pick' | 'positions'>
  watchlist: WatchItem[]
  quotes: Record<string, Quote>
  onPick: (s: Selection) => void
  onRemove: (item: WatchItem) => void
}

/**
 * 侧栏：自选股（含实时行情）。
 *
 * 板块榜原来也在这块，但它已经是顶级页签了（主区的 BoardHome），这里再放一份
 * 只会让人误以为是两套数据 —— 所以整块搬走了。
 */
export default function Sidebar({ market, watchlist, quotes, onPick, onRemove }: Props) {
  const list = watchlist.filter((w) => (market === 'us' ? w.market === 'us' : w.market !== 'us'))

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