import { useCallback, useEffect, useState } from 'react'
import { fetchKline, fetchQuotes, fetchStockNews } from '../api'
import { fmtAmount, fmtCap, fmtNum, fmtSigned, fmtVolume, trendClass } from '../format'
import KLineChart from './KLineChart'
import NewsList from './NewsList'
import AiPanel from './AiPanel'
import SourceBadge from './SourceBadge'
import type { Bar, Kline, NewsItem, Quote, Selection } from '../types'

const PERIODS = [
  { key: 'm1', label: '分时' },
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

/** 单页根数（东财单次硬顶 600）与累计上限（≈12 年，防内存膨胀）。 */
const KLINE_PAGE = 600
const KLINE_MAX = 3000

/** K 线按时间戳取「前一个自然日」的 YYYYMMDD，作为往前翻页的 end 游标。 */
function prevDay(time: string): string {
  const d = new Date(`${time.slice(0, 10)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10).replace(/-/g, '')
}

export default function DetailView({
  selection,
  period: periodProp,
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
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  // 分时（m1）仅 A 股：港/美股若带着 m1 进来（会话状态残留），就地退回日K。
  const period = selection.market === 'cn' || periodProp !== 'm1' ? periodProp : 'd'
  const intraday = period.startsWith('m') && period !== 'm'
  const timeshare = period === 'm1'
  const periods = selection.market === 'cn' ? PERIODS : PERIODS.filter((p) => p.key !== 'm1')

  useEffect(() => {
    if (periodProp === 'm1' && selection.market !== 'cn') onPeriod('d')
  }, [periodProp, selection.market, onPeriod])

  useEffect(() => {
    const ac = new AbortController()
    setErr('')
    setKline(null)
    setHasMore(false)
    fetchKline(selection.secid, period, intraday ? 480 : KLINE_PAGE, ac.signal)
      .then((k) => {
        setKline(k)
        // 分钟线不做往前翻页；日/周/月拿满一页说明可能还有更早的。
        setHasMore(!intraday && k.bars.length >= KLINE_PAGE)
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === 'AbortError') return
        setErr(e instanceof Error ? e.message : 'K 线加载失败')
      })
    return () => ac.abort()
  }, [selection.secid, period, intraday])

  // 往前翻页：以「最早一根的前一日」为 end 游标再拉一页，prepend 到现有 bars 前。
  const loadMore = useCallback(() => {
    if (intraday || loadingMore || !hasMore || !kline?.bars.length) return
    const oldest = kline.bars[0]?.time
    if (!oldest) return
    setLoadingMore(true)
    fetchKline(selection.secid, period, KLINE_PAGE, undefined, prevDay(oldest))
      .then((page) => {
        const seen = new Set(kline.bars.map((b) => b.time))
        const older = page.bars.filter((b) => !seen.has(b.time))
        const merged = [...older, ...kline.bars]
        const bars = merged.length > KLINE_MAX ? merged.slice(merged.length - KLINE_MAX) : merged
        setKline({ ...kline, bars })
        setHasMore(older.length > 0 && page.bars.length >= KLINE_PAGE && bars.length < KLINE_MAX)
      })
      .catch(() => setHasMore(false))
      .finally(() => setLoadingMore(false))
  }, [intraday, loadingMore, hasMore, kline, selection.secid, period])

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
        {periods.map((p) => (
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
        <div className="kline-wrap">
          <KLineChart
            bars={kline.bars}
            market={selection.market}
            intraday={intraday}
            timeshare={timeshare}
            prevClose={quote?.prevClose ?? null}
            onLoadMore={loadMore}
            hasMore={hasMore}
            loadingMore={loadingMore}
          />
          {!intraday && loadingMore && <div className="kline-more">正在加载更早的 K 线…</div>}
          {!intraday && !hasMore && kline.bars.length > KLINE_PAGE && (
            <div className="kline-more dim">已到最早（{kline.bars.length} 根）</div>
          )}
        </div>
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