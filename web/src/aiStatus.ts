import type { AiState } from './types'

const APP_ID = 'stock'

/**
 * 向宿主博客上报 AI 状态（协议见主站 docs/AI-STATUS.md）。
 * 目标 origin 必须取自 document.referrer，取不到就静默不报——退化成 '*' 等于把状态广播给任意页面。
 */
export function reportAiState(state: AiState, detail?: string): void {
  if (window.parent === window) return
  const referrer = document.referrer
  if (!referrer) return
  let host: string
  try {
    host = new URL(referrer).origin
  } catch {
    return
  }
  try {
    window.parent.postMessage({ type: 'zx:ai-status', app: APP_ID, state, detail }, host)
  } catch {
    /* 跨域受限：忽略 */
  }
}