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
  type IPriceLine,
  type ISeriesApi,
  type Time,
} from 'lightweight-charts'
import type { Bar } from '../types'
import {
  SESSION_SLOTS,
  avgPrices,
  barDay,
  lastDayBars,
  sessionSlot,
  slotLabel,
  slotTs,
  splitByBase,
  tsToSlot,
} from '../lib/intraday'

interface Props {
  bars: Bar[]
  market: string
  intraday: boolean
  /** 分时（当日 1 分钟折线）：价格线 + 均价线 + 昨收基线，X 轴压缩午休铺满 09:30–15:00。 */
  timeshare?: boolean
  /** 昨收价：分时基线与「涨跌%」参照。 */
  prevClose?: number | null
  /** 滚到最左时请求更早历史（日/周/月）。 */
  onLoadMore?: () => void
  /** 是否还有更早历史。 */
  hasMore?: boolean
  /** 正在加载更早历史。 */
  loadingMore?: boolean
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

/** 首屏默认显示最近多少根（留出往前拖的余地）。 */
const DEFAULT_VISIBLE = 250

interface Tip {
  x: number
  y: number
  bar: Bar
  avg: number | null
  chgPct: number | null
}

export default function KLineChart({
  bars,
  market,
  intraday,
  timeshare = false,
  prevClose = null,
  onLoadMore,
  hasMore = false,
  loadingMore = false,
  height = 380,
  onHover,
}: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const maRefs = useRef<Record<string, ISeriesApi<'Line'> | null>>({})
  const priceUpRef = useRef<ISeriesApi<'Line'> | null>(null)
  const priceDownRef = useRef<ISeriesApi<'Line'> | null>(null)
  const avgRef = useRef<ISeriesApi<'Line'> | null>(null)
  const baseLineRef = useRef<IPriceLine | null>(null)
  const byTime = useRef(new Map<string, Bar>())
  const avgByTime = useRef(new Map<string, number>())
  const hoverRef = useRef(onHover)
  hoverRef.current = onHover
  const loadMoreRef = useRef(onLoadMore)
  loadMoreRef.current = onLoadMore
  const canLoadRef = useRef(false)
  canLoadRef.current = hasMore && !loadingMore
  // 记录上一次渲染的「尾部 bar」：尾不变而根数变多＝往前 prepend，需要平移视窗避免跳动。
  const prevView = useRef<{ last: string; len: number } | null>(null)
  const [tip, setTip] = useState<Tip | null>(null)

  // 分时只画最新交易日（服务端已过滤，这里再兜一层）；其余周期用全量多日数据。
  const viewBars = useMemo(() => (timeshare ? lastDayBars(bars) : bars), [bars, timeshare])

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
      timeScale: {
        borderColor: '#262e3d',
        timeVisible: intraday,
        secondsVisible: false,
        // 缩放下限：左右都锁在第一/最后一根，既不滚到数据之外，也不留出无数据的空白。
        fixLeftEdge: true,
        fixRightEdge: true,
        lockVisibleTimeRangeOnResize: true,
      },
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

    // 分时：价格线按昨收分色（涨=红、跌=绿；美股沿用绿涨红跌）+ 黄色均价线（非分时清空、不显示）。
    priceUpRef.current = chart.addSeries(LineSeries, {
      color: colors.up,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })
    priceDownRef.current = chart.addSeries(LineSeries, {
      color: colors.down,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })
    avgRef.current = chart.addSeries(LineSeries, {
      color: '#e8a33d',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })

    chart.subscribeCrosshairMove((param) => {
      // param.point 只在鼠标停留在图表上时有值；离开或停在空区就没有目标 bar。
      if (!param.point) {
        setTip(null)
        hoverRef.current?.(null)
        return
      }
      const key = param.time ? String(param.time) : ''
      const bar = key ? (byTime.current.get(key) ?? null) : null
      if (bar) {
        const avg = avgByTime.current.get(key) ?? null
        const chgPct =
          prevClose != null && prevClose > 0 && bar.close != null
            ? Number((((bar.close - prevClose) / prevClose) * 100).toFixed(2))
            : bar.changePct
        setTip({ x: param.point.x, y: param.point.y, bar, avg, chgPct })
      } else {
        setTip(null)
      }
      hoverRef.current?.(bar)
    })

    // 滚到最左（可视区间起点 < 3）且有更早历史时，请求上一页。
    const onRange = (range: { from: number; to: number } | null) => {
      if (range && range.from < 3 && canLoadRef.current) loadMoreRef.current?.()
    }
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange)

