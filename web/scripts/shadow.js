// 独立验证策略（shadow）：只读线上推荐归档，写 /data/shadow/**；绝不写 recommend* / actions。
// 策略：保留线上选股（A/B/dual 同一份 top），把持有期固定为 20 个交易日；不跑 AI 提前退出。
// 用法：node scripts/shadow.js [--date YYYY-MM-DD] [--force] [--dry-run]
import fs from 'node:fs'
import path from 'node:path'

const DATA = process.env.STOCK_DATA_DIR || '/data'
const HOLD = Number(process.env.SHADOW_HOLD || 20)
const NAME = process.env.SHADOW_NAME || 'shadow-2026-11-t20'
const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf(n)
  return i >= 0 ? argv[i + 1] : d
}
const FORCE = argv.includes('--force')
const DRY = argv.includes('--dry-run')
const DIRS = { A: 'recommend-ai-fwd', B: 'recommend-factors-fwd', dual: 'recommend' }
const log = (m) => console.log(`[shadow] ${m}`)

const listDates = (dir) => {
  const abs = path.join(DATA, dir)
  if (!fs.existsSync(abs)) return []
  return fs
    .readdirSync(abs)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, 10))
    .sort()
}
const readPayload = (dir, date) => {
  const p = path.join(DATA, dir, `${date}.json`)
  if (!fs.existsSync(p)) return null
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

const date = opt('--date', '') || listDates(DIRS.dual).at(-1)
if (!date) {
  log('没有可用的推荐日期，退出')
  process.exit(0)
}
log(`目标生效日 ${date}；持有 ${HOLD} 个交易日；候选 ${NAME}`)

// 元信息（每次运行覆盖；不含任何交易数据）
if (!DRY) {
  const metaDir = path.join(DATA, 'shadow')
  fs.mkdirSync(metaDir, { recursive: true })
  fs.writeFileSync(
    path.join(metaDir, 'README.json'),
    `${JSON.stringify(
      {
        candidate: NAME,
        holdDays: null,
        registry: 'strategies-2026-11',
        rule: 'source snapshot for strategies-2026-11; holds applied at evaluation',
        basis: 'multi-strategy platform; see docs/research/PLATFORM.md and research/configs/strategies-2026-11.json',
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  )
}

let wrote = 0
for (const [chain, dir] of Object.entries(DIRS)) {
  const p = readPayload(dir, date)
  if (!p || !Array.isArray(p.top) || !p.top.length) {
    log(`${chain}: ${dir}/${date}.json 缺失或为空，跳过`)
    continue
  }
  const out = {
    version: 1,
    candidate: NAME,
    chain,
    date: p.date || date,
    basisDate: p.basisDate || null,
    holdDays: HOLD,
    source: `${dir}/${date}.json`,
    sourceChain: p.regime?.chain || null,
    regime: p.regime || null,
    holdDays: null,
    registry: 'strategies-2026-11',
    rule: 'source snapshot for strategies-2026-11; holds applied at evaluation',
    generatedAt: new Date().toISOString(),
    top: p.top.map((t) => ({
      secid: t.secid,
      code: t.code,
      name: t.name,
      price: t.price ?? null,
      aiHoldDays: t.ai?.holdDays ?? t.holdDays ?? null,
      holdDays: HOLD,
      sector: t.sector ?? t.industry ?? null,
    })),
  }
  const outDir = path.join(DATA, 'shadow', chain)
  const outFile = path.join(outDir, `${out.date}.json`)
  if (fs.existsSync(outFile) && !FORCE) {
    log(`${chain}: 已存在 ${outFile}（跳过；--force 可覆盖）`)
    continue
  }
  if (DRY) {
    log(`${chain}: [dry-run] 将写 ${outFile}，${out.top.length} 只`)
    continue
  }
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`)
  wrote += 1
  log(`${chain}: 写入 ${outFile}（${out.top.length} 只，来源 ${dir}）`)
}
log(`完成，写入 ${wrote} 个文件`)
