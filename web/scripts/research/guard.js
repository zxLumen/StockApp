// Holdout 守卫：任何「训练/调参」都必须早于 cutoff；任何「评估」只允许 >= cutoff。
// 同时校验冻结快照的 SHA-256，防止真实数据被静默修改。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** 2026-10-01 起的真实前瞻数据只用于评估，禁止用于训练/调参。 */
export const HOLDOUT_CUTOFF = '2026-10-01'

export function assertTrainRange(from, to) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new Error(`训练区间必须是 YYYY-MM-DD（收到 ${from} ~ ${to}）`)
  }
  if (to >= HOLDOUT_CUTOFF) {
    throw new Error(
      `拒绝训练：区间 ${from} ~ ${to} 触及 holdout（cutoff=${HOLDOUT_CUTOFF}）。` +
        `最近一个月的真实前瞻数据只能评估，不能训练/调参。`,
    )
  }
}

export function assertEvalRange(from, to) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new Error(`评估区间必须是 YYYY-MM-DD（收到 ${from} ~ ${to}）`)
  }
  if (from < HOLDOUT_CUTOFF) {
    throw new Error(`拒绝评估：区间 ${from} ~ ${to} 早于 holdout cutoff=${HOLDOUT_CUTOFF}`)
  }
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * 校验冻结快照：
 *  - 每个文件必须存在、SHA-256 与 manifest 一致；
 *  - 每个日期必须 >= cutoff（防止把训练数据混进 holdout）；
 *  - 返回 manifest（方便调用方继续用）。
 */
export function verifyManifest(root) {
  const file = path.join(root, 'manifest.json')
  const m = readJson(file)
  if (m.cutoff !== HOLDOUT_CUTOFF) {
    throw new Error(`manifest.cutoff=${m.cutoff} 与代码常量 ${HOLDOUT_CUTOFF} 不一致`)
  }
  const bad = []
  for (const f of m.files) {
    // manifest 里 path 记录的是生成时的相对路径；快照目录可能被整体移动，
    // 这里优先按 chain/date 重新定位，保证可迁移（也兼容没有 path 字段的临时清单）。
    const relocated = path.join(root, 'forward', f.chain, `${f.date}.json`)
    const abs =
      typeof f.path === 'string'
        ? path.isAbsolute(f.path)
          ? f.path
          : path.join(root, path.basename(f.path))
        : relocated
    const p = fs.existsSync(relocated) ? relocated : abs
    if (!fs.existsSync(p)) {
      bad.push(`${f.chain}/${f.date}: missing`)
      continue
    }
    if (f.date < HOLDOUT_CUTOFF) bad.push(`${f.chain}/${f.date}: date < cutoff`)
    const h = sha256(fs.readFileSync(p))
    if (h !== f.sha256) bad.push(`${f.chain}/${f.date}: sha256 mismatch`)
  }
  for (const a of m.actions || []) {
    const name = path.basename(typeof a.path === 'string' ? a.path : '')
    const relocated = name ? path.join(root, 'actions', name) : ''
    const abs =
      typeof a.path === 'string'
        ? path.isAbsolute(a.path)
          ? a.path
          : path.join(root, path.basename(a.path))
        : relocated
    const p = relocated && fs.existsSync(relocated) ? relocated : abs
    if (!fs.existsSync(p)) bad.push(`actions/${path.basename(a.path)}: missing`)
    else if (sha256(fs.readFileSync(p)) !== a.sha256) bad.push(`actions/${path.basename(a.path)}: sha256 mismatch`)
  }
  if (bad.length) throw new Error(`holdout 快照校验失败：\n- ${bad.join('\n- ')}`)
  return m
}

// CLI：node scripts/research/guard.js [--check] [--snapshot <dir>] [--train from to]
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2)
  const opt = (n, d) => {
    const i = argv.indexOf(n)
    return i >= 0 ? argv[i + 1] : d
  }
  try {
    if (argv.includes('--train')) {
      assertTrainRange(argv[argv.indexOf('--train') + 1], argv[argv.indexOf('--train') + 2])
      console.log('train range OK（未触及 holdout）')
    }
    if (argv.includes('--check')) {
      const root = opt('--snapshot', path.resolve(process.cwd(), '../../../research/holdout'))
      const m = verifyManifest(root)
      console.log(`holdout OK：${m.files.length} 个推荐文件 + ${(m.actions || []).length} 个 actions 快照，cutoff=${m.cutoff}`)
    }
    if (!argv.includes('--train') && !argv.includes('--check')) {
      console.log('usage: guard.js --check [--snapshot dir] | --train <from> <to>')
    }
  } catch (e) {
    console.error(`[guard] ${e.message}`)
    process.exit(1)
  }
}
