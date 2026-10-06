// 客观选股因子库。依据 A 股实证（短期反转强、低波/低换手更稳、质量/价值因子能收窄尾部），
// 用**价量因子 + 点时财务因子**做多因子打分，AI 只负责后来解读。
//
// 价量因子只用「截至当日」的日 K（bars 已按回测日截断）；财务因子只用 `NOTICE_DATE <= 评估日`
// 的报告期（见 lib/finance.js）。两类都天然无未来数据。

import { factorWeights, tiltRange } from './model-config.js'

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * 从日 K（升序，最后一根 = 评估日）算该日的一组**价量**因子。
 * 返回 null 表示数据不足。
 *
 * 因子（都按「越高越好」归一，调用方不用再翻方向）：
 *   lowVol   低波动：20日日收益标准差，取负 → 波动小得分高
 *   rev5     短期反转：近5日涨幅取负 → 近期大跌的得分高（A股反转）
 *   rev20    中期反转：近20日涨幅取负
 *   closeMa  位置：收盘相对 MA20 偏离，轻微贴近或略低最好（越接近 0 越高）
 *   liq      流动性适中：成交额太小不好（缺乏承接），太大（过热）也不好
 *   turnStd  换手率波动：越大越差（中金 IC_IR 最高因子，负向）
 *
 * `fin`（可选，lib/finance.js 的 financeFactors 返回值）里的 `roeAnnual` / `bps` 会并入结果，
 * 供 compositeScores 的 `q` / `ep` 权重使用。不传则这两个字段为 null（权重项贡献 0），
 * 旧调用方行为不变。
 */
