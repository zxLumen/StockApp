import { useEffect, useState } from 'react'
import { fetchIndices, fetchMarketNews } from '../api'
import MiniKline from './MiniKline'
import SourceBadge from './SourceBadge'
import { fmtSigned, fmtTime, trendClass } from '../format'
import type { Market, NewsItem, Quote, Selection } from '../types'

interface Props {
  market: Exclude<Market, 'fund'>
  onPick: (s: Selection) => void
}

/** 沪 / 深 / 港三条日K，加三大指数快照。 */
const MINI = [
  { secid: '1.000001', name: '沪·上证指数' },
  { secid: '0.399001', name: '深·深证成指' },
  { secid: '100.HSI', name: '港·恒生指数' },
]

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

      {market === 'cn' && (
        <section>
          <h2 className="sec-title">沪 / 深 / 港 走势（日K）</h2>
          <div className="mini-grid">
            {MINI.map((m) => (
              <button
                key={m.secid}
                className="mini-card"
                onClick={() =>
                  onPick({ kind: 'stock', secid: m.secid, code: '', name: m.name.split('·')[1], market })
                }
              >
                <MiniKline secid={m.secid} name={m.name} up="#e0454b" down="#12a05c" />
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="sec-title">当日热点新闻</h2>
        <ul className="news">
          {news.map((n, i) => (
            <li key={`${n.url ?? n.title}-${i}`}>
              <a href={n.url ?? '#'} target="_blank" rel="noreferrer noopener">
                <span className="news-title">{n.title}</span>
                <span className="news-meta">
                  {n.source}
                  {n.time ? ` · ${fmtTime(n.time)}` : ''}
                </span>
              </a>
            </li>
          ))}
          {loading && news.length === 0 && <li className="skeleton-row" aria-hidden />}
          {!loading && news.length === 0 && (
            <li className="note err">{newsErr ? `新闻暂不可用：${newsErr}` : '暂无新闻'}</li>
          )}
        </ul>
      </section>
    </div>
  )
}