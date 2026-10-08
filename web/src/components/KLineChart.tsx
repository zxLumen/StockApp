import { useEffect, useMemo, useRef, useState } from 'react'
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

/** 日/周/月线是 'YYYY-MM-DD'（图表按 BusinessDay 解析）；分钟线是 'YYYY-MM-DD HH:mm(:ss)'。 */
function toTime(raw: string, intraday: boolean): Time {
  if (!intraday) return raw as Time
  // 容错秒级（sina 偶发 '…:ss'）：统一截前 16 个字符。
  const compact = raw.slice(0, 16)
  // lightweight-charts 的分钟线刻度按 **UTC 墙钟** 渲染（无时区配置），
  // 直接把北京墙钟当 UTC 解析，轴标签才等于北京时间（按 +08:00 解析会整列少 8h）。
  const ms = Date.parse(`${compact.replace(' ', 'T')}:00Z`)
  if (Number.isFinite(ms)) return (ms / 1000) as Time
  return raw as Time
}

/** 分钟线只画「最新交易日」开盘后的那一段（专业软件「分时」口径）；日/周/月不动。 */
function lastSessionBars(bars: Bar[]): Bar[] {
  let last = ''
  for (const b of bars) {
    const d = b.time.slice(0, 10)
    if (d > last) last = d
  }
  if (!last) return bars
  return bars.filter((b) => b.time.slice(0, 10) === last)
}

/** 蜡烛配色：A股红涨绿跌，美股绿涨红跌（与 format.ts 的 trendClass 同一口径）。 */
export const PALETTE = {
  cn: { up: '#e0454b', down: '#12a05c' },
  us: { up: '#12a05c', down: '#e0454b' },
}

/** 涨幅红涨绿跌 → tooltip 颜色类。 */
function pctClass(v: number | null): string {
  if (v == null) return ''
  if (v > 0) return 'kline-tip-up'
  if (v < 0) return 'kline-tip-down'
  return ''
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
  const bridgeRef = useRef<ISeriesApi<'Line'> | null>(null)
  const [tip, setTip] = useState<{ x: number; y: number; bar: Bar } | null>(null)

  // 分时只取最新交易日的时段（多日分钟数据堆一起太乱）；日/周/月原样。
  const viewBars = useMemo(() => (intraday ? lastSessionBars(bars) : bars), [bars, intraday])

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
      // 轴上的日期标成「2026-10-08」，不要默认的「08 10月'26」（zh-CN 下太费解）。
      localization: { locale: 'zh-CN', dateFormat: 'yyyy-MM-dd' },
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

    // 分时「补全当天轴」的透明桥接线：lightweight-charts 的轴只到数据的最大时间，
    // 用一条无色的线在 09:30→15:00 各放一个点把时间轴撑满，下午没数据也显示整段刻度。
    const bridge = chart.addSeries(LineSeries, {
      color: 'rgba(0,0,0,0)',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })
    bridgeRef.current = bridge

    chart.subscribeCrosshairMove((param) => {
      // param.point 只在鼠标停留在图表上时有值；离开或停在空区（下午）就没有目标 bar。
      if (!param.point) {
        setTip(null)
        hoverRef.current?.(null)
        return
      }
      const bar = param.time ? (byTime.current.get(String(param.time)) ?? null) : null
      if (bar) setTip({ x: param.point.x, y: param.point.y, bar })
      else setTip(null)
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
      bridgeRef.current = null
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

    byTime.current = new Map(viewBars.map((b) => [String(toTime(b.time, intraday)), b]))
    candle.setData(
      viewBars.map((b) => ({
        time: toTime(b.time, intraday),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      })),
    )
    volume.setData(
      viewBars.map((b) => ({
        time: toTime(b.time, intraday),
        value: b.volume ?? 0,
        color: b.close >= b.open ? `${colors.up}66` : `${colors.down}66`,
      })),
    )
    for (const key of ['ma5', 'ma10', 'ma20'] as const) {
      const series = maRefs.current[key]
      if (!series) continue
      series.setData(
        viewBars
          .filter((b) => b[key] != null)
          .map((b) => ({ time: toTime(b.time, intraday), value: b[key] as number })),
      )
    }

    // 分时：桥接线撑满当天 09:30→15:00（收盘后 15:00 那根本就在数据里，设了也不改变范围）。
    const bridge = bridgeRef.current
    if (bridge) {
      const last = viewBars[viewBars.length - 1]
      if (intraday && last?.close != null) {
        const day = last.time.slice(0, 10)
        const t = (v: string) => Math.round(Date.parse(`${v}Z`) / 1000) as Time
        bridge.setData([
          { time: t(`${day}T09:30:00`), value: last.close },
          { time: t(`${day}T15:00:00`), value: last.close },
        ])
      } else {
        bridge.setData([])
      }
    }
    chartRef.current?.timeScale().fitContent()
  }, [viewBars, intraday, colors.up, colors.down])

  const boxW = boxRef.current?.clientWidth ?? 0
  const boxH = boxRef.current?.clientHeight ?? height
  const tipW = 158

  return (
    <div className="kline">
      {tip && (
        <div
          className="kline-tip"
          style={{
            left: tip.x + 14 + tipW > boxW ? Math.max(6, tip.x - tipW - 8) : tip.x + 14,
            top: Math.max(6, Math.min(tip.y - 6, boxH - 216)),
          }}
        >
          <div className="kline-tip-time">{tip.bar.time}</div>
          {(
            [
              ['开', tip.bar.open, null],
              ['高', tip.bar.high, null],
              ['低', tip.bar.low, null],
              ['收', tip.bar.close, tip.bar.changePct],
              ['涨跌', null, tip.bar.changePct],
              ['量', tip.bar.volume, null],
            ] as [string, number | null, number | null][]
          ).map(([label, value, tone]) => (
            <div className="kline-tip-row" key={label}>
              <span>{label}</span>
              <b className={tone == null ? '' : pctClass(tone)}>
                {tone != null
                  ? tone >= 0
                    ? `+${tone.toFixed(2)}%`
                    : `${tone.toFixed(2)}%`
                  : value != null
                    ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
                    : '—'}
              </b>
            </div>
          ))}
          <div className="kline-tip-row kline-tip-ma">
            <span>MA5</span>
            <b>{tip.bar.ma5 != null ? tip.bar.ma5.toFixed(2) : '—'}</b>
            <span>MA10</span>
            <b>{tip.bar.ma10 != null ? tip.bar.ma10.toFixed(2) : '—'}</b>
            <span>MA20</span>
            <b>{tip.bar.ma20 != null ? tip.bar.ma20.toFixed(2) : '—'}</b>
          </div>
        </div>
      )}
      <div ref={boxRef} className="kline-box" style={{ height }} />
    </div>
  )
}