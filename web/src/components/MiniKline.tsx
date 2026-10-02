import { useEffect, useRef } from 'react'
import { CandlestickSeries, ColorType, createChart, type IChartApi } from 'lightweight-charts'
import { fetchKline } from '../api'

interface Props {
  secid: string
  name: string
  /** A 股红涨绿跌，美股/港股沿用红涨绿跌（东财口径一致） */
  up: string
  down: string
}

/** 首页迷你 K 线：默认页要一眼看到「沪 / 深 / 港」三条走势。 */
export default function MiniKline({ secid, name, up, down }: Props) {
  const ref = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const colorRef = useRef({ up, down })
  colorRef.current = { up, down }

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ac = new AbortController()
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { visible: false },
      leftPriceScale: { visible: false },
      timeScale: { visible: false, borderVisible: false },
      crosshair: { mode: 0 },
      handleScroll: false,
      handleScale: false,
    })
    chartRef.current = chart
    fetchKline(secid, 'd', 60, ac.signal)
      .then((r) => {
        if (!r.bars.length) return
        const series = chart.addSeries(CandlestickSeries, {
          upColor: colorRef.current.up,
          downColor: colorRef.current.down,
          wickUpColor: colorRef.current.up,
          wickDownColor: colorRef.current.down,
          borderVisible: false,
          priceLineVisible: false,
          lastValueVisible: false,
        })
        series.setData(
          r.bars.map((b) => ({ time: b.time as never, open: b.open, high: b.high, low: b.low, close: b.close })),
        )
        chart.timeScale().fitContent()
      })
      .catch(() => undefined)
    return () => {
      ac.abort()
      chart.remove()
      chartRef.current = null
    }
  }, [secid])

  return (
    <div className="mini">
      <div ref={ref} className="mini-chart" />
      <div className="mini-name">{name}</div>
    </div>
  )
}