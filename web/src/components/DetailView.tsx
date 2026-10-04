import { useEffect, useState } from 'react'
import { fetchKline, fetchQuotes, fetchStockNews } from '../api'
import { fmtAmount, fmtCap, fmtNum, fmtSigned, fmtVolume, trendClass } from '../format'
import KLineChart from './KLineChart'
import NewsList from './NewsList'
import AiPanel from './AiPanel'
import SourceBadge from './SourceBadge'
import type { Bar, Kline, NewsItem, Quote, Selection } from '../types'

const PERIODS = [
  { key: 'd', label: '日K' },
  { key: 'w', label: '周K' },
  { key: 'm', label: '月K' },
  { key: 'm60', label: '60分' },
  { key: 'm30', label: '30分' },
  { key: 'm15', label: '15分' },
  { key: 'm5', label: '5分' },
]

interface Props {
  selection: Selection
  period: string
  onPeriod: (p: string) => void
  aiEnabled: boolean
  watched: boolean
  onToggleWatch: () => void
  onBack: () => void
}

export default function DetailView({
  selection,
  period,
  onPeriod,
  aiEnabled,
  watched,
  onToggleWatch,
  onBack,
}: Props) {
  const [kline, setKline] = useState<Kline | null>(null)
  const [quote, setQuote] = useState<Quote | null>(null)
  const [news, setNews] = useState<NewsItem[]>([])
  const [err, setErr] = useState('')
  const intraday = period.startsWith('m') && period !== 'm'

  useEffect(() => {
    const ac = new AbortController()
    setErr('')
    setKline(null)
    fetchKline(selection.secid, period, intraday ? 480 : 240, ac.signal)
      .then(setKline)
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === 'AbortError') return
        setErr(e instanceof Error ? e.message : 'K 线加载失败')
      })
    return () => ac.abort()
  }, [selection.secid, period, intraday])

  useEffect(() => {
    const ac = new AbortController()
    fetchQuotes([selection.secid], ac.signal)
      .then((r) => setQuote(r.items[0] ?? null))
      .catch(() => setQuote(null))
    return () => ac.abort()
  }, [selection.secid])

  useEffect(() => {
    const ac = new AbortController()
    fetchStockNews(selection.name, selection.code, ac.signal, selection.market === 'us' ? 'us' : 'cn')
      .then((r) => setNews(r.items))
      .catch(() => setNews([]))
    return () => ac.abort()
  }, [selection.name, selection.code, selection.market])

  const cls = trendClass(quote?.changePct, selection.market)
  const last: Bar | undefined = kline?.bars[kline.bars.length - 1]

  return (
    <div className="detail">
      <div className="detail-head">
        <button className="link" onClick={onBack}>
          ← 返回
        </button>
        <div className="detail-id">
          <h2>{selection.name}</h2>
          <span className="dim">{selection.code}</span>
          <SourceBadge source={kline?.source} label={kline?.sourceLabel} />
        </div>
        <div className={`detail-price ${cls}`}>
          <span className="px">{fmtNum(quote?.price ?? last?.close ?? null, 2)}</span>
          <span className="chg">
            {fmtSigned(quote?.change ?? last?.change ?? null, 2)} ({fmtSigned(quote?.changePct ?? last?.changePct ?? null, 2, '%')})
          </span>
        </div>
        <button className={`btn${watched ? ' on' : ''}`} onClick={onToggleWatch}>
          {watched ? '★ 已自选' : '☆ 加自选'}
        </button>
      </div>

      {quote && (
        <div className="facts">
          <span>今开 {fmtNum(quote.open)}</span>
          <span>昨收 {fmtNum(quote.prevClose)}</span>
          <span>最高 {fmtNum(quote.high)}</span>
          <span>最低 {fmtNum(quote.low)}</span>
          <span>成交量 {fmtVolume(quote.volume)}</span>
          <span>成交额 {fmtAmount(quote.amount)}</span>
          <span>换手 {fmtNum(quote.turnover)}%</span>
          <span>总市值 {fmtCap(quote.marketCap)}</span>
        </div>
      )}

      <div className="periods">
        {PERIODS.map((p) => (
          <button
            key={p.key}
            className={`chip${period === p.key ? ' on' : ''}`}
            onClick={() => onPeriod(p.key)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {err && <div className="note err">{err}</div>}
      {kline ? (
        <KLineChart bars={kline.bars} market={selection.market} intraday={intraday} />
      ) : (
        !err && <div className="kline-box skeleton" style={{ height: 380 }} aria-hidden />
      )}

      <AiPanel secid={selection.secid} name={selection.name} enabled={aiEnabled} />

      <section>
        <h3 className="sec-title">相关热点</h3>
        {/* key 挂 secid：换标的时展开状态回到折叠，别把上一只票的展开带过来 */}
        <NewsList key={selection.secid} items={news} />
      </section>
    </div>
  )
}