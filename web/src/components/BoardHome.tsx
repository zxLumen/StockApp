import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { fetchBoards } from '../api'
import { fmtAmount, fmtSigned, trendClass } from '../format'
import {
  countMissing,
  DEFAULT_SORT,
  sortBoards,
  sortableKeys,
  type SortDir,
  type SortKey,
} from '../lib/boardSort'
import SourceBadge from './SourceBadge'
import type { Board, BoardCategory, Selection } from '../types'

interface Props {
  onPick: (s: Selection) => void
}

const KINDS: { key: BoardCategory; label: string; note: string }[] = [
  { key: 'industry', label: '行业', note: '同花顺一级行业，90 个' },
  { key: 'concept', label: '概念', note: '同花顺概念板块，293 个' },
  { key: 'csi', label: '中证', note: '中证一级行业，10 个（官方口径）' },
]

/** 只按代码 / 名称本地过滤 —— 列表已经全量在手，再打上游就是白白给自己找麻烦。 */
function filterBoards(list: Board[], q: string) {
  const key = q.trim().toLowerCase()
  if (!key) return list
  return list.filter(
    (b) => b.name.toLowerCase().includes(key) || b.code.includes(key) || b.secid.includes(key),
  )
}

/** 一列 = 要排的字段 + 表头文案。null 表示这一列在这个分类下没有数据。 */
interface StatCol {
  key: SortKey
  label: string
}

const PCT_LABEL = '涨幅'

/**
 * 板块首页（顶级页签，与沪深港 / 美股齐平）。
 *
 * 全量列表一次性取回（行业 90 / 概念 293 / 中证 10），筛选和排序都在前端做 ——
 * 上游只有同花顺那一份索引，反复请求没有意义。点板块进 BoardView 看 K 线 + 成分股 + 新闻 + AI。
 *
 * 排序必须在前端做，因为上游顺序不可用：同花顺概念索引完全无序，
 * 行业则是「第 1 页涨幅降序 + 第 2 页限流时把没数据的追加在尾部」。详见 lib/boardSort.js。
 *
 * 表格是「名次 / 名称 / 代码 / 统计列… / 涨幅」的 grid。统计列的数量由**数据实际可得性**
 * 推导（见 statCols：行业 3 列、概念 1 列、中证 0 列），列数写进 `--board-cols`
 * 交给 CSS 展开成对应条数的 grid-template。表头和数据行都用这同一份规格，
 * 否则两边列数对不上就会错位。
 */
