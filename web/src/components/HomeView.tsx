import { useEffect, useState } from 'react'
import { fetchIndices, fetchMarketNews } from '../api'
import MiniKline from './MiniKline'
import NewsList from './NewsList'
import SourceBadge from './SourceBadge'
import { PALETTE } from './KLineChart'
import { fmtSigned, trendClass } from '../format'
import type { Market, NewsItem, Quote, Selection } from '../types'

interface Props {
  /** 板块 / 推荐是独立页签（BoardHome / PickView），这里只服务沪深港 / 美股。 */
  market: Exclude<Market, 'fund' | 'board' | 'pick' | 'positions'>
  onPick: (s: Selection) => void
}

/**
 * 指数日K。沪深港与美股各一份 —— 美股页以前整段日K都不渲染（这里原先写死
 * `market === 'cn'`），但美股指数日K 是有的（新浪 `.DJI` / `.IXIC` / `.INX`）。
 * `secid` 用东财口径，和 `/api/market/indices` 返回的保持一致。
 */
const MINI: Record<Exclude<Market, 'fund' | 'board' | 'pick' | 'positions'>, { secid: string; name: string }[]> = {
  cn: [
    { secid: '1.000001', name: '沪·上证指数' },
    { secid: '0.399001', name: '深·深证成指' },
    { secid: '100.HSI', name: '港·恒生指数' },
  ],
  us: [
    { secid: '100.DJIA', name: '美·道琼斯' },
    { secid: '100.SPX', name: '美·标普500' },
    { secid: '100.NDX', name: '美·纳斯达克100' },
  ],
}

const MINI_TITLE: Record<Exclude<Market, 'fund' | 'board' | 'pick' | 'positions'>, string> = {
  cn: '沪 / 深 / 港 走势（日K）',
  us: '美股三大指数走势（日K）',
}

/** 默认落地页：迷你 K 线 + 指数快照 + 当日热点新闻。 */
export default function HomeView({ market, onPick }: Props) {
  const [indices, setIndices] = useState<Quote[]>([])
  const [news, setNews] = useState<NewsItem[]>([])
  const [idxErr, setIdxErr] = useState('')
  const [src, setSrc] = useState<{ id?: string; label?: string }>({})
  const [newsErr, setNewsErr] = useState('')
  const [loading, setLoading] = useState(true)

  // 行情和新闻来自不同上游，必须各自独立：一边挂了不能把另一边也拖没。
  // 新闻要跟着 market 走 —— 美股页不能拿沪深港的新闻凑数。
  useEffect(() => {
    const ac = new AbortController()
    setLoading(true)
    setIdxErr('')
    setNewsErr('')
    const idxP = fetchIndices(market, ac.signal)
      .then((r) => {
        setIndices(r.items)
        setSrc({ id: r.source, label: r.sourceLabel })
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === 'AbortError') return
        setIdxErr(e instanceof Error ? e.message : '指数加载失败')
      })
    const newsP = fetchMarketNews(20, ac.signal, market)
      .then((r) => setNews(r.items))
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === 'AbortError') return
        setNewsErr(e instanceof Error ? e.message : '新闻加载失败')
      })
    void Promise.allSettled([idxP, newsP]).then(() => setLoading(false))
    return () => ac.abort()
  }, [market])

  return (
    <div className="home">
      <section>
        <h2 className="sec-title">
          {market === 'us' ? '美股三大指数' : '沪深港主要指数'}
          <SourceBadge source={src.id} label={src.label} />
        </h2>
        {idxErr && <div className="note err">指数暂不可用：{idxErr}</div>}
        <div className="idx-grid">
          {indices.map((it) => (
            <button
              key={it.secid}
              className="idx-card"
              onClick={() =>
                onPick({
                  kind: 'stock',
                  secid: it.secid,
                  code: it.code || '',
                  name: it.name,
                  market,
                })
              }
            >
              <span className="idx-name">{it.name}</span>
              <span className={`idx-price ${trendClass(it.changePct, market)}`}>
                {it.price != null ? it.price.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—'}
              </span>
              <span className={`idx-chg ${trendClass(it.changePct, market)}`}>
                {fmtSigned(it.changePct, 2, '%')} · {fmtSigned(it.change, 2)}
              </span>
            </button>
          ))}
          {loading &&
            indices.length === 0 &&
            [0, 1, 2, 3, 4].map((i) => <div key={i} className="idx-card skeleton" aria-hidden />)}
        </div>
      </section>

      <section>
        <h2 className="sec-title">{MINI_TITLE[market]}</h2>
        <div className="mini-grid">
          {MINI[market].map((m) => (
            <button
              key={m.secid}
              className="mini-card"
              onClick={() =>
                onPick({ kind: 'stock', secid: m.secid, code: '', name: m.name.split('·')[1], market })
              }
            >
              <MiniKline secid={m.secid} name={m.name} up={PALETTE[market].up} down={PALETTE[market].down} />
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="sec-title">当日热点新闻</h2>
        {/* loading / 出错态还留在 ul 里（骨架行和错误行），有内容才交给 NewsList 切片 */}
        {(loading || newsErr) && news.length === 0 ? (
          <ul className="news">
            {loading && <li className="skeleton-row" aria-hidden />}
            {!loading && <li className="note err">{newsErr ? `新闻暂不可用：${newsErr}` : '暂无新闻'}</li>}
          </ul>
        ) : (
          <NewsList key={market} items={news} empty="暂无新闻" />
        )}
      </section>
    </div>
  )
}