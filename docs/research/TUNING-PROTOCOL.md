# 调参协议（不污染 holdout）

## 1. 数据切分

| 集合 | 区间 | 用途 |
|---|---|---|
| 训练 | `2025-01-01 ~ 2026-06-30`（或按可得数据） | 拟合因子权重/阈值 |
| 验证 | `2026-07-01 ~ 2026-09-30` | 选型、早停、行业上限 |
| **Holdout** | `2026-10-08 ~ 2026-11-04` | **只评一次，不参与任何选择** |

- 现有 `web/scripts/tune-factors.js` 用 2026-07（训练）/ 2026-08（验证），属于合法范围；
  建议再加 **2026-09 验证**，把 10 月完全留空。
- 任何脚本入口先调用 `assertTrainRange(from, to)`；跨越 cutoff 直接抛错。

## 2. 调参对象（按优先级）

1. **B 链因子权重**：`reversal / midRev / q / event / turnStd / lowVol` 等（`web/config/model.json` 的 `factors.weights`）。
2. **行业上限**：`maxPerIndustry`（现有 `sweep-industry-cap.sh`），B 的电子/通信/机械占比 ~80%，是本期亏损集中区。
3. **持有期**：B 现在 3 天为主；本期“短持”救了 15.5pp，但不要只因为一个月的退出收益就缩短周期——用验证集。
4. **退出规则**：`eval-exit-policy.js` 的 OLD/NEW/HOLD 对照；在训练/验证上选，holdout 只评。
5. **Regime**：先用训练/验证做「A only / B only / tilt 阈值 / 加趋势过滤」的对照；**不要**用 10 月结果反推。

## 3. 统计要求

- 每个候选配置至少报告：逐票均值 + bootstrap 95% CI、风格超额、β/α、成本敏感性。
- 多配置比较要做**多重检验**意识：记录尝试次数；最终用 **Deflated Sharpe / 白's Reality Check** 校正（后续工具）。
- Walk-forward：按月滚动训练/验证，holdout 只在最后评一次。
- 记录：git sha、数据快照 hash、配置 JSON、运行命令、日期。

## 4. 禁止

- 用 `2026-10-01` 及以后的数据选权重/阈值/行业上限/持有期/特征。
- 看到 holdout 结果后回头改配置再“重新评估”同一段 holdout（等于污染）。
- 直接改线上 `web/config/model.json` 或 `web/lib/factors.js` 而不经过训练/验证与评审。

## 5. 产出

- 候选配置写到 `research/configs/<name>.json`（不进生产）。
- 对照报告写到 `docs/research/TUNING-<date>.md`。
- 只有通过验证、且明确批准的配置，才由人工合入 `web/config/model.json` 并部署。
