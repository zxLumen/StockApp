// 数据准备（新协议）：把日K缓存重抓到更长历史，覆盖 2024 全年，供「2024 训练」使用。
//   node scripts/refetch-klines.js --dry-run          # 只统计还差多少
//   node scripts/refetch-klines.js                    # 只补「历史不足」的票
//   node scripts/refetch-klines.js --force            # 全部重抓
//   node scripts/refetch-klines.js --limit 1023
//
// 背景：kline-cache 原 limit=600（最早 2024-04-15），2024 训练需要更早回看（MA60 等），
// sinaKline 上限 1023。本脚本对「成分宇宙并集」重抓，逐只落盘、可中断续跑。
import fs from 'node:fs'
import path from 'node:path'

import { DATA_DIR } from '../lib/scope.js'
import { readJson, writeJson } from '../lib/store.js'
import { sinaKline } from '../lib/sina.js'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const opt = (n, d) => {
  const i = argv.indexOf(n)
  const v = i >= 0 ? Number(argv[i + 1]) : NaN
  return Number.isFinite(v) ? v : d
}
const LIMIT = opt('--limit', 1023) || 1023
const FORCE = has('--force')
const DRY = has('--dry-run')
const NEED_EARLY = '2024-03-01'
const SLEEP = opt('--sleep', 90) || 90
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dir = path.join(DATA_DIR, 'kline-cache')
const secids = new Set()
for (const f of ['universe-stable.json', 'universe-amount-10.json']) {
  for (const x of await readJson(path.join(dir, f), [])) if (x?.secid) secids.add(x.secid)
}

const earliestOf = async (secid) => {
  const j = await readJson(path.join(dir, `${secid}.json`), null)
  const bars = j?.bars || []
  if (!bars.length) return null
  return String(bars[0].time).slice(0, 10)
}

let todo = []
for (const secid of secids) {
  const e = await earliestOf(secid)
  if (FORCE || e == null || e > NEED_EARLY) todo.push(secid)
}

console.log(`[refetch] 宇宙并集 ${secids.size} 只，需要重抓 ${todo.length} 只（目标最早 ≤ ${NEED_EARLY}，limit=${LIMIT}）`)
if (DRY) process.exit(0)

let ok = 0
let fail = 0
for (const [i, secid] of todo.entries()) {
  try {
    const k = await sinaKline(secid, { period: 'd', limit: LIMIT })
    if (k?.bars?.length) {
      await writeJson(path.join(dir, `${secid}.json`), k)
      ok += 1
    } else {
      fail += 1
    }
  } catch (e) {
    fail += 1
    if (fail <= 20) console.warn(`  ${secid} 失败: ${e instanceof Error ? e.message : e}`)
  }
  if ((i + 1) % 100 === 0) console.log(`  进度 ${i + 1}/${todo.length}（ok ${ok} / fail ${fail}）`)
  await sleep(SLEEP)
}
console.log(`[refetch] 完成：ok ${ok} / fail ${fail}`)
