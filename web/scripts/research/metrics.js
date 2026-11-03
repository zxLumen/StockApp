// 研究用指标库：纯函数、无副作用、**不被生产代码引用**。
// 口径见 docs/research/METHODOLOGY.md；holdout 规则见 docs/research/HOLDOUT.md。

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
export const median = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
export const quantile = (xs, q) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const pos = (s.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo)
}
export const std = (xs) => {
  if (xs.length < 2) return null
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length)
}
export const compound = (rs) => rs.reduce((a, r) => a * (1 + r), 1) - 1
export const equityFrom = (rs) => {
  const out = [1]
  for (const r of rs) out.push(out[out.length - 1] * (1 + r))
  return out
}
/** 最大回撤：输入为净值序列（从 1 开始），返回负数（如 -0.0815 = -8.15%）。 */
export const maxDrawdown = (equity) => {
  if (!equity.length) return null
  let peak = equity[0]
  let mdd = 0
  for (const v of equity) {
    if (v > peak) peak = v
    const dd = v / peak - 1
    if (dd < mdd) mdd = dd
  }
  return mdd
}
export const sharpe = (rs, periods = 252) => {
  const s = std(rs)
  if (s == null || s === 0) return null
  return (mean(rs) / s) * Math.sqrt(periods)
}
export const sortino = (rs, periods = 252) => {
  const downside = rs.filter((r) => r < 0)
  if (!downside.length) return null
  const d = Math.sqrt(downside.reduce((a, r) => a + r * r, 0) / downside.length)
  return d === 0 ? null : (mean(rs) / d) * Math.sqrt(periods)
}
/** OLS：y = alpha + beta*x；返回 beta / alpha（同期）/ R²。 */
export const betaAlpha = (ys, xs) => {
  const n = Math.min(ys.length, xs.length)
  if (n < 3) return { beta: null, alpha: null, r2: null, n }
  const mx = mean(xs.slice(0, n))
  const my = mean(ys.slice(0, n))
  let cov = 0
  let vx = 0
  let vy = 0
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx
    const dy = ys[i] - my
    cov += dx * dy
    vx += dx * dx
    vy += dy * dy
  }
  cov /= n
  vx /= n
  vy /= n
  const beta = vx ? cov / vx : null
  const alpha = beta == null ? null : my - beta * mx
  const r2 = vx && vy ? (cov * cov) / (vx * vy) : null
  return { beta, alpha, r2, n }
}
/** 确定性 PRNG（bootstrap 可复现）。 */
export const mulberry32 = (seed = 42) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
/** 均值的 bootstrap 置信区间（默认 95%，固定 seed）。 */
export const bootstrapCI = (xs, { n = 10000, alpha = 0.05, seed = 42 } = {}) => {
  if (!xs.length) return null
  const rnd = mulberry32(seed)
  const means = new Array(n)
  for (let i = 0; i < n; i += 1) {
    let s = 0
    for (let j = 0; j < xs.length; j += 1) s += xs[Math.floor(rnd() * xs.length)]
    means[i] = s / xs.length
  }
  means.sort((a, b) => a - b)
  return {
    lo: means[Math.floor((alpha / 2) * n)],
    hi: means[Math.floor((1 - alpha / 2) * n) - 1],
    n,
    seed,
  }
}
/** 交易成本敏感性：成本按「单边 %」给出，往返 = 2*bps。 */
export const costAdjust = (rs, bpsPerSide) => rs.map((r) => r - (2 * bpsPerSide) / 10000)