export function computeFactors(bars, idxClose = null, fin = null) {
  if (!Array.isArray(bars) || bars.length < 21) return null
  const n = bars.length
  const last = bars[n - 1]
  const closes = bars.map((b) => b.close)
  if (closes.some((c) => c == null)) return null

  // 20日日收益波动率
  const rets = []
  for (let i = n - 20; i < n; i += 1) {
    const prev = closes[i - 1]
    if (prev) rets.push(closes[i] / prev - 1)
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length
  const vol = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length)

  // 近5 / 近20 日涨幅
  const c5 = closes[n - 6]
  const c20 = closes[n - 21]
  const chg5 = c5 ? closes[n - 1] / c5 - 1 : null
  const chg20 = c20 ? closes[n - 1] / c20 - 1 : null

  // 距 MA20 偏离
  const ma20 = closes.slice(n - 20).reduce((a, b) => a + b, 0) / 20
  const dev = ma20 ? closes[n - 1] / ma20 - 1 : null

  // 成交额（用 volume×close 近似；volume 单位一致即可，只比大小）
  const amounts = bars.slice(n - 20).map((b) => (b.volume || 0) * b.close)
  const avgAmt = amounts.reduce((a, b) => a + b, 0) / amounts.length

  // 换手率波动：用成交量/近20日均量 的标准差近似「换手率波动」
  const vols = bars.slice(n - 20).map((b) => b.volume || 0)
  const vmean = vols.reduce((a, b) => a + b, 0) / vols.length
  let turnStd = null
  if (vmean > 0) {
    const ratios = vols.map((v) => v / vmean)
    const rm = ratios.reduce((a, b) => a + b, 0) / ratios.length
    turnStd = Math.sqrt(ratios.reduce((a, b) => a + (b - rm) ** 2, 0) / ratios.length)
  }

  // 相对强度 / 动量：收盘 / MA20 - 1（相对自身均线强度）→ relStr。正值=站上均线、走强。
  // 与 dev 数值相同但**方向相反**：dev 越小（越低于 MA20）反转因子得分越高，relStr 越大（越强）动量得分越高。
  const relStr = dev == null ? null : -dev
  // 中长动量：近60日涨幅（若数据足够）；不足则 null。
  const c60 = n >= 61 ? closes[n - 61] : null
  const mom60 = c60 ? closes[n - 1] / c60 - 1 : null

  // 量能放大：近5日均量 / 近20日均量。>1 = 放量（资金关注）。
  const v5 = bars.slice(n - 5).map((b) => b.volume || 0)
  const volSurge = vmean > 0 ? v5.reduce((a, b) => a + b, 0) / 5 / vmean : null
  // 接近一年新高：收盘 / 近 250 日最高收盘（越接近 1 越强）。动量/突破特征。
  const hi = Math.max(...closes.slice(Math.max(0, n - 250)))
  const nearHigh = hi > 0 ? closes[n - 1] / hi : null

  // 近5日最大单日涨幅（A股「彩票 / MAX」效应：博彩性强的后续易跑输）
  let maxRet5 = null
  let mx = -Infinity
  for (let i = n - 5; i < n; i += 1) {
    const prev = closes[i - 1]
    if (prev) mx = Math.max(mx, closes[i] / prev - 1)
  }
  if (mx !== -Infinity) maxRet5 = mx

  // 近20日平均振幅 (high-low)/close —— 中金量价手册复现里 IC_IR 最高的单因子（低振幅占优）
  const win20 = bars.slice(n - 20)
  const amps = []
  for (const b of win20) {
    if (b.high != null && b.low != null && b.close) amps.push((b.high - b.low) / b.close)
  }
  const ampMean = amps.length ? amps.reduce((a, b) => a + b, 0) / amps.length : null

  // 近20日上影线波动：std((high - max(open,close)) / close)，上影线越长越波动，后续偏弱
  const shadows = []
  for (const b of win20) {
    if (b.high != null && b.close) {
      const top = b.open != null ? Math.max(b.open, b.close) : b.close
      shadows.push((b.high - top) / b.close)
    }
  }
  let upShadowStd = null
  if (shadows.length >= 2) {
    const sm = shadows.reduce((a, b) => a + b, 0) / shadows.length
    upShadowStd = Math.sqrt(shadows.reduce((a, b) => a + (b - sm) ** 2, 0) / shadows.length)
  }

  // 特质波动率 IVOL：剔除市场（沪深300）后的残差收益波动，越低越好。
  // 需要注入指数收盘价 Map<time,close>；未提供则为 null（不参与）。
  let ivol = null
  // 相对指数动量（近20日个股涨幅 − 指数涨幅）：正值=跑赢大盘。普涨市里靠它抓领涨股。
  let relMom20 = null
  // 市场 beta（近60日个股日收益对指数日收益回归斜率）：普涨市高 beta 弹性大。
  let beta = null
  if (idxClose && typeof idxClose.get === 'function') {
    const res = []
    for (let i = n - 20; i < n; i += 1) {
      const p = closes[i - 1]
      const t0 = bars[i - 1]?.time
      const t1 = bars[i]?.time
      const ip = idxClose.get(t0)
      const ic = idxClose.get(t1)
      if (p && ip && ic) res.push(closes[i] / p - ic / ip)
    }
    if (res.length >= 5) {
      const rm = res.reduce((a, b) => a + b, 0) / res.length
      ivol = Math.sqrt(res.reduce((a, b) => a + (b - rm) ** 2, 0) / res.length)
    }
    // relMom20
    {
      const t0 = bars[n - 21]?.time
      const t1 = bars[n - 1]?.time
      const ip = t0 != null ? idxClose.get(t0) : null
      const ic = t1 != null ? idxClose.get(t1) : null
      if (chg20 != null && ip && ic) relMom20 = chg20 - (ic / ip - 1)
    }
    // beta（最多回看 60 日）
    {
      const N = Math.min(60, n - 1)
      const xs = []
      const ys = []
      for (let i = n - N; i < n; i += 1) {
        const p = closes[i - 1]
        const ip = idxClose.get(bars[i - 1]?.time)
        const ic = idxClose.get(bars[i]?.time)
        if (p && ip && ic) {
          xs.push(closes[i] / p - 1)
          ys.push(ic / ip - 1)
        }
      }
      if (xs.length >= 20) {
        const mx = xs.reduce((a, b) => a + b, 0) / xs.length
        const my = ys.reduce((a, b) => a + b, 0) / ys.length
        let cov = 0
        let v = 0
        for (let k = 0; k < xs.length; k += 1) {
          cov += (xs[k] - mx) * (ys[k] - my)
          v += (ys[k] - my) ** 2
        }
        beta = v ? cov / v : null
      }
    }
  }

  return {
    vol,
    chg5,
    chg20,
    dev,
    avgAmt,
    turnStd,
    maxRet5,
    ampMean,
    upShadowStd,
    ivol,
    relStr,
    mom60,
    relMom20,
    beta,
    volSurge,
    nearHigh,
    close: last.close,
    // 点时财务因子（lib/finance.js）；未注入 fin 时为 null → 权重项贡献 0。
    roeAnnual: fin && Number.isFinite(Number(fin.roeAnnual)) ? Number(fin.roeAnnual) : null,
    bps: fin && Number(fin.bps) > 0 ? Number(fin.bps) : null,
    // 成长（点时，披露日 ≤ 评估日）：营收/净利同比、毛利率。
    revYoy: fin && Number.isFinite(Number(fin.revYoy)) ? Number(fin.revYoy) : null,
    profitYoy: fin && Number.isFinite(Number(fin.profitYoy)) ? Number(fin.profitYoy) : null,
    grossMargin: fin && Number.isFinite(Number(fin.grossMargin)) ? Number(fin.grossMargin) : null,
  }
}

