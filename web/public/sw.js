/*
 * 股票速览 · 最小 Service Worker（只缓存 app shell）
 *
 * 设计原则：
 * 1. 只缓存 `/` + manifest + 图标，不缓存 hashed JS/CSS —— 发版后页面一定拿新资源，
 *    不会出现「手机主屏还跑旧 JS」。
 * 2. 导航请求 network-first：在线永远读最新 index.html；离线才回退到缓存的 app shell。
 * 3. 版本号变化时清掉旧 shell 缓存；skipWaiting + clients.claim 让更新立即生效。
 *
 * 一键注销 / 强制更新：访问 `/?sw=off`（main.tsx 会注销所有 SW 并清空 stock-shell-* 缓存）。
 * 发版只需把 VERSION 加 1。
 */
const VERSION = 'v1'
const CACHE = `stock-shell-${VERSION}`
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith('stock-shell-') && k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  // 同源、非 API 才处理；API 请求一律直连，避免登录态/实时行情被缓存。
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // 只把成功的 HTML 写回 shell；离线回退永远读最新一次成功导航。
          if (res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((cache) => cache.put('/', copy))
          }
          return res
        })
        .catch(() => caches.match('/')),
    )
    return
  }

  // shell 内的静态小文件：stale-while-revalidate，图标/清单不阻塞首屏。
  if (url.pathname === '/manifest.webmanifest' || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(req).then((hit) => {
        const network = fetch(req)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone()
              caches.open(CACHE).then((cache) => cache.put(req, copy))
            }
            return res
          })
          .catch(() => hit)
        return hit || network
      }),
    )
  }
})
