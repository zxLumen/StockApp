import { useEffect, useMemo, useState } from 'react'
import { fetchLabLeaderboard, fetchLabPositions, fetchLabRecommend, fetchLabStrategies } from '../api'
import type { LabLeaderboard, LabMeta, LabPositions, LabRecommend, LabStrategy } from '../types'

const money = (v: number | null | undefined) =>
  v == null ? '—' : `${v < 0 ? '-' : ''}¥${Math.abs(v).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`
const pct = (v: number | null | undefined) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`)
const tone = (v: number | null | undefined) => (v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '')

function Spark({ data }: { data: { date: string; ret: number | null; bench: number | null }[] }) {
  const vals = data.flatMap((d) => [d.ret, d.bench]).filter((v): v is number => v != null)
  if (!vals.length) return null
  const min = Math.min(...vals, 0)
  const max = Math.max(...vals, 0)
  const x = (i: number) => (data.length <= 1 ? 0 : (i / (data.length - 1)) * 300)
  const y = (v: number) => 84 - ((v - min) / (max - min || 1)) * 74
  const line = (k: 'ret' | 'bench') =>
    data
      .map((d, i) => (d[k] == null ? null : `${x(i).toFixed(1)},${y(d[k] as number).toFixed(1)}`))
      .filter(Boolean)
      .join(' ')
  return (
    <svg className="lab-spark" viewBox="0 0 300 90" preserveAspectRatio="none">
      <polyline points={line('bench')} fill="none" stroke="var(--zx-dim)" strokeWidth="1" />
      <polyline points={line('ret')} fill="none" stroke="var(--zx-accent)" strokeWidth="1.6" />
    </svg>
  )
}

export default function LabView({ onPick }: { onPick: (s: { code: string; name: string; secid: string }) => void }) {
  const [meta, setMeta] = useState<LabMeta | null>(null)
  const [id, setId] = useState('')
  const [date, setDate] = useState('')
  const [tab, setTab] = useState<'rec' | 'pos' | 'rank'>('rec')
  const [rec, setRec] = useState<LabRecommend | null>(null)
  const [pos, setPos] = useState<LabPositions | null>(null)
  const [rank, setRank] = useState<LabLeaderboard | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    fetchLabStrategies()
      .then((m) => {
        setMeta(m)
        setId(m.strategies.find((s) => !s.control)?.id || m.strategies[0]?.id || '')
        setDate(m.defaultDate || m.dates.at(-1) || '')
      })
      .catch((e) => setErr(e.message))
  }, [])

  useEffect(() => {
    if (!id) return
    setErr('')
    if (tab === 'rec') fetchLabRecommend(id, date).then(setRec).catch((e) => setErr(e.message))
    if (tab === 'pos') fetchLabPositions(id, date).then(setPos).catch((e) => setErr(e.message))
    if (tab === 'rank') fetchLabLeaderboard(date).then(setRank).catch((e) => setErr(e.message))
  }, [id, date, tab])

  const groups = useMemo(() => {
    const g: Record<string, LabStrategy[]> = {}
    for (const s of meta?.strategies || []) (g[s.source] ??= []).push(s)
    return g
  }, [meta])

  return (
    <div className="lab-wrap">
      <div className="lab-head">
        <div>
          <h2>策略实验室</h2>
          <div className="lab-note">
            独立验证策略，**不影响**线上 A/B/dual；每日快照来自线上选股归档 + Btuned 新选股，持有规则在查看时逐票应用。
            {meta && ` 前瞻窗 ${meta.forwardWindow.from} ~ ${meta.forwardWindow.to}`}
          </div>
        </div>
        <div className="lab-controls">
          <select className="lab-select" value={id} onChange={(e) => setId(e.target.value)}>
            {Object.entries(groups).map(([src, list]) => (
              <optgroup key={src} label={src}>
                {list.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id}
                    {s.control ? '（对照）' : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <select className="lab-select" value={date} onChange={(e) => setDate(e.target.value)}>
            {(meta?.dates || []).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="lab-tabs">
        <button className={`lab-tab${tab === 'rec' ? ' is-active' : ''}`} onClick={() => setTab('rec')}>
          每日推荐
        </button>
        <button className={`lab-tab${tab === 'pos' ? ' is-active' : ''}`} onClick={() => setTab('pos')}>
          模拟持仓
        </button>
        <button className={`lab-tab${tab === 'rank' ? ' is-active' : ''}`} onClick={() => setTab('rank')}>
          排行榜
        </button>
      </div>

      {err && <div className="lab-note down">{err}</div>}

      {tab === 'rec' && rec && (
        <div>
          <div className="lab-note">
            生效 {rec.date} · 基准 {rec.basisDate || '—'} · {rec.style} · 持有 {rec.hold.name}
            {' · '}均收益 <b className={tone(rec.summary.meanRet)}>{pct(rec.summary.meanRet)}</b>
            {' · '}均超额 <b className={tone(rec.summary.meanExcess)}>{pct(rec.summary.meanExcess)}</b>
            {rec.summary.pending > 0 && ` · 待开盘 ${rec.summary.pending}`}
          </div>
          <table className="lab-table">
            <thead>
              <tr>
                <th>#</th><th>股票</th><th>买点</th><th>状态</th><th>持有</th><th>收益</th><th>超额</th>
              </tr>
            </thead>
            <tbody>
              {rec.top.map((p, i) => (
                <tr key={`${p.secid}-${i}`} onClick={() => onPick({ code: p.code, name: p.name, secid: p.secid })}>
                  <td>{i + 1}</td>
                  <td>{p.name} <span className="dim small">{p.code}{p.sleeve ? ` · ${p.sleeve}` : ''}</span></td>
                  <td>{p.entryPrice == null ? '—' : p.entryPrice.toFixed(2)}</td>
                  <td>{p.status || '—'}{p.exitDate ? <span className="dim small"> · {p.exitDate}</span> : null}</td>
                  <td>{p.holdDays ?? '—'}</td>
                  <td className={tone(p.retPct)}>{pct(p.retPct)}</td>
                  <td className={tone(p.excessPct)}>{pct(p.excessPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'pos' && pos && (
        <div>
          <div className="pos-summary lab-summary">
            <div className="pos-cell"><span className="pos-k">累计投入</span><b>{money(pos.summary.invested)}</b><span className="dim small">持仓 {pos.summary.openCount} · 了结 {pos.summary.closedCount}</span></div>
            <div className="pos-cell"><span className="pos-k">累计盈亏</span><b className={tone(pos.summary.total)}>{money(pos.summary.total)}</b><span className="dim small">已实现 {money(pos.summary.realized)}</span></div>
            <div className="pos-cell"><span className="pos-k">浮动盈亏</span><b className={tone(pos.summary.unrealized)}>{money(pos.summary.unrealized)}</b><span className="dim small">持仓成本 {money(pos.summary.openCost)}</span></div>
            <div className="pos-cell"><span className="pos-k">收益率</span><b className={tone(pos.summary.returnPct)}>{pct(pos.summary.returnPct)}</b><span className="dim small">胜率 {pos.summary.winPct == null ? '—' : `${Math.round(pos.summary.winPct * 100)}%`}</span></div>
          </div>
          <div className="lab-note">模拟持仓 · 截至 {pos.asOf} · 金额法（总盈亏/累计投入） · 对照 {pos.benchName}</div>
          <Spark data={pos.equity} />
          <table className="lab-table">
            <thead><tr><th>持仓</th><th>股数</th><th>成本</th><th>现价</th><th>盈亏</th><th>收益</th></tr></thead>
            <tbody>
              {pos.open.map((p) => (
                <tr key={`o-${p.secid}-${p.entryDate}`} onClick={() => onPick({ code: p.code, name: p.name, secid: p.secid })}>
                  <td>{p.name} <span className="dim small">{p.code}{p.sleeve ? ` · ${p.sleeve}` : ''}</span></td>
                  <td>{p.shares}</td>
                  <td>{p.avgCost?.toFixed(2)}</td>
                  <td>{p.lastPrice?.toFixed(2) ?? '—'}</td>
                  <td className={tone(p.pnl)}>{money(p.pnl)}</td>
                  <td className={tone(p.retPct)}>{pct(p.retPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="lab-table">
            <thead><tr><th>已了结</th><th>卖出日</th><th>卖价</th><th>股数</th><th>盈亏</th></tr></thead>
            <tbody>
              {pos.closed.map((p) => (
                <tr key={`c-${p.secid}-${p.sellDate}-${p.sellPrice}`}>
                  <td>{p.name} <span className="dim small">{p.code}</span></td>
                  <td>{p.sellDate}</td>
                  <td>{p.sellPrice?.toFixed(2)}</td>
                  <td>{p.shares}</td>
                  <td className={tone(p.pnl)}>{money(p.pnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'rank' && rank && (
        <div>
          <div className="lab-note">截至 {rank.asOf || '—'} · 按金额法收益率排序 · 一个月后再看完整口径</div>
          <table className="lab-table">
            <thead><tr><th>#</th><th>策略</th><th>来源</th><th>持有</th><th>收益率</th><th>累计盈亏</th><th>持仓/了结</th></tr></thead>
            <tbody>
              {rank.items.map((r, i) => (
                <tr key={r.id}>
                  <td>{i + 1}</td>
                  <td>{r.id}{r.control ? '（对照）' : ''}</td>
                  <td>{r.source}</td>
                  <td>{r.hold}</td>
                  <td className={tone(r.summary.returnPct)}>{pct(r.summary.returnPct)}</td>
                  <td className={tone(r.summary.total)}>{money(r.summary.total)}</td>
                  <td>{r.summary.openCount}/{r.summary.closedCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
