import { useState } from 'react'
import { fmtTime } from '../format'
import type { NewsItem } from '../types'

interface Props {
  items: NewsItem[]
  /** 折叠时显示几条；其余靠「展开」露出来。 */
  collapsed?: number
  /** 空列表时的提示文案。 */
  empty?: string
}

/** 折叠态固定显示的条数。 */
export const NEWS_COLLAPSED = 10

/**
 * 新闻列表：默认只给 Top 10，剩下的由用户点「展开」自己放出来。
 *
 * 为什么不一次性全渲染：热点新闻一屏 10 条刚好，再多就得滚动；而且
 * 「用户主动展开」是需求 —— 默认摊开等于替用户做了决定。
 *
 * 数据是一次性取够的（见 api.ts 的 NEWS_FETCH_LIMIT），展开是纯本地切片，
 * 所以点开是瞬时的，也不会再多打一次上游。
 *
 * 展开状态是组件本地的；换标的 / 换市场时调用方应传 `key` 重挂，让它回到折叠态。
 */
export default function NewsList({ items, collapsed = NEWS_COLLAPSED, empty }: Props) {
  const [open, setOpen] = useState(false)
  if (!items.length) return <div className="note">{empty ?? '暂无相关新闻。'}</div>

  const shown = open ? items : items.slice(0, collapsed)
  const rest = items.length - collapsed

  return (
    <>
      <ul className="news">
        {shown.map((n, i) => (
          <li key={`${n.url ?? n.title}-${i}`}>
            <a href={n.url ?? '#'} target="_blank" rel="noreferrer noopener">
              <span className="news-title">{n.title}</span>
              <span className="news-meta">
                {n.source}
                {n.time ? ` · ${fmtTime(n.time)}` : ''}
              </span>
            </a>
          </li>
        ))}
      </ul>
      {rest > 0 && (
        <button type="button" className="news-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? '收起' : `展开其余 ${rest} 条`}
        </button>
      )}
    </>
  )
}
