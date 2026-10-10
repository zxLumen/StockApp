// 推荐系统的可训练参数（"模型"）加载器。
// 来源：web/config/model.json（训练流水线产物；Dockerfile 已 COPY config/）。
// 代码不再写死策略参数 —— 一律从这里取；环境变量仅用于实验性覆盖（调参/回测）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = process.env.RECOMMEND_MODEL_CONFIG || path.join(HERE, '..', 'config', 'model.json')

export const MODEL_PATH = CONFIG_PATH
export const MODEL = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
export const MODEL_VERSION = MODEL.version || 'unknown'

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
const envNum = (k) => num(process.env[k])
const pick = (envKey, val) => envNum(envKey) ?? num(val)

/** 双链路 tilt 门控阈值。 */
export const tiltThreshold = () => pick('RECOMMEND_DUAL_THR', MODEL.dualChain?.thr)
/** tilt 线性映射上下界 { lo, hi }。 */
export const tiltRange = () => ({
  lo: pick('RECOMMEND_REGIME_LO', MODEL.tilt?.lo),
  hi: pick('RECOMMEND_REGIME_HI', MODEL.tilt?.hi),
})
/** 因子权重（`RECOMMEND_FACTOR_WEIGHTS` 可覆盖单项，便于调参）。 */
export const factorWeights = () => {
  const base = { ...(MODEL.factors?.weights || {}) }
  const env = process.env.RECOMMEND_FACTOR_WEIGHTS
  if (!env) return base
  try {
    return { ...base, ...JSON.parse(env) }
  } catch {
    return base
  }
}
/** 客观初筛参数。 */
export const objectiveConfig = () => ({ ...(MODEL.objective || {}) })
/** 选股 / 池子参数。 */
export const selectConfig = () => ({ ...(MODEL.select || {}) })
/** 公告事件因子回看窗口（**交易日**个数，见 lib/ann-factor.js）。 */
export const eventWindowDays = () => pick('RECOMMEND_EVENT_WINDOW', MODEL.factors?.eventWindowDays) ?? 5
