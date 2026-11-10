import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

/** PWA 壳：生产环境注册最小 SW；`/?sw=off` 一键注销并清空 shell 缓存。 */
const SW_CACHE_PREFIX = 'stock-shell-'
const swOff = new URLSearchParams(location.search).get('sw') === 'off'

if (swOff && 'serviceWorker' in navigator) {
  void navigator.serviceWorker
    .getRegistrations()
    .then((regs) => Promise.all(regs.map((r) => r.unregister())))
    .catch(() => {})
  if ('caches' in window) {
    void caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(SW_CACHE_PREFIX)).map((k) => caches.delete(k))))
      .catch(() => {})
  }
} else if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  // 已有控制器时，新 SW 接管后自动刷一次，保证主屏快捷方式立即用上新版本。
  if (navigator.serviceWorker.controller) {
    let refreshed = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshed) return
      refreshed = true
      location.reload()
    })
  }
  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => reg.update())
      .catch(() => {
        /* SW 失败不影响主功能 */
      })
  })
}

const el = document.getElementById('root')
if (el) {
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
