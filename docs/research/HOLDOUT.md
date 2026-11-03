# Holdout 规则（红线）

## 1. 划分

| 用途 | 区间 | 数据来源 | 规则 |
|---|---|---|---|
| 训练 / 调参 | `< 2026-10-01` | `web/data/kline-cache` 的 PIT 日K；现有 `tune-factors.js` 用 2026-07/08 | 可调权重/阈值/持有期/行业上限 |
| 验证 | `< 2026-10-01` 内再切（建议 2026-09） | 同上 | 只用于选型，不碰 holdout |
| **Holdout（只评）** | **`>= 2026-10-01`**，实际有数据：`2026-10-08 ~ 2026-11-04` | 线上真实前瞻归档，已冻结到 `research/holdout/forward/{dual,A,B}` | **禁止任何形式的训练/调参/特征选择** |

> 为什么 cutoff 是 10-01 而不是 10-08：10-08 是第一个有归档的生效日；把 10-01 作为边界，给“边界内不得训练”留出安全余量。

## 2. 冻结快照

- 位置：`research/holdout/`
- 内容：60 份推荐（20 天 × 3 链）+ `actions/2026-10-30.json` + `benchmarks.json`
- `manifest.json` 记录每份文件的 SHA-256、字节数、chain、date。
- 校验：
  ```bash
  node web/scripts/research/guard.js --check --snapshot research/holdout
  ```
- **快照只读**。不得为了“让结果好看”而改快照；任何改动都必须：
  1. 说明原因；
  2. 重新生成 manifest；
  3. 在 `docs/research/` 留变更记录。

## 3. 为什么必须用快照、不能用线上目录

- 线上 `/data/recommend*` 每天被 cron 追加/刷新；同一日期可能被 09:00 盘前刷新覆盖。
- 线上 `recommend-actions.json` 会包含**之后**的 AI 终止/延长 → 用它对 10 月做评估 = 未来信息泄漏。
- 线上日K会继续更新；“至今收益”会漂移。快照 + `dataLastBar` 固定了截面。

因此：**评估只读 `research/holdout/forward/*`，不读 `/data/recommend*`。**

## 4. 训练侧守卫

```bash
# 允许（早于 cutoff）
node web/scripts/research/guard.js --train 2026-07-01 2026-08-31

# 拒绝（触及 holdout）
node web/scripts/research/guard.js --train 2026-09-01 2026-10-01
# -> [guard] 拒绝训练：... 触及 holdout ...
```

任何未来的调参脚本都必须先调用 `assertTrainRange(from, to)`。

## 5. 已知缺口

- `actions` 快照只有 **2026-10-30**，没有 11 月 → 本报告**不评估 AI 动态退出/延长**（只用持有周期基线）。
- 快照里的推荐是**线上真实产出**，没有回填、没有重跑；这正是它的价值。
- 结论只代表 **2026-10-08 ~ 11-04** 这一段；样本小，不能外推。
