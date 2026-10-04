import { useEffect, useState } from 'react'
import { fetchBoardMembers, fetchKline, fetchStockNews } from '../api'
import { fmtNum, fmtSigned, trendClass } from '../format'
import AiPanel from './AiPanel'
import KLineChart from './KLineChart'
import NewsList from './NewsList'
import SourceBadge from './SourceBadge'
import type {
  Bar,
  Board,
  BoardCategory,
  BoardMember,
  Kline,
  NewsItem,
  Selection,
} from '../types'

interface Props {
  selection: Selection
  aiEnabled: boolean
  onPick: (s: Selection) => void
  onBack: () => void
}

/** 板块指数只有日/周/月（分钟线对板块没意义），所以周期比个股少。 */
const PERIODS = [
  { key: 'd', label: '日K' },
  { key: 'w', label: '周K' },
  { key: 'm', label: '月K' },
]

const KIND_LABEL: Record<BoardCategory, string> = {
  industry: '行业',
  concept: '概念',
  csi: '中证行业',
}

/** 从 `90.881121` / `91.000928` 反推分类：881→行业，885·886→概念，0009→中证。 */
function kindOf(secid: string): BoardCategory {
  const code = String(secid || '').split('.')[1] || ''
  if (/^0009(2[89]|3[0-7])$/.test(code)) return 'csi'
  if (/^88[56]\d{3}$/.test(code)) return 'concept'
  return 'industry'
}

/**
 * 板块详情：指数 K 线 + 涨跌家数 / 领涨股 + 成分股。
 *
 * K 线走同花顺 / 中证（`marketOf` 把 `90.`、`91.` 都归 board），成分股优先同花顺 ——
 * 概念必须带 cid 才有成员（platecode 页恒为 0 条）。
 */
