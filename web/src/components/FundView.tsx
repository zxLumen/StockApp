import { useEffect, useRef, useState } from 'react'
import { ColorType, LineSeries, createChart, type IChartApi, type Time } from 'lightweight-charts'
import { fetchFundNav } from '../api'
import { fmtNum, fmtSigned, trendClass } from '../format'
import type { FundNavPoint, Selection } from '../types'

interface Props {
  selection: Selection
  watched: boolean
  onToggleWatch: () => void
  onBack: () => void
}

/** 场外基金：净值曲线。东财只提供官方净值，没有盘中估算值。 */
export default function FundView({ selection, watched, onToggleWatch, onBack }: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const [nav, setNav] = useState<{ nav: number | null; accNav: number | null; changePct: number | null }>({
    nav: null,
    accNav: null,
    changePct: null,
  })
  const [points, setPoints] = useState<FundNavPoint[]>([])
  const [err, setErr] = useState('')

  useEffect(() => {
    const ac = new AbortController()
    setNav({ nav: null, accNav: null, changePct: null })
    setPoints([])
    setErr('')
    fetchFundNav(selection.code, ac.signal)
      .then((r) => {
        setNav({ nav: r.nav, accNav: r.accNav, changePct: r.changePct })
        setPoints(r.points)
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === 'AbortError') return
        setErr(e instanceof Error ? e.message : '净值加载失败')
      })
    return () => ac.abort()
  }, [selection.code])

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, fontSize: 11 },
      grid: { vertLines: { color: '#1e2532' }, horzLines: { color: '#1e2532' } },
      rightPriceScale: { borderColor: '#262e3d' },
      timeScale: { borderColor: '#262e3d' },
    })
    const line = chart.addSeries(LineSeries, { color: '#4a8ef0', lineWidth: 2, priceLineVisible: false })
    line.setData(points.map((p) => ({ time: p.date as Time, value: p.nav })))
    chart.timeScale().fitContent()
    chartRef.current = chart
    return () => {
      chart.remove()
      chartRef.current = null
    }
  }, [points])

  return (
    <div className="detail">
      <div className="detail-head">
        <button className="link" onClick={onBack}>
          ← 返回
        </button>
        <div className="detail-id">
          <h2>{selection.name}</h2>
          <span className="dim">{selection.code}</span>
        </div>
        <button className={`btn${watched ? ' on' : ''}`} onClick={onToggleWatch}>
          {watched ? '★ 已自选' : '☆ 加自选'}
        </button>
      </div>

      {err && <div className="note err">{err}</div>}

      <div className="facts">
        <span>单位净值 {fmtNum(nav.nav, 4)}</span>
        <span>累计净值 {fmtNum(nav.accNav, 4)}</span>
        <span className={trendClass(nav.changePct, 'fund')}>日涨跌 {fmtSigned(nav.changePct, 2, '%')}</span>
        <span>样本 {points.length} 个交易日</span>
      </div>

      <div ref={boxRef} className="kline-box" style={{ height: 360 }} />
      <div className="note small">
        场外基金按交易日公布净值，非交易时段无「实时估值」。
      </div>
    </div>
  )
}