import { useEffect, useRef, useState } from 'react'
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from 'lightweight-charts'
import type { Bar } from '../types'

interface Props {
  bars: Bar[]
  market: string
  intraday: boolean
  height?: number
  onHover?: (bar: Bar | null) => void
}

/** 日/周/月线是 'YYYY-MM-DD'（图表按 BusinessDay 解析）；分钟线是 'YYYY-MM-DD HH:mm'，按北京时间转秒。 */
function toTime(raw: string, intraday: boolean): Time {
  if (!intraday) return raw as Time
  const ms = Date.parse(`${raw.replace(' ', 'T')}:00+08:00`)
  if (Number.isFinite(ms)) return (ms / 1000) as Time
  return raw as Time
}

const PALETTE = {
  cn: { up: '#e0454b', down: '#12a05c' },
  us: { up: '#12a05c', down: '#e0454b' },
}

export default function KLineChart({ bars, market, intraday, height = 380, onHover }: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const maRefs = useRef<Record<string, ISeriesApi<'Line'> | null>>({})
  const byTime = useRef(new Map<string, Bar>())
  const hoverRef = useRef(onHover)
  hoverRef.current = onHover
  const [hover, setHover] = useState<Bar | null>(null)

  const colors = market === 'us' ? PALETTE.us : PALETTE.cn

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#8a94a6',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#1e2532' },
        horzLines: { color: '#1e2532' },
      },
      rightPriceScale: { borderColor: '#262e3d', scaleMargins: { top: 0.08, bottom: 0.26 } },
      timeScale: { borderColor: '#262e3d', timeVisible: intraday, secondsVisible: false },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#8a94a6', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#3b4252' },
        horzLine: { color: '#8a94a6', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#3b4252' },
      },
      localization: { locale: 'zh-CN' },
    })
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: colors.up,
      downColor: colors.down,
      borderVisible: false,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
      priceLineVisible: true,
      priceLineColor: '#8a94a6',
    })
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      priceLineVisible: false,
      lastValueVisible: false,
    })
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } })

    const maStyles: [string, string][] = [
      ['ma5', '#e8a33d'],
      ['ma10', '#4a8ef0'],
      ['ma20', '#86efac'],
    ]
    for (const [key, color] of maStyles) {
      maRefs.current[key] = chart.addSeries(LineSeries, {
        color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      })
    }

    chart.subscribeCrosshairMove((param) => {
      const bar = param.time ? (byTime.current.get(String(param.time)) ?? null) : null
      setHover(bar)
      hoverRef.current?.(bar)
    })

    chartRef.current = chart
    candleRef.current = candle
    volumeRef.current = volume
    return () => {
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      volumeRef.current = null
      maRefs.current = {}
    }
    // 建图只做一次：配色变化交给下面单独的 applyOptions，周期切换在 setData 时处理
  }, [intraday])

  // 配色随市场切换（A 股红涨绿跌 / 美股绿涨红跌）
  useEffect(() => {
    candleRef.current?.applyOptions({
      upColor: colors.up,
      downColor: colors.down,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
    })
  }, [colors.up, colors.down])

  useEffect(() => {
    const candle = candleRef.current
    const volume = volumeRef.current
    if (!candle || !volume) return

    byTime.current = new Map(bars.map((b) => [String(toTime(b.time, intraday)), b]))
    candle.setData(
      bars.map((b) => ({
        time: toTime(b.time, intraday),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      })),
    )
    volume.setData(
      bars.map((b) => ({
        time: toTime(b.time, intraday),
        value: b.volume ?? 0,
        color: b.close >= b.open ? `${colors.up}66` : `${colors.down}66`,
      })),
    )
    for (const key of ['ma5', 'ma10', 'ma20'] as const) {
      const series = maRefs.current[key]
      if (!series) continue
      series.setData(
        bars
          .filter((b) => b[key] != null)
          .map((b) => ({ time: toTime(b.time, intraday), value: b[key] as number })),
      )
    }
    chartRef.current?.timeScale().fitContent()
  }, [bars, intraday, colors.up, colors.down])

  const legend = hover ?? bars[bars.length - 1] ?? null

  return (
    <div className="kline">
      {legend && (
        <div className="kline-legend">
          <span>开 {legend.open.toFixed(2)}</span>
          <span>高 {legend.high.toFixed(2)}</span>
          <span>低 {legend.low.toFixed(2)}</span>
          <span>收 {legend.close.toFixed(2)}</span>
          <span className="dim">MA5 {legend.ma5 != null ? legend.ma5.toFixed(2) : '—'}</span>
          <span className="dim">MA10 {legend.ma10 != null ? legend.ma10.toFixed(2) : '—'}</span>
          <span className="dim">MA20 {legend.ma20 != null ? legend.ma20.toFixed(2) : '—'}</span>
        </div>
      )}
      <div ref={boxRef} className="kline-box" style={{ height }} />
    </div>
  )
}