/** 截面 z-score（对一组数标准化）；常量等防御性处理。 */
export function zscore(arr) {
  const vals = arr.filter((v) => v != null)
  if (vals.length < 2) return arr.map(() => 0)
  const m = vals.reduce((a, b) => a + b, 0) / vals.length
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length) || 1
  return arr.map((v) => (v == null ? 0 : (v - m) / sd))
}

/**
 * 多因子权重（全部按「越高越好」方向）。
 * **来源：可训练配置** `web/config/model.json`（→ `lib/model-config.js`），由训练流水线在
 * 「2024 训练集」上拟合、2025 验证；**代码不写死**。旧的 2026 调参结论已归档
 * （`docs/archive/2026-10/`）。
 * 已知局限：`stablePool()` 用**当前**成分股回溯历史，含幸存者偏差，历史成绩偏乐观。
 */
// 因子权重来自可训练配置（web/config/model.json → lib/model-config.js），由训练流水线在
// 训练集上拟合；**代码不再写死**。`RECOMMEND_FACTOR_WEIGHTS` 可临时覆盖（调参/回测）。
// 字段含义（越高越好方向）：reversal 短期反转、midRev 中期反转、upShadow 上影线波动小、
// q 年化 ROE、ep 1/BPS、event 公告事件净分、lowVol 低波、proximity 贴近 MA20、liquidity 流动性。
export const DEFAULT_WEIGHTS = factorWeights()

export const FACTOR_WEIGHTS = DEFAULT_WEIGHTS

/**
 * 市场状态 → 动量倾斜系数 tilt ∈ [0,1]。
 * **只用 ≤ 评估日的指数序列**（无未来数据）：指数「近 20 日涨幅 + 收盘相对 MA20」。
 * 走强（普涨/上行）→ tilt 大，把反转权重挪给动量/相对强度，保住上涨弹性；
 * 走弱/震荡 → tilt→0，回到反转策略。
 * 阈值与斜率是**先验设定**（不按月份拟合），后续只用 2026 训练/验证窗检验。
 */
export function regimeTilt(idxBars) {
  if (!Array.isArray(idxBars) || idxBars.length < 21) return 0
  const n = idxBars.length
  const closes = idxBars.map((b) => b.close)
  if (closes.some((c) => c == null)) return 0
  const c20 = closes[n - 21]
  const mom20 = c20 ? closes[n - 1] / c20 - 1 : 0 // 近20日指数涨幅
  const ma20 = closes.slice(n - 20).reduce((a, b) => a + b, 0) / 20
  const above = ma20 ? closes[n - 1] / ma20 - 1 : 0 // 高于 MA20 的幅度
  const raw = mom20 + above // 合成强度
  // 线性映射到 [0,1]：强度 ≤ lo → 0；≥ hi → 1。阈值可经 env 覆盖做稳健性检验。
  const { lo, hi } = tiltRange()
  const t = (raw - lo) / (hi - lo)
  return Math.max(0, Math.min(1, t))
}

/**
 * 给定「原始因子值」的横截面数组，算每只的综合分（截面 z-score 加权）。
 * @param {Array<object>} feats 每只的 computeFactors 结果
 * @param {object} weights
 * @returns {number[]} 与 feats 等长的综合分
 */
