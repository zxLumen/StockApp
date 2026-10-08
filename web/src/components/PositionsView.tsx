import { useEffect, useRef, useState } from 'react'
import { ColorType, LineSeries, LineStyle, createChart, type IChartApi, type Time } from 'lightweight-charts'
import { fetchPositions, type PositionsPayload } from '../api'
import { useSessionState } from '../sessionState'
import type { PositionChain, PositionItem, PositionMode, PositionTrade } from '../types'

const pctStr = (n: number | null | undefined) => (n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)}%`)
const money = (n: number | null | undefined) => (n == null ? '—' : `¥${Math.round(n).toLocaleString('zh-CN')}`)
const sharesStr = (n: number) => (Number.isInteger(n) ? n.toLocaleString('zh-CN') : n.toFixed(4))
const tone = (n: number | null | undefined) => (n == null ? 'dim' : n > 0 ? 'up' : n < 0 ? 'down' : 'dim')

const PAGE_SIZE = 20

const CHAINS: { key: PositionChain; label: string }[] = [
  { key: 'dual', label: '双链路' },
  { key: 'A', label: 'A 激进' },
  { key: 'B', label: 'B 保守' },
]

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
  const openStocks = m ? new Set(m.open.map((p) => p.code)).size : 0

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
        <span className="dim small">
          每只 ¥10,000 等权 · 从有推荐数据起累积{data?.asOf ? ` · 截至 ${data.asOf}` : ''}
        </span>
      </div>

      {err && <div className="note err">{err}</div>}
      {!data && loading && <div className="note">加载模拟持仓…</div>}

      {m && (
        <>
          <div className="pos-summary">
            <div className="pos-cell">
              <span className="pos-k">持仓成本</span>
              <b>{money(m.summary.openCost)}</b>
              <span className="dim small">
                持仓 {m.summary.openCount} 只 · 已了结 {m.summary.closedCount} 只
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

          {ch && ch.equity.length >= 1 && (
            <div className="pos-chart-wrap">
              <div className="pos-chart-title">
                组合累计收益率 · 对照 {data?.benchName || '沪深300'}
                <span className="dim small">（金额法：总盈亏/累计投入，与上方一致 · 同起点）</span>
              </div>
              <EquityChart equity={ch.equity} />
            </div>
          )}

          <Section title="持仓中" count={openStocks} defaultOpen>
            <PositionTable key={`${chain}-${mode}-open`} rows={m.open} kind="open" onPick={onPick} />
          </Section>
          <Section title="已了结" count={m.closed.length} defaultOpen>
            <PositionTable key={`${chain}-${mode}-closed`} rows={m.closed} kind="closed" onPick={onPick} />
          </Section>
          <Section title="交易流水" count={m.trades.length} defaultOpen={false}>
            <TradesTable key={`${chain}-${mode}-trades`} trades={m.trades} />
          </Section>
        </>
      )}
    </div>
  )
}

/** 可折叠小节：标题行显示数量，默认是否展开可配。 */
function Section({ title, count, defaultOpen = true, children }: { title: string; count: number; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="pos-section">
      <button type="button" className="pos-sec-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="sec-title">
          {title}（{count}）
        </span>
        <span className="pos-caret">{open ? '▴' : '▾'}</span>
      </button>
      {open && <div className="pos-sec-body">{children}</div>}
    </section>
  )
}

function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null
  return (
    <div className="pos-pager">
      <button type="button" className="pos-pager-btn" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ‹ 上一页
      </button>
      <span className="dim small">
        {page} / {pages}
      </span>
      <button type="button" className="pos-pager-btn" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        下一页 ›
      </button>
    </div>
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
  const [page, setPage] = useState(1)
  if (!rows.length) return <div className="note small">暂无</div>

  // 持仓中：按股票合并（同一票多天买入 → 一条，买入价为成本均价），按盈亏降序。
  if (kind === 'open') {
    const agg = new Map<string, { secid: string; code: string; name: string; shares: number; cost: number; lastPrice: number | null; pnl: number }>()
    for (const p0 of rows) {
      const a = agg.get(p0.code) ?? { secid: p0.secid, code: p0.code, name: p0.name, shares: 0, cost: 0, lastPrice: p0.lastPrice, pnl: 0 }
      a.shares += p0.shares
      a.cost += p0.cost
      a.pnl += p0.pnl ?? 0
      a.lastPrice = p0.lastPrice ?? a.lastPrice
      agg.set(p0.code, a)
    }
    const list = [...agg.values()]
      .map((a) => ({
        ...a,
        avgBuy: a.shares ? a.cost / a.shares : null,
        mv: a.lastPrice != null ? a.shares * a.lastPrice : null,
        retPct: a.cost ? (a.pnl / a.cost) * 100 : null,
      }))
      .sort((x, y) => y.pnl - x.pnl)
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE))
    const p = Math.min(page, pages)
    const slice = list.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE)
    return (
      <>
        <div className="pos-list">
          <div className="pos-row pos-row-head open">
            <span>名称</span>
            <span>买入均价</span>
            <span>现价</span>
            <span>股数</span>
            <span>当前市值</span>
            <span>盈亏%</span>
          </div>
          {slice.map((a) => (
            <div
              className="pos-row open"
              key={a.code}
              role="button"
              tabIndex={0}
              onClick={() => onPick({ code: a.code, name: a.name, secid: a.secid })}
            >
              <span className="pos-name">
                {a.name} <span className="dim small">{a.code}</span>
              </span>
              <span>{a.avgBuy != null ? a.avgBuy.toFixed(2) : '—'}</span>
              <span>{a.lastPrice != null ? a.lastPrice.toFixed(2) : '—'}</span>
              <span>{sharesStr(a.shares)}</span>
              <span>{money(a.mv)}</span>
              <span className={`pos-pct ${tone(a.retPct)}`}>{pctStr(a.retPct)}</span>
            </div>
          ))}
        </div>
        <Pager page={p} pages={pages} onPage={setPage} />
      </>
    )
  }

  // 已了结：逐笔明细
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const p = Math.min(page, pages)
  const slice = rows.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE)
  return (
    <>
      <div className="pos-list">
        <div className="pos-row pos-row-head">
          <span>名称</span>
          <span>买入日</span>
          <span>买入价</span>
          <span>卖出价</span>
          <span>股数</span>
          <span>盈亏%</span>
          <span>卖出日</span>
          <span>持有</span>
        </div>
        {slice.map((p0) => (
          <div
            className="pos-row"
            key={`${p0.secid}-${p0.recDate}-${p0.buyDate}`}
            role="button"
            tabIndex={0}
            onClick={() => onPick({ code: p0.code, name: p0.name, secid: p0.secid })}
          >
            <span className="pos-name">
              {p0.name} <span className="dim small">{p0.code}</span>
              {p0.terminated && <em className="pos-tag pos-tag-ai">已提前终止</em>}
              {p0.extended && <em className="pos-tag pos-tag-ext">延长 +{p0.effHoldDays - p0.holdDays}</em>}
            </span>
            <span>{p0.buyDate}</span>
            <span>{p0.buyPrice?.toFixed(2)}</span>
            <span>{p0.sellPrice?.toFixed(2) ?? '—'}</span>
            <span>{sharesStr(p0.shares)}</span>
            <span className={`pos-pct ${tone(p0.retPct)}`}>{pctStr(p0.retPct)}</span>
            <span>{p0.sellDate}</span>
            <span className="dim">{p0.effHoldDays} 日</span>
          </div>
        ))}
      </div>
      <Pager page={p} pages={pages} onPage={setPage} />
    </>
  )
}

function TradesTable({ trades }: { trades: PositionTrade[] }) {
  const [page, setPage] = useState(1)
  if (!trades.length) return <div className="note small">暂无</div>
  const pages = Math.max(1, Math.ceil(trades.length / PAGE_SIZE))
  const p = Math.min(page, pages)
  const slice = trades.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE)
  return (
    <>
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
        {slice.map((t, i) => (
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
      <Pager page={p} pages={pages} onPage={setPage} />
    </>
  )
}

/** 三条线：原始组合 / AI动态组合 / 沪深300（累计收益率%，同起点）+ 悬浮浮窗（复用 K 线浮窗风格）。 */
function EquityChart({ equity }: { equity: { date: string; orig: number | null; ai: number | null; bench: number | null }[] }) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const [tip, setTip] = useState<{ x: number; y: number; row: (typeof equity)[number] } | null>(null)

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8a94a6', fontSize: 11 },
      grid: { vertLines: { color: '#1e2532' }, horzLines: { color: '#1e2532' } },
      rightPriceScale: { borderColor: '#262e3d' },
      timeScale: { borderColor: '#262e3d' },
      crosshair: {
        vertLine: { color: '#8a94a6', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#3b4252' },
        horzLine: { color: '#8a94a6', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#3b4252' },
      },
      localization: { locale: 'zh-CN', dateFormat: 'yyyy-MM-dd' },
    })
    const mk = (color: string, width: 1 | 2, dashed = false) =>
      chart.addSeries(LineSeries, {
        color,
        lineWidth: width,
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerVisible: true,
        lineStyle: dashed ? LineStyle.Dashed : LineStyle.Solid,
      })
    const sOrig = mk('#4a8ef0', 2)
    const sAi = mk('#e8a33d', 2)
    const sBench = mk('#8a94a6', 1, true)
    sOrig.setData(equity.filter((p) => p.orig != null).map((p) => ({ time: p.date as Time, value: p.orig as number })))
    sAi.setData(equity.filter((p) => p.ai != null).map((p) => ({ time: p.date as Time, value: p.ai as number })))
    sBench.setData(equity.filter((p) => p.bench != null).map((p) => ({ time: p.date as Time, value: p.bench as number })))
    const byDate = new Map(equity.map((p) => [p.date, p]))
    chart.subscribeCrosshairMove((param) => {
      if (!param.point || !param.time) {
        setTip(null)
        return
      }
      const row = byDate.get(String(param.time))
      if (row) setTip({ x: param.point.x, y: param.point.y, row })
      else setTip(null)
    })
    chart.timeScale().fitContent()
    chartRef.current = chart
    return () => {
      chart.remove()
      chartRef.current = null
    }
  }, [equity])

  const boxW = wrapRef.current?.clientWidth ?? 0
  const tipW = 150
  return (
    <div className="kline" ref={wrapRef}>
      {tip && (
        <div
          className="kline-tip"
          style={{
            left: tip.x + 14 + tipW > boxW ? Math.max(6, tip.x - tipW - 8) : tip.x + 14,
            top: Math.max(6, tip.y - 6),
          }}
        >
          <div className="kline-tip-time">{tip.row.date}</div>
          <div className="kline-tip-row">
            <span>原始周期</span>
            <b className={`pos-pct ${tone(tip.row.orig)}`}>{pctStr(tip.row.orig)}</b>
          </div>
          <div className="kline-tip-row">
            <span>AI动态</span>
            <b className={`pos-pct ${tone(tip.row.ai)}`}>{pctStr(tip.row.ai)}</b>
          </div>
          <div className="kline-tip-row">
            <span>沪深300</span>
            <b className={`pos-pct ${tone(tip.row.bench)}`}>{pctStr(tip.row.bench)}</b>
          </div>
        </div>
      )}
      <div ref={boxRef} className="kline-box" style={{ height: 300 }} />
      <div className="pos-legend">
        <span className="pos-legend-i" style={{ color: '#4a8ef0' }}>
          ● 原始周期
        </span>
        <span className="pos-legend-i" style={{ color: '#e8a33d' }}>
          ● AI动态调整
        </span>
        <span className="pos-legend-i" style={{ color: '#8a94a6' }}>
          ● 沪深300
        </span>
      </div>
    </div>
  )
}
