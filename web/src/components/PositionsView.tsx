import { useEffect, useRef, useState } from 'react'
import { ColorType, LineSeries, LineStyle, createChart, type IChartApi, type Time } from 'lightweight-charts'
import { fetchPositions, type PositionsPayload } from '../api'
import { useSessionState } from '../sessionState'
import type { PositionChain, PositionItem, PositionMode, PositionTrade } from '../types'

const pctStr = (n: number | null | undefined) => (n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)}%`)
const money = (n: number | null | undefined) =>
  n == null ? '—' : `¥${Math.round(n).toLocaleString('zh-CN')}`
const sharesStr = (n: number) => (Number.isInteger(n) ? n.toLocaleString('zh-CN') : n.toFixed(4))
const tone = (n: number | null | undefined) => (n == null ? 'dim' : n > 0 ? 'up' : n < 0 ? 'down' : 'dim')

const CHAINS: { key: PositionChain; label: string }[] = [
  { key: 'dual', label: '双链路' },
  { key: 'A', label: 'A 激进' },
  { key: 'B', label: 'B 保守' },
]

// 客户端缓存（SWR）：整包不含日期维度，一次拿全，切链路/模式零请求。
let posMem: PositionsPayload | null = null
function posCacheGet(): PositionsPayload | null {
  if (posMem) return posMem
  try {
    const raw = sessionStorage.getItem('zx-positions')
    if (raw) {
      posMem = JSON.parse(raw) as PositionsPayload
      return posMem
    }
  } catch {
    /* 忽略 */
  }
  return null
}
function posCacheSet(v: PositionsPayload) {
  posMem = v
  try {
    sessionStorage.setItem('zx-positions', JSON.stringify(v))
  } catch {
    /* 超限忽略 */
  }
}

export default function PositionsView({
  onPick,
}: {
  onPick: (s: { code: string; name: string; secid: string }) => void
}) {
  const [chain, setChain] = useSessionState<PositionChain>('posChain', 'dual')
  const [mode, setMode] = useSessionState<'orig' | 'ai'>('posMode', 'ai')
  const [data, setData] = useState<PositionsPayload | null>(() => posCacheGet())
  const [loading, setLoading] = useState(() => !posCacheGet())
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    const hit = posCacheGet()
    if (hit) {
      setData(hit)
      setLoading(false)
    }
    fetchPositions()
      .then((v) => {
        if (!alive) return
        setData(v)
        posCacheSet(v)
      })
      .catch((e: unknown) => {
        if (!alive || hit) return
        setErr(e instanceof Error ? e.message : '加载失败')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const ch = data?.chains?.[chain] ?? null
  const m: PositionMode | null = ch ? ch[mode] : null

  return (
    <div className="pos-wrap">
      <div className="pos-head">
        <h2>模拟推荐持仓</h2>
        <div className="tabs" role="tablist">
          {CHAINS.map((c) => (
            <button
              key={c.key}
              role="tab"
              aria-selected={chain === c.key}
              className={`tab${chain === c.key ? ' is-active' : ''}`}
              onClick={() => setChain(c.key)}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="pos-mode" role="tablist">
          {(
            [
              ['orig', '原始周期'],
              ['ai', 'AI动态调整'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              role="tab"
              aria-selected={mode === k}
              className={`pos-mode-btn${mode === k ? ' on' : ''}`}
              onClick={() => setMode(k)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="dim small">每只 ¥10,000 等权 · 从有推荐数据起累积{data?.asOf ? ` · 截至 ${data.asOf}` : ''}</span>
      </div>

      {err && <div className="note err">{err}</div>}
      {!data && loading && <div className="note">加载模拟持仓…</div>}

      {m && (
        <>
          <div className="pos-summary">
            <div className="pos-cell">
              <span className="pos-k">累计投入</span>
              <b>{money(m.summary.invested)}</b>
              <span className="dim small">
                {m.summary.count} 只 · 持仓 {m.summary.openCount} · 已了结 {m.summary.closedCount}
              </span>
            </div>
            <div className="pos-cell">
              <span className="pos-k">已实现盈亏</span>
              <b className={tone(m.summary.realized)}>{money(m.summary.realized)}</b>
              <span className="dim small">
                {m.summary.winPct != null ? `${Math.round(m.summary.winPct * 100)}% 胜率` : '—'}
              </span>
            </div>
            <div className="pos-cell">
              <span className="pos-k">浮动盈亏</span>
              <b className={tone(m.summary.unrealized)}>{money(m.summary.unrealized)}</b>
              <span className="dim small">持仓中 {m.summary.openCount} 只</span>
            </div>
            <div className="pos-cell">
              <span className="pos-k">总盈亏</span>
              <b className={tone(m.summary.total)}>{money(m.summary.total)}</b>
              <span className="dim small">
                收益率 <em className={tone(m.summary.returnPct)}>{pctStr(m.summary.returnPct)}</em>
              </span>
            </div>
          </div>

          {ch && ch.equity.length > 1 && (
            <div className="pos-chart-wrap">
              <div className="pos-chart-title">
                组合累计收益率 · 对照 {data?.benchName || '沪深300'}
                <span className="dim small">（原始 vs AI动态 vs 基准，同起点）</span>
              </div>
              <EquityChart equity={ch.equity} />
            </div>
          )}

          <Section title={`持仓中（${m.open.length}）`}>
            <PositionTable rows={m.open} kind="open" onPick={onPick} />
          </Section>
          <Section title={`已了结（${m.closed.length}）`}>
            <PositionTable rows={m.closed} kind="closed" onPick={onPick} />
          </Section>
          <Section title={`交易流水（${m.trades.length}）`}>
            <TradesTable trades={m.trades} />
          </Section>
        </>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="pos-section">
      <h3 className="sec-title">{title}</h3>
      {children}
    </section>
  )
}

function PositionTable({
  rows,
  kind,
  onPick,
}: {
  rows: PositionItem[]
  kind: 'open' | 'closed'
  onPick: (s: { code: string; name: string; secid: string }) => void
}) {
  if (!rows.length) return <div className="note small">暂无</div>
  return (
    <div className="pos-list">
      <div className="pos-row pos-row-head">
        <span>名称</span>
        <span>买入日</span>
        <span>买入价</span>
        <span>{kind === 'open' ? '现价' : '卖出价'}</span>
        <span>股数</span>
        <span>盈亏%</span>
        <span>{kind === 'open' ? '预计卖出' : '卖出日'}</span>
        <span>持有</span>
      </div>
      {rows.map((p) => (
        <div
          className="pos-row"
          key={`${p.secid}-${p.recDate}`}
          role="button"
          tabIndex={0}
          onClick={() => onPick({ code: p.code, name: p.name, secid: p.secid })}
        >
          <span className="pos-name">
            {p.name} <span className="dim small">{p.code}</span>
            {p.terminated && <em className="pos-tag pos-tag-ai">已提前终止</em>}
            {p.extended && <em className="pos-tag pos-tag-ext">延长 +{p.effHoldDays - p.holdDays}</em>}
          </span>
          <span>{p.buyDate}</span>
          <span>{p.buyPrice?.toFixed(2)}</span>
          <span>{p.lastPrice?.toFixed(2) ?? '—'}</span>
          <span>{sharesStr(p.shares)}</span>
          <span className={`pos-pct ${tone(p.retPct)}`}>{pctStr(p.retPct)}</span>
          <span>{kind === 'open' ? p.expectedSellDate : p.sellDate}</span>
          <span className="dim">{p.effHoldDays} 日</span>
        </div>
      ))}
    </div>
  )
}

function TradesTable({ trades }: { trades: PositionTrade[] }) {
  if (!trades.length) return <div className="note small">暂无</div>
  return (
    <div className="pos-list">
      <div className="pos-row pos-row-head trade">
        <span>日期</span>
        <span>方向</span>
        <span>名称</span>
        <span>股数</span>
        <span>价格</span>
        <span>金额</span>
        <span>盈亏</span>
      </div>
      {trades.map((t, i) => (
        <div className="pos-row trade" key={`${t.date}-${t.secid}-${t.dir}-${i}`}>
          <span>{t.date}</span>
          <span className={t.dir === 'buy' ? 'trade-buy' : 'trade-sell'}>{t.dir === 'buy' ? '买入' : '卖出'}</span>
          <span className="pos-name">
            {t.name} <span className="dim small">{t.code}</span>
          </span>
          <span>{sharesStr(t.shares)}</span>
          <span>{t.price?.toFixed(2)}</span>
          <span>{money(t.amount)}</span>
          <span className={t.pnl != null ? tone(t.pnl) : 'dim'}>{t.pnl != null ? money(t.pnl) : '—'}</span>
        </div>
      ))}
    </div>
  )
}

/** 三条线：原始组合 / AI动态组合 / 沪深300（累计收益率%，同起点）。 */
function EquityChart({ equity }: { equity: { date: string; orig: number | null; ai: number | null; bench: number | null }[] }) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8a94a6', fontSize: 11 },
      grid: { vertLines: { color: '#1e2532' }, horzLines: { color: '#1e2532' } },
      rightPriceScale: { borderColor: '#262e3d' },
      timeScale: { borderColor: '#262e3d' },
      localization: { locale: 'zh-CN', dateFormat: 'yyyy-MM-dd' },
    })
    const mk = (color: string, width: 1 | 2, dashed = false) =>
      chart.addSeries(LineSeries, {
        color,
        lineWidth: width,
        priceLineVisible: false,
        lastValueVisible: true,
        lineStyle: dashed ? LineStyle.Dashed : LineStyle.Solid,
      })
    const sOrig = mk('#4a8ef0', 2)
    const sAi = mk('#e8a33d', 2)
    const sBench = mk('#8a94a6', 1, true)
    sOrig.setData(equity.filter((p) => p.orig != null).map((p) => ({ time: p.date as Time, value: p.orig as number })))
    sAi.setData(equity.filter((p) => p.ai != null).map((p) => ({ time: p.date as Time, value: p.ai as number })))
    sBench.setData(equity.filter((p) => p.bench != null).map((p) => ({ time: p.date as Time, value: p.bench as number })))
    chart.timeScale().fitContent()
    chartRef.current = chart
    return () => {
      chart.remove()
      chartRef.current = null
    }
  }, [equity])
  return (
    <>
      <div ref={boxRef} className="kline-box" style={{ height: 300 }} />
      <div className="pos-legend">
        <span className="pos-legend-i" style={{ color: '#4a8ef0' }}>● 原始周期</span>
        <span className="pos-legend-i" style={{ color: '#e8a33d' }}>● AI动态调整</span>
        <span className="pos-legend-i" style={{ color: '#8a94a6' }}>● 沪深300</span>
      </div>
    </>
  )
}