export function compositeScores(feats, weights = {}) {
  // 允许只传部分权重（调参），缺失项回落默认。
  const w = { ...FACTOR_WEIGHTS, ...weights }
  const negVol = zscore(feats.map((f) => (f.vol == null ? null : -f.vol)))
  const rev5 = zscore(feats.map((f) => (f.chg5 == null ? null : -f.chg5)))
  const rev20 = zscore(feats.map((f) => (f.chg20 == null ? null : -f.chg20)))
  // 贴近 MA20 最好：偏离绝对值取负
  const prox = zscore(feats.map((f) => (f.dev == null ? null : -Math.abs(f.dev))))
  // 流动性适中：对 log(成交额) 取负绝对值（离中位越近越高）——简化成偏低成交额轻微加分
  const amt = feats.map((f) => (f.avgAmt ? Math.log(f.avgAmt) : null))
  const amtZ = zscore(amt)
  const amtMid = amtZ.map((v) => -Math.abs(v))
  const liq = zscore(amtMid)
  const tStd = zscore(feats.map((f) => (f.turnStd == null ? null : f.turnStd)))
  // 波动率调整后的反转：-近5日涨幅 / 波动（波动小且跌得多的更优）
  const revScaled = zscore(feats.map((f) => (f.chg5 == null || !f.vol ? null : -f.chg5 / f.vol)))
  const lottery = zscore(feats.map((f) => (f.maxRet5 == null ? null : f.maxRet5)))
  // 平均振幅 / 上影线波动：低者占优 → 取负后作为正向因子
  const ampMean = zscore(feats.map((f) => (f.ampMean == null ? null : -f.ampMean)))
  const upShadow = zscore(feats.map((f) => (f.upShadowStd == null ? null : -f.upShadowStd)))
  const ivol = zscore(feats.map((f) => (f.ivol == null ? null : -f.ivol)))
  // 点时财务因子：质量 = 年化 ROE；价值 = 1/BPS（越便宜越高）。
  // zscore 遇 null 给 0，所以没注入财务数据的票不会被惩罚，只是这一项不贡献。
  const roeQ = zscore(feats.map((f) => (f.roeAnnual == null ? null : f.roeAnnual)))
  // 成长：净利同比、营收同比（点时财务）。高成长在上涨市更有效。
  const growth = zscore(feats.map((f) => (f.profitYoy == null ? null : f.profitYoy)))
  const revGrowth = zscore(feats.map((f) => (f.revYoy == null ? null : f.revYoy)))
  // bps ≤ 0（净资产为负 / 缺失）时不给价值分，避免 -1/0 = -Infinity 污染 zscore
  const ep = zscore(feats.map((f) => (f.bps == null || f.bps <= 0 ? null : -1 / f.bps)))
  // 公告事件净分（lib/ann-factor.js）。null（窗口内无有效事件）→ zscore 记 0，不惩罚。
  const evt = zscore(feats.map((f) => (f.event == null ? null : f.event)))
  // 动量/相对强度（正向）：站上均线、近 60 日走强 → 分数高。普涨市里靠它保住弹性。
  const rel = zscore(feats.map((f) => (f.relStr == null ? null : f.relStr)))
  const mom = zscore(feats.map((f) => (f.mom60 == null ? null : f.mom60)))
  // 近20日动量（正向，与 rev20 同源反号）：上涨月里趋势延续。仅并入 regime 动量篮子。
  const mom20 = zscore(feats.map((f) => (f.chg20 == null ? null : f.chg20)))
  // 市场 beta：普涨市高 beta 弹性大。**仅在走强时启用**（乘 tilt），跌市不暴露 beta。
  const betaZ = zscore(feats.map((f) => (f.beta == null ? null : f.beta)))
  // 接近一年新高（突破/动量）：同样仅走强时启用。
  const nearHighZ = zscore(feats.map((f) => (f.nearHigh == null ? null : f.nearHigh)))
  // regime 倾斜：weights.tilt>0（大盘走强）时，把反转权重的一部分挪给动量项。
  // 基准反转暴露 = reversal+midRev（默认 0.4）；tilt 为挪移比例。
  const tilt = Number.isFinite(weights.tilt) ? weights.tilt : 0
  const revBase = w.reversal + w.midRev // 基准反转总暴露（默认 0.4）
  const shift = revBase * tilt // 挪给动量的量
  const revScaleR = revBase ? w.reversal / revBase : 0
  const revScaleM = revBase ? w.midRev / revBase : 0

  return feats.map(
    (_, i) =>
      w.lowVol * negVol[i] +
      // regime 自适应：走强时按各反转项占比等比例减弱，同时注入等量动量项。
      (w.reversal - shift * revScaleR) * rev5[i] +
      (w.midRev - shift * revScaleM) * rev20[i] +
      w.proximity * prox[i] +
      w.liquidity * liq[i] -
      w.turnStd * tStd[i] +
      w.revScaled * revScaled[i] -
      w.lottery * lottery[i] +
      w.ampMean * ampMean[i] +
      w.upShadow * upShadow[i] +
      w.ivol * ivol[i] +
      w.q * roeQ[i] +
      // 成长：仅走强时启用（乘 tilt），下跌市不暴露（成长因子在弱市常失效）。
      (w.growth || 0) * tilt * growth[i] +
      (w.revGrowth || 0) * tilt * revGrowth[i] +
      w.ep * ep[i] +
      w.event * evt[i] +
      shift * (w.tiltBoost || 1) * ((1 - (w.rallyMix || 0)) * (0.5 * rel[i] + 0.5 * mom[i]) + (w.rallyMix || 0) * (0.35 * rel[i] + 0.35 * mom[i] + 0.15 * betaZ[i] + 0.15 * nearHighZ[i])) +
      (w.beta || 0) * tilt * betaZ[i] +
      (w.nearHigh || 0) * tilt * nearHighZ[i],
  )
}
