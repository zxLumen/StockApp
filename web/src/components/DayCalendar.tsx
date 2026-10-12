import { useMemo, useState } from 'react'

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

/**
 * 日期选择器：`‹ 日期 ›` + 弹出月历（年 / 月切换 + 「最新」），「每日推荐」与「模拟推荐持仓」共用，
 * 保证两处的回看形式一致。
 *
 * - `value`：当前选中；`latestValue` 表示「最新」态（持仓页用 `''` 表示含盘中的最新口径）。
 * - 只有 `dates` 里的日期可点；上/下一天也只在这些日期间跳（跳过无数据的交易日/假日）。
 */
export default function DayCalendar({
  dates,
  value,
  onChange,
  latestValue = '',
  hint = '有数据的日期可点',
}: {
  dates: string[]
  value: string
  onChange: (d: string) => void
  latestValue?: string
  hint?: string
}) {
  const [open, setOpen] = useState(false)
  const [calMonth, setCalMonth] = useState('')
  const [calPick, setCalPick] = useState<'' | 'year' | 'month'>('')

  const asc = useMemo(() => [...dates].sort(), [dates])
  const dateSet = useMemo(() => new Set(dates), [dates])
  const years = useMemo(() => [...new Set(dates.map((d) => d.slice(0, 4)))].sort().reverse(), [dates])

  // 相邻日按**真实索引**算（只跳有数据的交易日，跳过周末/假日）。当 `latestValue` 指向一个不在
  // dates 里的值（持仓页的 `''`）时，视作序列末尾之后多一个「最新」格：最末交易日往后一天 = 最新。
  const idx = dateSet.has(value) ? asc.indexOf(value) : -1
  const hasLatestSlot = latestValue === '' || !dateSet.has(latestValue)
  const olderDate = idx > 0 ? asc[idx - 1] : idx < 0 && hasLatestSlot ? asc[asc.length - 1] : null
  const newerDate =
    idx >= 0 && idx < asc.length - 1
      ? asc[idx + 1]
      : idx === asc.length - 1 && hasLatestSlot
        ? latestValue
        : null
  // 弹窗锚点 / 选中高亮：value 为空（「最新」态）时落在最末交易日那天。
  const anchor = dateSet.has(value) ? value : asc[asc.length - 1] || ''

  if (!dates.length) return null

  const curYear = (calMonth || anchor || dates[0] || '').slice(0, 4)
  const pick = (d: string) => {
    onChange(d)
    setOpen(false)
    setCalPick('')
  }
  const toggle = () => {
    setCalMonth(monthOf(anchor || dates[0]))
    setCalPick('')
    setOpen((o) => !o)
  }
  const label = value ? value : latestValue === '' ? '最新' : '选择日期'

  return (
    <div className="rec-dates">
      <button
        type="button"
        className="rec-nav-btn"
        disabled={!olderDate}
        onClick={() => olderDate && pick(olderDate)}
        title={olderDate ? `前一天（${olderDate}）` : '已经是最早一天'}
        aria-label="前一天"
      >
        ‹
      </button>
      <button type="button" className="rec-date-btn" onClick={toggle} aria-expanded={open}>
        {label} <span className="dim">▾</span>
      </button>
      <button
        type="button"
        className="rec-nav-btn"
        disabled={!newerDate}
        onClick={() => newerDate && pick(newerDate)}
        title={newerDate ? `后一天（${newerDate}）` : '已经是最新一天'}
        aria-label="后一天"
      >
        ›
      </button>
      {open && (
        <div className="rec-cal" role="dialog" aria-label="选择日期">
          <div className="rec-cal-head">
            <button
              type="button"
              onClick={() => {
                setCalPick('')
                setCalMonth(addMonth(calMonth || monthOf(anchor || dates[0]), -1))
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
                {Number((calMonth || anchor || dates[0] || '').slice(5, 7))} <span className="dim">月</span>
              </button>
            </div>
            <button
              type="button"
              onClick={() => {
                setCalPick('')
                setCalMonth(addMonth(calMonth || monthOf(anchor || dates[0]), 1))
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
                    // 切年时保留月份（若该年无该月，回落到该年有数据的最近一月）
                    const mm = (calMonth || '').slice(5, 7) || (anchor || dates[0]).slice(5, 7)
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
                    className={ym === (calMonth || monthOf(anchor || dates[0])) ? 'is-sel' : ''}
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
            {monthCells(calMonth || monthOf(anchor || dates[0])).map((d, i) =>
              d ? (
                <button
                  type="button"
                  key={d}
                  className={`rec-cal-day${d === anchor ? ' is-sel' : ''}${dateSet.has(d) ? ' has' : ''}`}
                  disabled={!dateSet.has(d)}
                  onClick={() => pick(d)}
                >
                  {Number(d.slice(8))}
                </button>
              ) : (
                <span key={`e${i}`} className="rec-cal-day is-empty" />
              ),
            )}
          </div>
          <div className="rec-cal-foot">
            <span className="dim">{hint}</span>
            <button type="button" className="btn ghost" onClick={() => pick(latestValue)}>
              最新
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
