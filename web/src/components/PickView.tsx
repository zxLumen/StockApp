import { useCallback, useEffect, useState } from 'react'
import { fetchRecommend, fetchRecommendDates } from '../api'
import type { RecommendStock } from '../types'

const fmt = (n: number | null | undefined, d = 2) =>
  n == null || Number.isNaN(Number(n)) ? '—' : Number(n).toFixed(d)

const yi = (n: number | null | undefined) =>
  n == null ? '—' : n >= 1e8 ? `${(n / 1e8).toFixed(2)} 亿` : `${(n / 1e4).toFixed(0)} 万`

const tone = (n: number | null | undefined) =>
  n == null ? 'dim' : n > 0 ? 'up' : n < 0 ? 'down' : 'dim'

/** 每日推荐：近一月 Top100 的 AI 解读里挑出的 Top10，点开看详情。 */
export default function PickView({ onPick }: { onPick: (s: { code: string; name: string; secid: string }) => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchRecommend>>>(null)
  const [dates, setDates] = useState<string[]>([])
  const [date, setDate] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [openCode, setOpenCode] = useState<string | null>(null)

  const load = useCallback(async (d?: string) => {
    setLoading(true)
    setError('')
    try {
      const payload = await fetchRecommend(d)
      setData(payload)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchRecommendDates()
      .then((r) => {
        setDates(r.dates)
        setDate(r.dates[0] || '')
      })
      .catch(() => setDates([]))
    void load()
  }, [load])

  const pickDate = (d: string) => {
    setDate(d)
    setOpenCode(null)
    void load(d)
  }

  if (loading) return <div className="rec-wrap"><div className="note">加载推荐…</div></div>
  if (error) return <div className="rec-wrap"><div className="note">推荐加载失败：{error}</div></div>
  if (!data || !data.top?.length) {
    return (
      <div className="rec-wrap">
        <div className="rec-head">
          <h2>每日推荐</h2>
        </div>
        <div className="note">
          今日推荐尚未生成。服务器会在收盘后自动跑：对成交额前 500 的近一月涨幅 Top100 做 AI 解读，
          再由 AI 二次评审挑出 Top10。
        </div>
      </div>
    )
  }

  return (
    <div className="rec-wrap">
      <div className="rec-head">
        <h2>每日推荐</h2>
        <span className="note small">
          {data.date} 生效 · 候选池 {data.pool.size} 只 → 解读 {data.pool.candidates} 只 → Top{data.top.length}
          {data.basisDate ? ` · 基准 ${data.basisDate} 收盘` : ''}
        </span>
        {dates.length > 0 && (
          <label className="rec-dates">
            推荐历史
            <select className="rec-date" value={date} onChange={(e) => pickDate(e.target.value)}>
              {dates.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <ol className="rec-list">
        {data.top.map((s, i) => (
          <PickCard
            key={s.code}
            rank={i + 1}
            stock={s}
            open={openCode === s.code}
            onToggle={() => setOpenCode(openCode === s.code ? null : s.code)}
            onDetail={() => onPick({ code: s.code, name: s.name, secid: s.secid })}
          />
        ))}
      </ol>

      <div className="note small">
        榜单为程序按「近一月涨幅 + AI 解读」自动生成，仅供研究参考，
        <strong>不构成投资建议</strong>。
      </div>
    </div>
  )
}

function PickCard({
  rank,
  stock,
  open,
  onToggle,
  onDetail,
}: {
  rank: number
  stock: RecommendStock
  open: boolean
  onToggle: () => void
  onDetail: () => void
}) {
  const ai = stock.ai
  // AI 解读明细默认展开（用户要求）。
  const [openAi, setOpenAi] = useState(true)
  const hasDetail = !!(ai?.catalysts?.length || ai?.risks?.length || ai?.tags?.length)
  return (
    <li className={`rec-card${open ? ' is-open' : ''}`}>
      <div className="rec-row" onClick={onToggle} role="button" tabIndex={0}>
        <span className="rec-rank">{rank}</span>
        <span className="rec-name">
          {stock.name}
          <span className="dim small"> {stock.code}</span>
        </span>
        <span className={`rec-month ${tone(stock.monthPct)}`}>近一月 {fmt(stock.monthPct)}%</span>
        <span className={`rec-day ${tone(stock.changePct)}`}>{fmt(stock.changePct)}%</span>
        <span className={`rec-since ${tone(stock.sincePickPct)}`} title="自推荐日基准价到最新（盘中为实时价）">
          自推荐 {stock.sincePickPct == null ? '—' : `${stock.sincePickPct > 0 ? '+' : ''}${fmt(stock.sincePickPct)}%`}
        </span>
        {ai?.score != null && <span className="rec-score">评分 {ai.score}</span>}
        <span className="rec-toggle dim">{open ? '收起' : '展开'}</span>
      </div>

      {/* 摘要单独一行：卡片收起也一眼可见 */}
      {ai?.summary && <div className="rec-summary">{ai.summary}</div>}

      {open && (
        <div className="rec-detail">
          <div className="rec-stats">
            <span>现价 {fmt(stock.price)}</span>
            <span>成交额 {yi(stock.amount)}</span>
            <span>换手 {fmt(stock.turnover)}%</span>
            <span>总市值 {yi(stock.mktcap)}</span>
          </div>

          {ai?.error && <div className="note small">AI 解读失败：{ai.error}</div>}

          {hasDetail ? (
            <div className={`rec-ai${openAi ? ' is-open' : ''}`}>
              <button className="rec-ai-head" onClick={() => setOpenAi(!openAi)} aria-expanded={openAi}>
                <span className="rec-ai-arrow">{openAi ? '▾' : '▸'}</span> AI 解读详情
              </button>
              {openAi && (
                <div className="rec-ai-body">
                  {!!ai?.catalysts?.length && (
                    <div className="rec-block">
                      <div className="rec-block-title up">支撑逻辑</div>
                      <ul>
                        {ai.catalysts.map((c, i) => (
                          <li key={i}>{c}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {!!ai?.risks?.length && (
                    <div className="rec-block">
                      <div className="rec-block-title down">风险</div>
                      <ul>
                        {ai.risks.map((c, i) => (
                          <li key={i}>{c}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {!!ai?.tags?.length && (
                    <div className="rec-tags">
                      {ai.tags.map((t, i) => (
                        <span key={i} className="rec-tag">
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="note small">（本次 AI 未产出解读明细）</div>
          )}

          <button className="btn ghost" onClick={onDetail}>
            查看 K 线
          </button>
        </div>
      )}
    </li>
  )
}
