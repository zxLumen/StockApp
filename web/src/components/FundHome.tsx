import { useEffect, useState } from 'react'
import { fetchFundHot, fetchFundQuotes, fetchFundRank } from '../api'
import { fmtNum, fmtSigned, trendClass } from '../format'
import type { FundItem, FundPickGroup, FundRankItem, WatchItem } from '../types'

interface Props {
  watchedFunds: WatchItem[]
  onPick: (code: string, name: string) => void
  onRemove: (w: WatchItem) => void
}

type SortKey = 'd1' | 'w1' | 'm1' | 'y1'

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'd1', label: '日涨幅' },
  { key: 'w1', label: '近1周' },
  { key: 'm1', label: '近1月' },
  { key: 'y1', label: '近1年' },
]

/**
 * 「基金」页签的落地页：净值榜（区间涨幅排序）+ 按分类精选的代表性基金 + 我的自选。
 * 三个数据源互相独立，任一块挂了不影响其它两块。
 */
export default function FundHome({ watchedFunds, onPick, onRemove }: Props) {
  const [sort, setSort] = useState<SortKey>('d1')
  const [rank, setRank] = useState<FundRankItem[]>([])
  const [rankErr, setRankErr] = useState('')
  const [rankLoading, setRankLoading] = useState(true)
  const [groups, setGroups] = useState<FundPickGroup[]>([])
  const [hotErr, setHotErr] = useState('')
  const [myNav, setMyNav] = useState<FundItem[]>([])

  useEffect(() => {
    const ac = new AbortController()
    setRankLoading(true)
    setRankErr('')
    fetchFundRank(sort, 20, ac.signal)
      .then((r) => setRank(r.items))
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === 'AbortError') return
        setRank([])
        setRankErr(e instanceof Error ? e.message : '榜单加载失败')
      })
      .finally(() => setRankLoading(false))
    return () => ac.abort()
  }, [sort])

  useEffect(() => {
    const ac = new AbortController()
    fetchFundHot(ac.signal)
      .then((r) => setGroups(r.groups))
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === 'AbortError') return
        setGroups([])
        setHotErr(e instanceof Error ? e.message : '精选加载失败')
      })
    return () => ac.abort()
  }, [])

  // 自选基金的净值：进页面先按代码批量取一次，之后每分钟刷新（净值一天只更新一次，够用）
  useEffect(() => {
    const codes = watchedFunds.map((w) => w.code).filter((c) => /^\d{6}$/.test(c))
    if (!codes.length) {
      setMyNav([])
      return
    }
    const ac = new AbortController()
    const load = () =>
      fetchFundQuotes(codes, ac.signal)
        .then((r) => setMyNav(r.items))
        .catch(() => undefined)
    void load()
    const timer = window.setInterval(load, 60_000)
    return () => {
      ac.abort()
      window.clearInterval(timer)
    }
  }, [watchedFunds])

  const navOf = (code: string) => myNav.find((f) => f.code === code)

  return (
    <div className="home">
      <section>
        <h2 className="sec-title">净值榜</h2>
        <div className="note small">
          按区间涨幅排序的场外基金实时榜，仅作行情速览，不构成任何推荐。
        </div>
        <div className="periods">
          {SORTS.map((s) => (
            <button
              key={s.key}
              className={`chip${sort === s.key ? ' on' : ''}`}
              onClick={() => setSort(s.key)}
            >
              {s.label}
            </button>
          ))}
        </div>
        {rankErr && <div className="note err">榜单暂不可用：{rankErr}</div>}
        <div className="rank-list">
          {rank.map((r) => {
            const v = r[sort]
            return (
              <button key={r.code} className="rank-row" onClick={() => onPick(r.code, r.name)}>
                <span className="rank-name">{r.name}</span>
                <span className="rank-code dim">{r.code}</span>
                <span className="rank-nav">{fmtNum(r.nav, 4)}</span>
                <span className={`rank-chg ${trendClass(v, 'fund')}`}>{fmtSigned(v, 2, '%')}</span>
              </button>
            )
          })}
          {rankLoading &&
            rank.length === 0 &&
            [0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="rank-row skeleton" aria-hidden />)}
          {!rankLoading && rank.length === 0 && !rankErr && <div className="note">暂无榜单数据</div>}
        </div>
        <div className="note small">点击任意一行查看净值曲线。</div>
      </section>

      <section>
        <h2 className="sec-title">分类精选</h2>
        {hotErr && <div className="note err">精选暂不可用：{hotErr}</div>}
        {groups.map((g) => (
          <div key={g.key} className="pick-group">
            <div className="pick-head">
              <span className="pick-label">{g.label}</span>
              {g.hint && <span className="dim small">{g.hint}</span>}
            </div>
            <div className="pick-grid">
              {g.funds.map((f) => (
                <button key={f.code} className="pick-card" onClick={() => onPick(f.code, f.name)}>
                  <span className="pick-name">{f.name}</span>
                  <span className="pick-meta">
                    <span>净值 {fmtNum(f.nav, 4)}</span>
                    <span className={trendClass(f.changePct, 'fund')}>
                      {fmtSigned(f.changePct, 2, '%')}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
        {!groups.length && !hotErr && rankLoading && (
          <div className="pick-grid">
            {[0, 1, 2].map((i) => (
              <div key={i} className="pick-card skeleton" aria-hidden />
            ))}
          </div>
        )}
      </section>

      {watchedFunds.length > 0 && (
        <section>
          <h2 className="sec-title">我的自选</h2>
          <ul className="watch wide">
            {watchedFunds.map((w) => {
              const q = navOf(w.code)
              return (
                <li key={w.secid}>
                  <button className="watch-main" onClick={() => onPick(w.code, w.name)}>
                    <span className="watch-name">{w.name}</span>
                    <span className="watch-code dim">{w.code}</span>
                    <span className={`watch-nav ${trendClass(q?.changePct, 'fund')}`}>
                      {q ? `${fmtNum(q.nav, 4)} ${fmtSigned(q.changePct, 2, '%')}` : '净值加载中…'}
                    </span>
                  </button>
                  <button className="watch-del" title="移除" onClick={() => onRemove(w)}>
                    ×
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      <section>
        <div className="note small">
          在上方搜索框输入基金名称或代码（如「沪深300」「000961」）可查看任意基金的净值曲线。
        </div>
      </section>
    </div>
  )
}