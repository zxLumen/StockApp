import { useEffect, useRef } from 'react'
import type { Market } from '../types'

const TABS: { key: Market; label: string }[] = [
  { key: 'board', label: '板块' },
  { key: 'pick', label: '推荐' },
  { key: 'positions', label: '模拟推荐持仓' },
  { key: 'lab', label: '策略实验室' },
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
  const listRef = useRef<HTMLDivElement | null>(null)

  // 手机端页签横向滚动：切页 / 恢复会话态时把当前页签滚进可视区，避免「高亮在屏幕外」。
  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('.tab.is-active')
    active?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [value])

  return (
    <div className="tabs" role="tablist" ref={listRef}>
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
