import { useCallback, useEffect, useMemo, useState } from 'react'
import MarketTabs from './components/MarketTabs'
import SearchBox from './components/SearchBox'
import HomeView from './components/HomeView'
import DetailView from './components/DetailView'
import FundView from './components/FundView'
import Sidebar from './components/Sidebar'
import SettingsPanel from './components/SettingsPanel'
import { addWatch, fetchStatus, fetchWatchlist, removeWatch, fetchQuotes } from './api'
import { useSessionState } from './sessionState'
import type { Market, Quote, Selection, WatchItem } from './types'

interface Status {
  owner: boolean
  visitorAi: boolean
  ai: { enabled: boolean; hasKey: boolean; model: string; provider: string }
  providers: { id: string; label: string }[]
}

const watchKey = (s: Selection) => (s.kind === 'fund' ? s.code : s.secid)

/** 页签分桶：沪深港一个桶、美股一个桶、基金一个桶。 */
const bucket = (m: Market) => (m === 'us' ? 'us' : m === 'fund' ? 'fund' : 'cn')

export default function App() {
  const [market, setMarket] = useSessionState<Market>('market', 'cn')
  const [selection, setSelection] = useSessionState<Selection | null>('selection', null)
  const [period, setPeriod] = useSessionState('period', 'd')
  const [watchlist, setWatchlist] = useState<WatchItem[]>([])
  const [quotes, setQuotes] = useState<Record<string, Quote>>({})
  const [status, setStatus] = useState<Status | null>(null)
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    fetchStatus().then(setStatus).catch(() => setStatus(null))
    fetchWatchlist()
      .then((r) => setWatchlist(r.items))
      .catch(() => setWatchlist([]))
  }, [])

  // 自选股行情定时刷新（盘中才有意义，20s 一次足够）
  useEffect(() => {
    const ids = watchlist.filter((w) => w.kind !== 'fund').map((w) => w.secid)
    if (!ids.length) {
      setQuotes({})
      return
    }
    let stop = false
    const tick = async () => {
      try {
        const r = await fetchQuotes(ids)
        if (!stop) setQuotes(Object.fromEntries(r.items.map((q) => [q.secid, q])))
      } catch {
        /* 静默：保留上一次行情 */
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 20_000)
    return () => {
      stop = true
      clearInterval(timer)
    }
  }, [watchlist])

  /** 切页签时，若当前详情不属于新页签就退回该页签的落地页。 */
  const changeMarket = useCallback(
    (m: Market) => {
      setMarket(m)
      setSelection((sel) => (sel && bucket(sel.market) !== bucket(m) ? null : sel))
    },
    [setMarket, setSelection],
  )

  const pick = useCallback(
    (s: Selection) => {
      setSelection(s)
      setMarket(s.market)
    },
    [setSelection, setMarket],
  )

  const watched = useMemo(
    () => (selection ? watchlist.some((w) => w.secid === watchKey(selection)) : false),
    [watchlist, selection],
  )

  const toggleWatch = useCallback(async () => {
    if (!selection) return
    const key = watchKey(selection)
    try {
      if (watched) {
        const r = await removeWatch(key)
        setWatchlist(r.items)
      } else {
        const r = await addWatch({
          secid: key,
          code: selection.code,
          name: selection.name,
          kind: selection.kind,
          market: selection.market,
        })
        setWatchlist(r.items)
      }
    } catch {
      /* 失败时不做乐观更新，等下次刷新纠正 */
    }
  }, [selection, watched])

  const removeFromWatch = useCallback(async (item: WatchItem) => {
    try {
      const r = await removeWatch(item.secid)
      setWatchlist(r.items)
    } catch {
      /* 同上 */
    }
  }, [])

  const stockMarket = market === 'us' ? 'us' : 'cn'
  const showStockDetail = market !== 'fund' && selection?.kind === 'stock'
  const showFundDetail = market === 'fund' && selection?.kind === 'fund'
  const fundWatch = watchlist.filter((w) => w.kind === 'fund')

  return (
    <div className="app">
      <header className="top">
        <div className="brand">股票速览</div>
        <MarketTabs value={market} onChange={changeMarket} />
        <div className="top-search">
          <SearchBox market={market} onPick={pick} />
        </div>
        {status?.owner && (
          <button className="btn ghost" title="AI 设置" onClick={() => setShowSettings(true)}>
            ⚙
          </button>
        )}
      </header>

      <div className="body">
        <main className="main">
          {showStockDetail && selection ? (
            <DetailView
              selection={selection}
              period={period}
              onPeriod={setPeriod}
              aiEnabled={status?.ai.enabled ?? false}
              watched={watched}
              onToggleWatch={() => void toggleWatch()}
              onBack={() => setSelection(null)}
            />
          ) : showFundDetail && selection ? (
            <FundView
              selection={selection}
              watched={watched}
              onToggleWatch={() => void toggleWatch()}
            />
          ) : market === 'fund' ? (
            <div className="home">
              <section>
                <h2 className="sec-title">场外基金</h2>
                <div className="note">
                  在上方搜索基金名称或代码（如「沪深300」「000001」），即可查看净值曲线。
                </div>
                {fundWatch.length > 0 && (
                  <ul className="watch wide">
                    {fundWatch.map((w) => (
                      <li key={w.secid}>
                        <button
                          className="watch-main"
                          onClick={() =>
                            pick({
                              kind: 'fund',
                              secid: w.code,
                              code: w.code,
                              name: w.name,
                              market: 'fund',
                            })
                          }
                        >
                          <span className="watch-name">{w.name}</span>
                          <span className="watch-code dim">{w.code}</span>
                        </button>
                        <button className="watch-del" title="移除" onClick={() => void removeFromWatch(w)}>
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          ) : (
            <HomeView market={stockMarket} onPick={pick} />
          )}
        </main>

        {market !== 'fund' && (
          <Sidebar
            market={stockMarket}
            watchlist={watchlist}
            quotes={quotes}
            onPick={pick}
            onRemove={(w) => void removeFromWatch(w)}
          />
        )}
      </div>

      {showSettings && status?.owner && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </div>
  )
}