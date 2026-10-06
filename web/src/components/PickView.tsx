import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchRecommend, fetchRecommendDates } from '../api'
import type { RecommendStock } from '../types'

const fmt = (n: number | null | undefined, d = 2) =>
  n == null || Number.isNaN(Number(n)) ? '—' : Number(n).toFixed(d)

const yi = (n: number | null | undefined) =>
  n == null ? '—' : n >= 1e8 ? `${(n / 1e8).toFixed(2)} 亿` : `${(n / 1e4).toFixed(0)} 万`

const tone = (n: number | null | undefined) =>
  n == null ? 'dim' : n > 0 ? 'up' : n < 0 ? 'down' : 'dim'

/** 0~1 的比例转成整数百分比字符串（null 安全）。 */
const pctStr = (n: number | null | undefined) =>
  n == null ? '—' : `${Math.round(n * 100)}%`

/** 带符号的百分比，null 显示为 —。 */
const signedPct = (n: number | null | undefined) =>
  n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)}%`

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const pad2 = (n: number) => String(n).padStart(2, '0')
const monthOf = (iso: string) => iso.slice(0, 7)
const addMonth = (ym: string, delta: number) => {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + delta, 1))
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`
}
/** 该月的日历格子：前置空格补齐到周日开头，后面是 YYYY-MM-DD。 */
const monthCells = (ym: string): (string | null)[] => {
  const [y, m] = ym.split('-').map(Number)
  const firstWd = new Date(Date.UTC(y, m - 1, 1)).getUTCDay()
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const cells: (string | null)[] = []
  for (let i = 0; i < firstWd; i += 1) cells.push(null)
  for (let d = 1; d <= days; d += 1) cells.push(`${ym}-${pad2(d)}`)
  return cells
}

/** 当日推荐的整体盈亏：等权平均（每只票等权，不是按市值/金额加权）。
 *
 *  两套口径分开看，因为它们回答不同问题：
 *  - `hold`：按**各自**的 AI 持有周期算（3/5/10/20 各不相同）。这是「照 AI 的建议拿着」的真实结果。
 *  - `since`：从推荐日到最新。回答「那天推荐之后整体如何」，不受持有周期影响 —— 适合看**信号本身**准不准。
 *  周期未走完（holdDone=false）的票已按现价截至当日折算，不是漏掉；但要意识到分母里混着
 *  「才持有 1 天」和「已持有 20 天」的票，平均数的含义会随持仓进度漂移。 */
function pickSummary(top: RecommendStock[] | undefined) {
  const list = top || []
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
  const hold = list.map((s) => s.holdPct).filter((v): v is number => v != null)
  const since = list.map((s) => s.sincePickPct).filter((v): v is number => v != null)
  // 基准（沪深300）同期涨跌：会随各股持有周期不同而不同，所以同样取等权平均。
  // 只在「该股有 holdPct/sincePickPct」时计入，保证与收益列是**同一批样本**、可直接相减。
  const holdIdx = list.filter((s) => s.holdPct != null && s.holdIdxPct != null).map((s) => s.holdIdxPct as number)
  const sinceIdx = list
    .filter((s) => s.sincePickPct != null && s.sinceIdxPct != null)
    .map((s) => s.sinceIdxPct as number)
  const up = (xs: number[]) => xs.filter((v) => v > 0).length
  const done = list.filter((s) => s.holdDone).length
  const holdMean = mean(hold)
  const sinceMean = mean(since)
  const holdIdxMean = mean(holdIdx)
  const sinceIdxMean = mean(sinceIdx)
  return {
    holdPct: holdMean,
    holdWin: hold.length ? up(hold) / hold.length : null,
    sincePct: sinceMean,
    sinceWin: since.length ? up(since) / since.length : null,
    holdIdxPct: holdIdxMean,
    sinceIdxPct: sinceIdxMean,
    holdAlpha: holdMean != null && holdIdxMean != null ? holdMean - holdIdxMean : null,
    sinceAlpha: sinceMean != null && sinceIdxMean != null ? sinceMean - sinceIdxMean : null,
    holdN: hold.length,
    sinceN: since.length,
    doneN: done,
    total: list.length,
  }
}

