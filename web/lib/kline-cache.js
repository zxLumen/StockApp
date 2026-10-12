import fsp from 'node:fs/promises'
import path from 'node:path'

import { DATA_DIR } from './scope.js'
import { readJson, writeJson } from './store.js'
import { sinaKline } from './sina.js'

// 带磁盘缓存的日 K。回测 / 评估会反复取同一批票，逐次直连新浪会触发限流；
// 缓存目录 DATA_DIR/kline-cache（data/ 已被 .gitignore + .dockerignore 排除）。
//
// limit 取 600 而非 260：因子要近 20 日回看 + MA20/MA60，要回测一年前（如 2025-09）
// 就得让缓存的历史起点足够早。260 根在「最新日期往前 260 个交易日」处截断，
// 一旦回测更早的月份就会没有回看窗口（computeFactors 直接返回 null）。
const TTL_MS = 6 * 3600_000

export async function cachedKline(secid, { dataDir = DATA_DIR, limit = 600, ttlMs = TTL_MS, minTime = null } = {}) {
  const file = path.join(dataDir, 'kline-cache', `${secid}.json`)
  try {
    const st = await fsp.stat(file)
    // minTime 模式（盘前刷新）：只要缓存已**覆盖到**该日（末根 ≥ minTime）就足够，
    // 不受 TTL 约束 —— 上一交易日收盘那次拉的数据正是我们要的，盘前不必再穿透上游重拉。
    // （缓存末根 > minTime，例如含当日半截 K，也 OK：调用方会再截断到 basisDate。）
    const freshEnough = minTime == null ? Date.now() - st.mtimeMs < ttlMs : true
    if (freshEnough) {
      const j = await readJson(file, null)
      const last = j?.bars?.length ? j.bars[j.bars.length - 1]?.time : null
      if (j?.bars?.length && (minTime == null || (last && last >= minTime))) return j
    }
  } catch {
    /* 无缓存，继续拉 */
  }
  const k = await sinaKline(secid, { period: 'd', limit })
  if (k?.bars?.length) await writeJson(file, k).catch(() => {})
  return k
}
