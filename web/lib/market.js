import { getKline as emKline, getQuotes as emQuotes } from './eastmoney.js'
import { tencentKline, tencentQuotes } from './tencent.js'
import { sinaKline, sinaQuotes, sinaUsKline } from './sina.js'

// 东财 push2 / push2his 会按来源 IP 直接掐连接（本机、某些网络下整条线都没数据），
// 所以行情按「东财 → 腾讯 → 新浪」逐级降级：谁先给出完整数据就用谁，
// 并把实际生效的源报给前端（页面上会显示「降级」徽标），别让人误以为是实时价。
export const SOURCES = [
  { id: 'eastmoney', label: '东财' },
  { id: 'tencent', label: '腾讯' },
  { id: 'sina', label: '新浪' },
]

export function sourceLabel(id) {
  return SOURCES.find((s) => s.id === id)?.label || id
}

/**
 * 批量快照。返回 `{ items, source }`；三源都挂掉时抛最后一个可读错误。
 * 部分源只认得一部分代码，所以按「谁覆盖得最多」选，而不是第一个非空的。
 */
export async function getQuotes(secids) {
  const list = [...new Set((secids || []).filter(Boolean))]
  if (!list.length) return { items: [], source: 'eastmoney' }
  const errors = []
  const attempts = [
    { id: 'eastmoney', run: () => emQuotes(list) },
    { id: 'tencent', run: async () => [...(await tencentQuotes(list)).values()] },
    { id: 'sina', run: async () => [...(await sinaQuotes(list)).values()] },
  ]
  let best = null
  for (const a of attempts) {
    try {
      const items = await a.run()
      const got = items.length
      if (!got) {
        errors.push(`${a.id}：无数据`)
        continue
      }
      if (!best || got > best.items.length) best = { items, source: a.id }
      // 全都拿到了就不用再往下试
      if (got >= list.length) break
    } catch (err) {
      errors.push(`${a.id}：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (!best) throw new Error(`行情上游暂不可用（${errors.join('；')}）`)
  // 用低优先级的源补齐高优先级源缺的品种
  if (best.items.length < list.length) {
    const have = new Set(best.items.map((q) => q.secid))
    const missing = list.filter((s) => !have.has(s))
    for (const a of attempts) {
      if (a.id === best.source || !missing.length) continue
      try {
        const extra = await a.run(missing)
        for (const q of extra) {
          if (!have.has(q.secid)) {
            best.items.push(q)
            have.add(q.secid)
          }
        }
      } catch {
        /* 补齐失败就算了，缺的那几个前端显示 — */
      }
    }
  }
  return best
}

/** K 线。返回 `{ secid, market, name, bars, source }`。 */
export async function getKline(secid, opts = {}) {
  const attempts = [
    { id: 'eastmoney', run: () => emKline(secid, opts) },
    { id: 'tencent', run: () => tencentKline(secid, opts) },
    { id: 'sina', run: () => sinaKline(secid, opts) },
    { id: 'sina', run: () => sinaUsKline(secid, opts) },
  ]
  const errors = []
  for (const a of attempts) {
    try {
      const out = await a.run()
      if (out && Array.isArray(out.bars) && out.bars.length) {
        return { ...out, source: a.id }
      }
      errors.push(`${a.id}：无数据`)
    } catch (err) {
      errors.push(`${a.id}：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  throw new Error(`K 线暂不可用（${errors.filter((e) => !e.endsWith('无数据')).join('；') || '各源均无该周期数据'}）`)
}