/** 每日推荐：成交额初筛 → 模型选股 → AI「值得买入」评估的 Top10，点开看详情。 */
export default function PickView({ onPick }: { onPick: (s: { code: string; name: string; secid: string }) => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchRecommend>>>(null)
  const [dates, setDates] = useState<string[]>([])
  const [date, setDate] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [openCode, setOpenCode] = useState<string | null>(null)
  const [calOpen, setCalOpen] = useState(false)
  const [calMonth, setCalMonth] = useState('')
  /** 日历头部弹出的是「年 / 月」选择面板（'' = 未开、'year' | 'month'） */
  const [calPick, setCalPick] = useState<'' | 'year' | 'month'>('')
  const dateRef = useRef('')
  const latestRef = useRef('')
  const pickRef = useRef<(d: string) => void>(() => {})

  useEffect(() => {
    dateRef.current = date
  }, [date])
  useEffect(() => {
    latestRef.current = dates[0] || ''
  }, [dates])

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

  // 实时：轮询榜单日期。跑批过程中新生成的一天会自动出现；当前停在最新/未选时自动切过去。
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const r = await fetchRecommendDates()
        const newest = r.dates[0] || ''
        setDates(r.dates)
        if (newest && newest !== latestRef.current && (!dateRef.current || dateRef.current === latestRef.current)) {
          pickRef.current(newest)
        }
      } catch {
        /* 忽略轮询失败 */
      }
    }, 15000)
    return () => clearInterval(timer)
  }, [])

  const pickDate = (d: string) => {
    setDate(d)
    setOpenCode(null)
    setCalOpen(false)
    setCalPick('')
    void load(d)
  }
  pickRef.current = pickDate
  const dateSet = new Set(dates)
  const summary = useMemo(() => pickSummary(data?.top), [data])

  // 相邻榜单：dates 是降序（新→旧），所以「后一天/前一天」对应索引 -1 / +1。
  // 只跳到**确实有榜单的日期**，跳过没有推荐的交易日（不落空）。
  const curIdx = dates.indexOf(date)
  const newerDate = curIdx > 0 ? dates[curIdx - 1] : null
  const olderDate = curIdx >= 0 && curIdx < dates.length - 1 ? dates[curIdx + 1] : null

  // 年月选择器：只列出**确实有榜单**的年份 / 月份，避免点进去是空的。
  const years = useMemo(() => [...new Set(dates.map((d) => d.slice(0, 4)))].sort().reverse(), [dates])
  const curYear = (calMonth || date || dates[0] || '').slice(0, 4)

  if (loading) return <div className="rec-wrap"><div className="note">加载推荐…</div></div>
  if (error) return <div className="rec-wrap"><div className="note">推荐加载失败：{error}</div></div>
  if (!data || !data.top?.length) {
    return (
      <div className="rec-wrap">
        <div className="rec-head">
          <h2>每日推荐</h2>
        </div>
        <div className="note">
          今日推荐尚未生成。服务器会在收盘后自动跑：稳健池（沪深300+创业板+科创板）→ 客观初筛 →
          多因子选股（反转 + 上影线 + 年化ROE）→ AI 逐只解读，挑出 Top10。
        </div>
      </div>
    )
  }

  return (
    <div className="rec-wrap">
      <div className="rec-head">
        <h2>每日推荐</h2>
        <span className="note small">
          {data.date} 生效 · 成交额 {data.pool.size} → 初筛 {data.pool.filtered ?? '—'} → 评估 {data.pool.candidates} → Top{data.top.length}
          {data.basisDate ? ` · 基准 ${data.basisDate} 收盘` : ''}
        </span>
        {dates.length > 0 && (
          <div className="rec-dates">
            <button
              type="button"
              className="rec-nav-btn"
              disabled={!olderDate}
              onClick={() => olderDate && pickDate(olderDate)}
              title={olderDate ? `前一天（${olderDate}）` : '已经是最早一天'}
              aria-label="前一天"
            >
              ‹
            </button>
            <button
              type="button"
              className="rec-date-btn"
              onClick={() => {
                setCalMonth(monthOf(date || dates[0]))
                setCalPick('')
                setCalOpen((o) => !o)
              }}
              aria-expanded={calOpen}
            >
              {date || '选择日期'} <span className="dim">▾</span>
            </button>
            <button
              type="button"
              className="rec-nav-btn"
              disabled={!newerDate}
              onClick={() => newerDate && pickDate(newerDate)}
              title={newerDate ? `后一天（${newerDate}）` : '已经是最新一天'}
              aria-label="后一天"
            >
              ›
            </button>
            {calOpen && (
              <div className="rec-cal" role="dialog" aria-label="选择推荐日期">
                <div className="rec-cal-head">
                  <button
                    type="button"
                    onClick={() => {
                      setCalPick('')
                      setCalMonth(addMonth(calMonth, -1))
                    }}
                    aria-label="上月"
                  >
                    ‹
                  </button>
                  <div className="rec-cal-title">
                    <button
                      type="button"
                      className={`rec-cal-ym${calPick === 'year' ? ' is-open' : ''}`}
                      onClick={() => setCalPick((p) => (p === 'year' ? '' : 'year'))}
                      aria-label="选择年份"
                    >
                      {curYear} <span className="dim">年</span>
                    </button>
                    <button
                      type="button"
                      className={`rec-cal-ym${calPick === 'month' ? ' is-open' : ''}`}
                      onClick={() => setCalPick((p) => (p === 'month' ? '' : 'month'))}
                      aria-label="选择月份"
                    >
                      {Number((calMonth || date || dates[0] || '').slice(5, 7))} <span className="dim">月</span>
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setCalPick('')
                      setCalMonth(addMonth(calMonth, 1))
                    }}
                    aria-label="下月"
                  >
                    ›
                  </button>
                </div>
                {calPick === 'year' && (
                  <div className="rec-cal-pick rec-cal-pick-year">
                    {years.map((y) => (
                      <button
                        type="button"
                        key={y}
                        className={y === curYear ? 'is-sel' : ''}
                        onClick={() => {
                          // 切年时保留月份（若该年无该月，回落到该年有榜单的最近一月）
                          const mm = (calMonth || '').slice(5, 7) || (date || dates[0] || '').slice(5, 7)
                          const has = dates.some((d) => d.startsWith(`${y}-${mm}`))
                          const fallback = dates.find((d) => d.startsWith(y))?.slice(0, 7)
                          setCalMonth(has ? `${y}-${mm}` : fallback || `${y}-${mm}`)
                          setCalPick('')
                        }}
                      >
                        {y}
                      </button>
                    ))}
                  </div>
                )}
                {calPick === 'month' && (
                  <div className="rec-cal-pick rec-cal-pick-month">
                    {Array.from({ length: 12 }, (_, i) => pad2(i + 1)).map((mm) => {
                      const ym = `${curYear}-${mm}`
                      const has = dates.some((d) => d.startsWith(ym))
                      return (
                        <button
                          type="button"
                          key={mm}
                          className={ym === calMonth ? 'is-sel' : ''}
                          disabled={!has}
                          onClick={() => {
                            setCalMonth(ym)
                            setCalPick('')
                          }}
                        >
                          {Number(mm)}
                        </button>
                      )
                    })}
                  </div>
                )}
                <div className="rec-cal-week">
                  {WEEKDAYS.map((w) => (
                    <span key={w}>{w}</span>
                  ))}
                </div>
                <div className="rec-cal-grid">
                  {monthCells(calMonth).map((d, i) =>
                    d ? (
                      <button
                        type="button"
                        key={d}
                        className={`rec-cal-day${d === date ? ' is-sel' : ''}${dateSet.has(d) ? ' has' : ''}`}
                        disabled={!dateSet.has(d)}
                        onClick={() => pickDate(d)}
                      >
                        {Number(d.slice(8))}
                      </button>
                    ) : (
                      <span key={`e${i}`} className="rec-cal-day is-empty" />
                    ),
                  )}
                </div>
                <div className="rec-cal-foot">
                  <span className="dim">有榜单的日期可点</span>
                  <button type="button" className="btn ghost" onClick={() => pickDate(dates[0])}>
                    最新
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="rec-perf">
        <div className="rec-perf-lead">
          当日推荐整体盈亏
          <span className="dim small">
            {summary.total} 只 · 等权平均 · {data.basisDate ? `基准 ${data.basisDate} 收盘` : '推荐日收盘'}
          </span>
        </div>
        <div className="rec-perf-grid">
          <div className="rec-perf-cell">
            <span className="rec-perf-k">照 AI 持有周期</span>
            <b className={tone(summary.holdPct)}>{signedPct(summary.holdPct)}</b>
            <span className="dim small">
              {summary.holdN ? `${pctStr(summary.holdWin)} 上涨 · ${summary.doneN}/${summary.total} 周期已走完` : '暂无数据'}
            </span>
          </div>
          <div className="rec-perf-cell">
            <span className="rec-perf-k">推荐日至今</span>
            <b className={tone(summary.sincePct)}>{signedPct(summary.sincePct)}</b>
            <span className="dim small">{summary.sinceN ? `${pctStr(summary.sinceWin)} 上涨` : '暂无数据'}</span>
          </div>
        </div>
        <div className="rec-perf-bench">
          <div className="rec-perf-bench-lead">
            {data.benchName || '沪深300'} 同期
            <span className="dim small">同一持有窗口·等权平均</span>
          </div>
          <div className="rec-perf-grid">
            <div className="rec-perf-cell">
              <span className="rec-perf-k">照 AI 持有周期</span>
              <b className={tone(summary.holdIdxPct)}>{signedPct(summary.holdIdxPct)}</b>
              <span className="rec-perf-alpha">
                推荐组合超额{' '}
                <em className={tone(summary.holdAlpha)}>{signedPct(summary.holdAlpha)}</em>
              </span>
            </div>
            <div className="rec-perf-cell">
              <span className="rec-perf-k">推荐日至今</span>
              <b className={tone(summary.sinceIdxPct)}>{signedPct(summary.sinceIdxPct)}</b>
              <span className="rec-perf-alpha">
                推荐组合超额{' '}
                <em className={tone(summary.sinceAlpha)}>{signedPct(summary.sinceAlpha)}</em>
              </span>
            </div>
          </div>
        </div>
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
        榜单由程序按「稳健池 → 客观初筛 → 多因子选股（反转 + 上影线 + 年化ROE）→ AI 解读」自动生成，仅供研究参考，
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
        <span className={`rec-day ${tone(stock.changePct)}`}>{fmt(stock.changePct)}%</span>
        <span
          className={`rec-since ${tone(stock.sincePickPct)}`}
          title="按推荐日收盘价买入、持有至今的涨跌幅（盘中为实时价）"
        >
          自推荐涨幅{' '}
          {stock.sincePickPct == null ? '—' : `${stock.sincePickPct > 0 ? '+' : ''}${fmt(stock.sincePickPct)}%`}
        </span>
        <span
          className={`rec-hold ${tone(stock.holdPct)}`}
          title="按 AI 建议持有周期的涨幅（推荐日收盘 → 之后第 N 个交易日收盘）"
        >
          AI周期 {stock.holdDays == null ? '—' : stock.holdDays}日{' '}
          {stock.holdDone
            ? stock.holdPct == null
              ? '—'
              : `${stock.holdPct > 0 ? '+' : ''}${fmt(stock.holdPct)}%`
            : stock.holdDays == null
              ? '—'
              : '进行中'}
        </span>
        {ai?.buyScore != null && <span className="rec-score">买入 {ai.buyScore}</span>}
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
