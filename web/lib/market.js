import {
  getKline as emKline,
  getQuotes as emQuotes,
  getBoards as emBoards,
  getBoardMembers as emBoardMembers,
  marketOf,
} from './eastmoney.js'
import { tencentKline, tencentQuotes } from './tencent.js'
import { sinaKline, sinaQuotes, sinaUsKline } from './sina.js'
import { sinaBoards, sinaBoardMembers } from './board-sina.js'
import {
  thsBoardIndex,
  thsBoardKline,
  thsBoardMembers,
  searchThsBoards,
  matchBoards,
  thsBoardByCode,
} from './board-ths.js'
import { CSI_INDUSTRIES, csiBoardIndex, csiBoardKline } from './board-csi.js'

// 东财 push2 / push2his 会按来源 IP 直接掐连接（本机、某些网络下整条线都没数据），
// 所以行情按「东财 → 腾讯 → 新浪」逐级降级：谁先给出完整数据就用谁，
// 并把实际生效的源报给前端（页面上会显示「降级」徽标），别让人误以为是实时价。
export const SOURCES = [
  { id: 'eastmoney', label: '东财' },
  { id: 'tencent', label: '腾讯' },
  { id: 'sina', label: '新浪' },
  { id: 'ths', label: '同花顺' },
  { id: 'csi', label: '中证' },
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

/**
 * 板块 K 线单独走 —— 板块在三家通用源里只有东财认（`90.BKxxxx`），而东财整条线
 * 经常被掐，所以真正的可用源是：
 *   同花顺 90.881xxx(行业) / 90.885xxx·90.886xxx(概念) —— 唯一同时覆盖行业 + 概念
 *   中证   91.000928…000937                        —— 官方口径的 10 个一级行业
 *   东财   90.BKxxxx                              —— 等它解封时自动优先
 */
async function getBoardKline(secid, opts) {
  const code = String(secid || '').split('.')[1] || ''
  const attempts = []
  if (/^BK/i.test(code)) attempts.push({ id: 'eastmoney', run: () => emKline(secid, opts) })
  if (/^88[156]\d{3}$/.test(code)) attempts.push({ id: 'ths', run: () => thsBoardKline(code, opts) })
  if (/^0009(2[89]|3[0-7])$/.test(code)) attempts.push({ id: 'csi', run: () => csiBoardKline(code, opts) })
  // 东财板块码也可能是纯数字（历史遗留），兜底都试一遍
  attempts.push({ id: 'eastmoney', run: () => emKline(secid, opts) })

  const errors = []
  for (const a of attempts) {
    try {
      const out = await a.run()
      if (out && Array.isArray(out.bars) && out.bars.length) return { ...out, source: a.id }
      errors.push(`${a.id}：无数据`)
    } catch (err) {
      errors.push(`${a.id}：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  throw new Error(`板块 K 线暂不可用（${errors.filter((e) => !e.endsWith('无数据')).join('；') || '各源均无该周期数据'}）`)
}

/** K 线。返回 `{ secid, market, name, bars, source }`。 */
export async function getKline(secid, opts = {}) {
  if (marketOf(secid) === 'board') return getBoardKline(secid, opts)
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

/**
 * 板块榜 / 板块索引。
 *   kind=industry 同花顺 90 个行业（含涨跌家数、领涨股）→ 东财 → 新浪
 *   kind=concept  同花顺 293 个概念                  → 东财 → 新浪
 *   kind=csi      中证 10 个一级行业（静态，无需网络）  → 东财
 * 返回 `{ items, source }`。
 */
export async function getBoards(kind, { limit = 24 } = {}) {
  const errors = []
  if (kind === 'csi') {
    const items = await csiBoardIndex({ limit })
    if (items.length) return { items, source: 'csi' }
    errors.push('csi：无数据')
  } else {
    const k = kind === 'concept' ? 'concept' : 'industry'
    try {
      const items = await emBoards(k, { limit })
      if (items.length) return { items, source: 'eastmoney' }
      errors.push('eastmoney：无数据')
    } catch (err) {
      errors.push(`eastmoney：${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      const items = await thsBoardIndex(k)
      if (items.length) return { items: items.slice(0, limit), source: 'ths' }
      errors.push('ths：无数据')
    } catch (err) {
      errors.push(`ths：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (kind === 'csi') throw new Error(`板块暂不可用（${errors.join('；')}）`)
  const items = await sinaBoards(kind, { limit })
  if (!items.length) throw new Error(`板块暂不可用（${errors.join('；')}）`)
  return { items, source: 'sina' }
}

/**
 * 板块搜索：同花顺的全量索引（行业 90 + 概念 293，抓一次落盘、可离线）+ 中证 10 个行业
 * 都是**本地匹配**，所以搜索不受任何被封 / 被限流的上游影响。
 * `kind` 传 'industry' / 'concept' / 'csi' 可只看某一类。
 */
export async function searchBoards(q, { kind = '', limit = 20 } = {}) {
  const kinds = kind ? [kind] : ['industry', 'concept', 'csi']
  const out = []
  const errors = []
  for (const k of kinds) {
    try {
      if (k === 'csi') {
        const list = await csiBoardIndex({ limit: 40 })
        out.push(...matchBoards(list, q, { limit }))
      } else {
        out.push(...(await searchThsBoards(q, { kind: k, limit })))
      }
    } catch (err) {
      errors.push(`${k}：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (!out.length && errors.length === kinds.length) {
    throw new Error(`板块搜索暂不可用（${errors.join('；')}）`)
  }
  return out.slice(0, limit)
}

/**
 * 板块成分股。
 * 同花顺最全（行业首页 ~20 条、概念首页 ~30 条，且是同一套分类），所以优先；
 * 它挂了再退回新浪节点码 / 东财按名称搜。
 */
export async function getBoardMembers(board = {}, { limit = 30 } = {}) {
  const { code, name, kind, cid } = board
  if (code && kind) {
    try {
      const items = await thsBoardMembers({ kind, code, cid }, { limit })
      if (items.length) return { items, source: 'ths', board: await boardMeta(code) }
    } catch {
      /* 落到新浪 / 东财 */
    }
  }
  if (code) {
    try {
      const items = await sinaBoardMembers(code, { limit })
      if (items.length) return { items, source: 'sina', board: await boardMeta(code) }
    } catch {
      /* 落到名称搜索 */
    }
  }
  const items = await emBoardMembers(name, { limit })
  return { items, source: 'eastmoney', board: null }
}

/**
 * 板块自身的涨跌家数 / 领涨股 / 净流入。索引已经落盘且在内存里，这里零网络开销 ——
 * 详情页要显示这些，就不必要求前端再拉一遍 90~293 条的列表接口。
 */
async function boardMeta(code) {
  try {
    const hit = await thsBoardByCode(code)
    if (hit) return hit
    // 东财板块是 BK 开头，ths 索引里没有；中证是 0009xx，另找一处
    return CSI_INDUSTRIES.find((x) => x.code === code) ?? null
  } catch {
    return null
  }
}