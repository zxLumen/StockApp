// 跨整页刷新（含被博客 iframe 重建）保持 UI 会话态。
// 约定见主站 docs/APP-EMBED.md：键前缀 zx-app-state:<appId>:，值 JSON，建议带 v 版本号。
import { useEffect, useRef, useState } from 'react'

const PREFIX = 'zx-app-state:stock:'

export function readState<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(PREFIX + key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as { v: number; data: T }
    return parsed?.data ?? fallback
  } catch {
    return fallback
  }
}

export function writeState<T>(key: string, value: T): void {
  try {
    sessionStorage.setItem(PREFIX + key, JSON.stringify({ v: 1, data: value }))
  } catch {
    /* 隐私模式 / 超限：忽略即可 */
  }
}

/** 同步读初始值（刷新后不闪空白）+ 变化时回写。 */
export function useSessionState<T>(key: string, initial: T | (() => T)) {
  const [state, setState] = useState<T>(() =>
    readState(key, typeof initial === 'function' ? (initial as () => T)() : initial),
  )
  useEffect(() => {
    writeState(key, state)
  }, [key, state])
  return [state, setState] as const
}

/** 高频值（流式文本等）防抖写入。 */
export function useDebouncedSessionState<T>(key: string, value: T, delay = 400): void {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    if (!key) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => writeState(key, value), delay)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [key, value, delay])
}