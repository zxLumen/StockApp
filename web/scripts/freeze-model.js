// 冻结训练产物：把选定参数写入 web/config/model.json（"模型"的唯一来源），
// 并把本次冻结留档到 docs/runs/<scheme>/<stage>-<ts>/（防"记忆退化"，见 REQUIREMENTS §6）。
//
//   node scripts/freeze-model.js --scheme B --stage train \
//     --weights '{"midRev":0.35,"upShadow":0.4}' --thr 0.6 --version 2024-train
//
// 只覆盖显式给出的字段，其余保持不变。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.join(HERE, '..')
const ROOT = path.join(WEB, '..')
const CONFIG = path.join(WEB, 'config', 'model.json')

const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf(n)
  return i >= 0 ? argv[i + 1] : d
}
const has = (f) => argv.includes(f)
const scheme = opt('--scheme', 'B')
const stage = opt('--stage', 'train')
const version = opt('--version', `freeze-${new Date().toISOString().slice(0, 10)}`)

const model = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
const applied = {}

if (has('--weights')) {
  const w = JSON.parse(opt('--weights'))
  model.factors = model.factors || {}
  model.factors.weights = { ...(model.factors.weights || {}), ...w }
  applied.weights = w
}
if (has('--thr')) {
  model.dualChain = model.dualChain || {}
  model.dualChain.thr = Number(opt('--thr'))
  applied.thr = model.dualChain.thr
}
if (has('--tilt-lo')) {
  model.tilt = model.tilt || {}
  model.tilt.lo = Number(opt('--tilt-lo'))
  applied.tiltLo = model.tilt.lo
}
if (has('--tilt-hi')) {
  model.tilt = model.tilt || {}
  model.tilt.hi = Number(opt('--tilt-hi'))
  applied.tiltHi = model.tilt.hi
}
if (has('--objective')) {
  model.objective = { ...(model.objective || {}), ...JSON.parse(opt('--objective')) }
  applied.objective = model.objective
}
if (has('--select')) {
  model.select = { ...(model.select || {}), ...JSON.parse(opt('--select')) }
  applied.select = model.select
}

model.version = version
fs.writeFileSync(CONFIG, `${JSON.stringify(model, null, 2)}\n`)

const ts = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
const runDir = path.join(ROOT, 'docs', 'runs', scheme, `${stage}-${ts}`)
fs.mkdirSync(runDir, { recursive: true })
fs.writeFileSync(path.join(runDir, 'frozen-model.json'), `${JSON.stringify(model, null, 2)}\n`)
fs.writeFileSync(path.join(runDir, 'command.txt'), `${process.argv.slice(1).join(' ')}\n`)
fs.writeFileSync(
  path.join(runDir, 'summary.md'),
  `# 冻结 ${scheme} / ${stage}\n\n- version: ${version}\n- 时间: ${new Date().toISOString()}\n- 变更:\n\n\`\`\`json\n${JSON.stringify(applied, null, 2)}\n\`\`\`\n`,
)

console.log(`[freeze] 已写入 ${CONFIG}（version=${version}）`)
console.log(`[freeze] 留档 ${runDir}`)