    chartRef.current = chart
    candleRef.current = candle
    volumeRef.current = volume
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange)
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      volumeRef.current = null
      maRefs.current = {}
      priceUpRef.current = null
      priceDownRef.current = null
      avgRef.current = null
      baseLineRef.current = null
    }
    // 建图在「分钟线与否」「分时与否」变化时重建：分时的自定义轴格式化只在分时图实例上设置
  }, [intraday, timeshare])

  // 配色随市场切换（A 股红涨绿跌 / 美股绿涨红跌）
  useEffect(() => {
    candleRef.current?.applyOptions({
      upColor: colors.up,
      downColor: colors.down,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
    })
    priceUpRef.current?.applyOptions({ color: colors.up })
    priceDownRef.current?.applyOptions({ color: colors.down })
  }, [colors.up, colors.down])

  useEffect(() => {
    const candle = candleRef.current
    const volume = volumeRef.current
    const priceUp = priceUpRef.current
    const priceDown = priceDownRef.current
    const avg = avgRef.current
    const chart = chartRef.current
    if (!candle || !volume || !priceUp || !priceDown || !avg || !chart) return

    // 清掉上一轮的分时基线（换票 / 换周期都要重建）
    if (baseLineRef.current) {
      priceUp.removePriceLine(baseLineRef.current)
      baseLineRef.current = null
    }
    byTime.current = new Map()
    avgByTime.current = new Map()

    if (timeshare) {
      const day = viewBars.length ? barDay(viewBars[viewBars.length - 1].time) : ''
      // 分时图：蜡烛与 MA 清空；价格/均价按「槽位伪时间」铺开，两端补点撑满 09:30→15:00。
      candle.setData([])
      for (const key of ['ma5', 'ma10', 'ma20'] as const) maRefs.current[key]?.setData([])
      if (day && viewBars.length) {
        const first = viewBars[0]
        const priceMap = new Map<number, number>()
        priceMap.set(slotTs(day, 0), first.open ?? first.close ?? 0)
        const avgs = avgPrices(viewBars)
        // lightweight-charts 是**等距（序数）轴**：每个数据点占等宽，不看真实时间间隔。
        // 所以要把全天 0..240 每一分钟都补一个点（空槽 value=0 不可见），轴才会按分钟等宽、
        // 铺满 09:30–15:00；真实价线只落在有数据的槽位，右侧自然留白。
        const volMap = new Map<number, { value: number; up: boolean }>()
        for (let slot = 0; slot < SESSION_SLOTS; slot += 1) volMap.set(slotTs(day, slot), { value: 0, up: false })
        viewBars.forEach((b, i) => {
          const slot = sessionSlot(b.time)
          if (slot == null) return
          const ts = slotTs(day, slot)
          if (b.close != null) {
            priceMap.set(ts, b.close)
            byTime.current.set(String(ts), b)
          }
          if (avgs[i] != null) {
            avgByTime.current.set(String(ts), avgs[i] as number)
          }
          volMap.set(ts, { value: b.volume ?? 0, up: b.close >= b.open })
        })
        const sorted = [...priceMap].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time: time as Time, value }))
        // 价格线按「相对昨收」分色：>= 昨收→涨色、< 昨收→跌色（交界点两条线都含，线才连得上）。
        const base = prevClose != null && prevClose > 0 ? prevClose : (sorted[0]?.value ?? 0)
        const { up: upPts, down: downPts } = splitByBase(sorted, base)
        priceUp.setData(upPts)
        priceDown.setData(downPts)
        avg.setData(
          [...avgByTime.current]
            .map(([k, v]) => ({ time: Number(k) as Time, value: v }))
            .sort((a, b) => Number(a.time) - Number(b.time)),
        )
        volume.setData(
          [...volMap]
            .sort((a, b) => a[0] - b[0])
            .map(([time, v]) => ({
              time: time as Time,
              value: v.value,
              color: v.up ? `${colors.up}66` : `${colors.down}66`,
            })),
        )
        // 轴刻度：把槽位伪时间反算成压缩午休后的真实墙钟（09:30 / 11:30 / 13:00 / 15:00）。
        // 轴刻度用 timeScale.tickMarkFormatter，十字光标标签用 localization.timeFormatter。
        const label = (time: Time) => slotLabel(tsToSlot(day, Number(time)))
        chart.applyOptions({ timeScale: { tickMarkFormatter: label }, localization: { timeFormatter: label } })
        // 昨收基线（0% 参照）
        if (prevClose != null && prevClose > 0) {
          baseLineRef.current = priceUp.createPriceLine({
            price: prevClose,
            color: '#8a94a6',
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: '',
          })
        }
      } else {
        priceUp.setData([])
        priceDown.setData([])
        avg.setData([])
        volume.setData([])
      }
    } else {
      // 蜡烛（多日全量）：分时线清空。
      priceUp.setData([])
      priceDown.setData([])
      avg.setData([])
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
    }
    // prepend（尾部 bar 不变、根数变多）时把可视区间整体右移，画面不跳；换票/换周期则重置视窗。
    const lastTime = viewBars.length ? String(viewBars[viewBars.length - 1].time) : ''
    const prev = prevView.current
    if (prev && prev.last === lastTime && viewBars.length > prev.len) {
      const delta = viewBars.length - prev.len
      const lr = chart.timeScale().getVisibleLogicalRange()
      if (lr) chart.timeScale().setVisibleLogicalRange({ from: lr.from + delta, to: lr.to + delta })
    } else if (!timeshare && viewBars.length > DEFAULT_VISIBLE) {
      // 默认只显示最近 ~250 根（像同花顺/东财），左侧留出「往前拖」的余地，拖到边再自动加载更早。
      chart.timeScale().setVisibleLogicalRange({ from: viewBars.length - DEFAULT_VISIBLE, to: viewBars.length + 2 })
    } else {
      chart.timeScale().fitContent()
    }
    prevView.current = { last: lastTime, len: viewBars.length }
  }, [viewBars, intraday, timeshare, colors.up, colors.down, prevClose])

  const boxW = boxRef.current?.clientWidth ?? 0
  const boxH = boxRef.current?.clientHeight ?? height
  const tipW = 168

  return (
    <div className="kline">
      {tip && (
        <div
          className="kline-tip"
          style={{
            left: tip.x + 14 + tipW > boxW ? Math.max(6, tip.x - tipW - 8) : tip.x + 14,
            top: Math.max(6, Math.min(tip.y - 6, boxH - (timeshare ? 168 : 216))),
          }}
        >
          <div className="kline-tip-time">{tip.bar.time}</div>
          {timeshare ? (
            <>
              <div className="kline-tip-row">
                <span>价格</span>
                <b>{tip.bar.close != null ? tip.bar.close.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—'}</b>
              </div>
              <div className="kline-tip-row">
                <span>涨跌</span>
                <b className={pctClass(tip.chgPct)}>
                  {tip.chgPct != null ? `${tip.chgPct >= 0 ? '+' : ''}${tip.chgPct.toFixed(2)}%` : '—'}
                </b>
              </div>
              <div className="kline-tip-row">
                <span>均价</span>
                <b>{tip.avg != null ? tip.avg.toFixed(2) : '—'}</b>
              </div>
              <div className="kline-tip-row">
                <span>量</span>
                <b>{tip.bar.volume != null ? tip.bar.volume.toLocaleString('zh-CN') : '—'}</b>
              </div>
            </>
          ) : (
            <>
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
            </>
          )}
        </div>
      )}
      <div ref={boxRef} className="kline-box" style={{ height }} />
    </div>
  )
}
