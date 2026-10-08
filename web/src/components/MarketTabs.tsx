import type { Market } from '../types'

const TABS: { key: Market; label: string }[] = [
  { key: 'board', label: '板块' },
  { key: 'pick', label: '推荐' },
  { key: 'positions', label: '模拟推荐持仓' },
  { key: 'cn', label: '沪深港' },
  { key: 'us', label: '美股' },
  { key: 'fund', label: '基金' },
]

export default function MarketTabs({
  value,
  onChange,
}: {
  value: Market
  onChange: (m: Market) => void
}) {
  return (
    <div className="tabs" role="tablist">
      {TABS.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={value === t.key}
          className={`tab${value === t.key ? ' is-active' : ''}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}