export default function BoardView({ selection, aiEnabled, onPick, onBack }: Props) {
  const kind = kindOf(selection.secid)
  const [period, setPeriod] = useState('d')
  const [kline, setKline] = useState<Kline | null>(null)
  const [kErr, setKErr] = useState('')
  const [kLoading, setKLoading] = useState(true)

  const [meta, setMeta] = useState<Board | null>(null)
  const [items, setItems] = useState<BoardMember[]>([])
  const [source, setSource] = useState<string>()
  const [sourceLabel, setSourceLabel] = useState<string>()
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)

  const [news, setNews] = useState<NewsItem[]>([])
  const [newsErr, setNewsErr] = useState('')
  const [newsLoading, setNewsLoading] = useState(true)

  // 板块新闻按**板块名**做关键词匹配（成分股逐只去搜反而更差：一个概念几十只股票，
  // 拼出来的标题池重复且噪音大）。同花顺概念名往往就是媒体口径里的热词。
  useEffect(() => {
    const ac = new AbortController()
    setNewsLoading(true)
    setNewsErr('')
    fetchStockNews(selection.name, selection.code, ac.signal)
      .then((r) => setNews(r.items))
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === 'AbortError') return
        setNewsErr(e instanceof Error ? e.message : '相关新闻加载失败')
      })
      .finally(() => setNewsLoading(false))
    return () => ac.abort()
  }, [selection.name, selection.code])

  useEffect(() => {
    const ac = new AbortController()
    setKLoading(true)
    setKErr('')
    fetchKline(selection.secid, period, 240, ac.signal)
      .then((k) => setKline(k))
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === 'AbortError') return
        setKline(null)
        setKErr(e instanceof Error ? e.message : '板块 K 线加载失败')
      })
      .finally(() => setKLoading(false))
    return () => ac.abort()
  }, [selection.secid, period])

  useEffect(() => {
    const ac = new AbortController()
    setLoading(true)
    setErr('')
    fetchBoardMembers(selection.code, selection.name, kind, selection.cid, ac.signal)
      .then((r) => {
        setItems(r.items)
        setSource(r.source)
        setSourceLabel(r.sourceLabel)
        setMeta(r.board ?? null)
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === 'AbortError') return
        setErr(e instanceof Error ? e.message : '成分股加载失败')
      })
      .finally(() => setLoading(false))
    return () => ac.abort()
  }, [selection.code, selection.name, selection.cid, kind])

  const bars: Bar[] = kline?.bars ?? []
  const last = bars.at(-1)
  const changePct = last?.changePct ?? null

  return (
    <div className="detail">
      <div className="detail-head">
        <button className="link" onClick={onBack}>
          ← 返回
        </button>
        <div className="detail-id">
          <h2>{selection.name}</h2>
          <span className="dim">{KIND_LABEL[kind]}</span>
          <SourceBadge source={kline?.source} label={kline?.sourceLabel} primary />
        </div>
      </div>

      <div className="periods">
        {PERIODS.map((p) => (
          <button key={p.key} className={`chip${period === p.key ? ' on' : ''}`} onClick={() => setPeriod(p.key)}>
            {p.label}
          </button>
        ))}
      </div>

      {kErr && <div className="note err">{kErr}</div>}
      {!kErr && bars.length > 0 && (
        <div className="facts">
          {last && (
            <>
              <span>收盘 {fmtNum(last.close)}</span>
              <span className={trendClass(changePct, 'cn')}>{fmtSigned(changePct, 2, '%')}</span>
            </>
          )}
          {meta?.up != null && (
            <span>
              涨 {meta.up}
              {meta.down != null ? ` / 跌 ${meta.down}` : ''}
            </span>
          )}
          {meta?.leader && (
            <span className="dim">
              领涨 {meta.leader}
              {meta.leaderPct != null ? ` ${fmtSigned(meta.leaderPct, 2, '%')}` : ''}
            </span>
          )}
          {meta?.netInflow != null && (
            <span className={trendClass(meta.netInflow, 'cn')}>主力 {fmtSigned(meta.netInflow, 2, ' 亿')}</span>
          )}
        </div>
      )}
      {kLoading && !kErr && <div className="kline-box skeleton" style={{ height: 380 }} aria-hidden />}
      {!kLoading && !kErr && bars.length > 0 && (
        <KLineChart bars={bars} market="cn" intraday={false} />
      )}

      <div className="detail-head">
        <div className="detail-id">
          <h3>相关新闻</h3>
          <span className="dim">按板块名匹配</span>
        </div>
      </div>
      {newsErr && <div className="note err">{newsErr}</div>}
      {newsLoading && !newsErr && <div className="note">加载中…</div>}
      {!newsLoading && !newsErr && (
        <NewsList items={news} empty={`暂无「${selection.name}」的相关新闻。`} />
      )}

      <AiPanel secid={selection.secid} name={selection.name} enabled={aiEnabled} />

      <div className="detail-head">
        <div className="detail-id">
          <h3>板块成分股</h3>
          <SourceBadge source={source} label={sourceLabel} primary />
        </div>
      </div>

      {err && <div className="note err">{err}</div>}
      {loading && !err && <div className="note">加载中…</div>}
      {!loading && !err && items.length === 0 && (
        <div className="note">暂无成分股数据。</div>
      )}

      {items.length > 0 && (
        <ul className="members">
          {items.map((m) => (
            <li key={m.secid}>
              <button
                className="member-row"
                onClick={() =>
                  onPick({ kind: 'stock', secid: m.secid, code: m.code, name: m.name, market: 'cn' })
                }
              >
                <span className="member-name">{m.name}</span>
                <span className="member-code dim">{m.code}</span>
                <span className="member-price">{fmtNum(m.price)}</span>
                <span className={`member-pct ${trendClass(m.changePct, 'cn')}`}>
                  {fmtSigned(m.changePct, 2, '%')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!loading && items.length > 0 && (
        <div className="note small">同花顺板块页只内联首页成分股，完整名单需在其官网查看。</div>
      )}
    </div>
  )
}