export default function BoardHome({ onPick }: Props) {
  const [kind, setKind] = useState<BoardCategory>('industry')
  const [boards, setBoards] = useState<Board[]>([])
  const [source, setSource] = useState<string>()
  const [sourceLabel, setSourceLabel] = useState<string>()
  const [q, setQ] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  const [sortKey, setSortKey] = useState<SortKey>(DEFAULT_SORT.industry.key)
  const [sortDir, setSortDir] = useState<SortDir>(DEFAULT_SORT.industry.dir)

  useEffect(() => {
    const ac = new AbortController()
    setLoading(true)
    setErr('')
    fetchBoards(kind, 300, ac.signal)
      .then((r) => {
        setBoards(r.items)
        setSource(r.source)
        setSourceLabel(r.sourceLabel)
        // 换分类时回到该分类的默认排序（中证没有行情，默认按名称）
        setSortKey(DEFAULT_SORT[kind].key)
        setSortDir(DEFAULT_SORT[kind].dir)
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === 'AbortError') return
        setErr(e instanceof Error ? e.message : '板块列表加载失败')
      })
      .finally(() => setLoading(false))
    return () => ac.abort()
  }, [kind])

  // 换分类时清掉筛选词，免得「半导体」这种词把新分类筛成空表
  useEffect(() => {
    setQ('')
  }, [kind])

  // 先排后筛：序号取自全量榜，筛「半导体」时它仍显示第 12 名而不是被重编号
  const sorted = useMemo(() => sortBoards(boards, sortKey, sortDir), [boards, sortKey, sortDir])
  const shown = useMemo(() => filterBoards(sorted, q), [sorted, q])
  const rankOf = useMemo(() => new Map(sorted.map((b, i) => [b.secid, i + 1])), [sorted])
  const meta = KINDS.find((k) => k.key === kind)!

  const keys = useMemo(() => sortableKeys(boards), [boards])

  /**
   * 统计列的规格。实测数据可得性很干净，三种分类各对应一套：
   *   行业 → A=涨跌家数(50/90)  B=成交额(50/90)
   *   概念 → A=主力净流入(293/293)  B=无
   *   中证 → 两个都没有
   * 行业那几个字段的覆盖率完全一致（都来自第 1 页），所以同一列不会一行一个含义。
   */
  const statCols = useMemo<StatCol[]>(() => {
    const want: StatCol[] = [
      { key: 'up', label: '涨跌家数' },
      { key: 'amount', label: '成交额' },
      { key: 'netInflow', label: '主力净流入' },
    ]
    return want.filter((c) => keys.has(c.key))
  }, [keys])

  const sortLabel = sortKey === 'changePct' ? PCT_LABEL : (statCols.find((c) => c.key === sortKey)?.label ?? '名称')
  const missing = countMissing(boards, sortKey)

  /** 点表头：同字段反向，不同字段用该字段的默认方向（涨幅/资金习惯看降序，名称看升序）。 */
  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'name' ? 'asc' : 'desc')
    }
  }

  const headCell = (key: SortKey, label: string, cls = 'board-head-num') => (
    <span className={cls}>
      <button
        type="button"
        onClick={() => toggleSort(key)}
        aria-sort={sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        {label} {sortKey === key ? (sortDir === 'desc' ? '↓' : '↑') : ''}
      </button>
    </span>
  )

  const statCell = (b: Board, col: StatCol) => {
    if (col.key === 'up') {
      return (
        <span className="board-updown">
          {b.up != null ? (
            <>
              <span className="up">涨 {b.up}</span>
              {b.down != null && <span className="down">跌 {b.down}</span>}
            </>
          ) : (
            <span className="dim">—</span>
          )}
        </span>
      )
    }
    if (col.key === 'netInflow') {
      return (
        <span className={`board-inflow ${trendClass(b.netInflow, 'cn')}`}>
          {b.netInflow != null ? fmtSigned(b.netInflow, 2, ' 亿') : '—'}
        </span>
      )
    }
    return <span className="board-amt dim">{b.amount != null ? fmtAmount(b.amount) : '—'}</span>
  }

  return (
    <div className="board-home">
      <div className="detail-head">
        <div className="detail-id">
          <h2>板块</h2>
          <span className="dim">
            {loading ? '加载中…' : `${shown.length} / ${boards.length} 个`}
          </span>
          <SourceBadge source={source} label={sourceLabel} primary />
        </div>
        <div className="mini-tabs">
          {KINDS.map((k) => (
            <button key={k.key} className={`chip${kind === k.key ? ' on' : ''}`} onClick={() => setKind(k.key)}>
              {k.label}
            </button>
          ))}
        </div>
      </div>

      <div className="board-filter">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`在 ${meta.label} 里筛选，如 半导体 / 881121`}
          aria-label="筛选板块"
        />
        {q && (
          <button className="btn ghost" onClick={() => setQ('')}>
            清除
          </button>
        )}
      </div>

      <div className="note small">
        {meta.note}；点板块看指数 K 线、成分股、相关新闻与 AI 解读。默认按涨幅排名，点表头可切换。
      </div>
      {err && <div className="note err">{err}</div>}

      {!loading && !err && shown.length === 0 && (
        <div className="note">没有匹配的{meta.label}，换个关键词试试。</div>
      )}

      {shown.length > 0 && (
        <ul
          className="boards boards-wide"
          style={{ '--board-cols': statCols.length } as CSSProperties}
        >
          <li className="board-row board-head">
            <span className="board-rank dim" />
            {headCell('name', '名称', 'board-head-name')}
            <span className="board-code dim" />
            {statCols.map((c) => headCell(c.key, c.label))}
            {headCell('changePct', PCT_LABEL, 'board-head-num board-head-pct')}
          </li>
          {shown.map((b) => (
            <li key={b.secid}>
              <button
                className="board-row"
                title="查看板块详情"
                onClick={() =>
                  onPick({
                    kind: 'board',
                    secid: b.secid,
                    code: b.code,
                    name: b.name,
                    market: 'cn',
                    cid: b.cid ?? null,
                  })
                }
              >
                <span className="board-rank">{rankOf.get(b.secid)}</span>
                <span className="board-name">{b.name}</span>
                <span className="board-code dim">{b.code}</span>
                {statCols.map((c) => statCell(b, c))}
                <span className={`board-pct ${trendClass(b.changePct, 'cn')}`}>
                  {fmtSigned(b.changePct, 2, '%')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {missing > 0 && (
        <div className="note small">
          有 {missing} 个{meta.label}暂无「{sortLabel}」数据（上游列表分页限流时会缺），
          已排在末尾；K 线和成分股不受影响。
        </div>
      )}
      {!loading && boards.length > 0 && (
        <div className="note small">共 {boards.length} 个{meta.label}，已全部列出。</div>
      )}
    </div>
  )
}
