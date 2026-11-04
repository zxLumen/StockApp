# 多策略研究/验证平台（2026-11）

> 目标：**线上 A/B/dual 完全不动**；同时跑一批**独立候选策略**，一个月后用统一口径找出最棒的。
> 最近一个月（2026-10-08~11-04）只评不训；候选只用 `< 2026-10-01` 的数据做前视验证。

## 1. 结构

```
线上（不动）          候选（shadow，独立）
A / B / dual    +     A-fixed20 / B-fixed20 / dual-fixed20 / blend50 / dual-t05 ...
```

- 选股来源：线上每日归档 `recommend-ai-fwd` / `recommend-factors-fwd` / `recommend`（shadow 只读快照）；**另有 Btuned**（`lowVol .3 + upShadow .4`，2025-07/08 网格最优，universe-stable，无行业上限）。
- 持有规则：`fixed5/10/20/30`、`llm`（逐票 ai.holdDays）、`trail10/12`（移动止盈）。
- 组合规则：`dual`（线上 regime）、`blend50`（A/B 各 50%）、`dual-t05/t07`（tilt 阈值 0.5/0.7）。
- 注册表：`research/configs/strategies-2026-11.json`（23 条：20 候选 + 3 近似对照）。
- 每日快照：`/data/shadow/{A,B,dual}/<生效日>.json`（cron 19:30/20:30）。
- 月度排行榜：`web/scripts/research/eval-strategies.js` → `docs/research/LEADERBOARD.md`。

## 2. 候选清单（23）

| 来源 | 持有规则 | 说明 |
|---|---|---|
| A | fixed10/20/30、llm、trail10/12 | LLM 选股；对比不同退出 |
| B | fixed5/10/20/30、llm、trail10 | 线上因子选股；对比不同持有 |
| **Btuned** | fixed10/20、trail10 | **新 B 选股**：低波+上影线权重；Top10 偏低波大盘（与线上 B 不同） |
| A-f | fixed20、trail10 | LLM A + 收盘>MA20 且 20日动量>0（确定性过滤；今日 10/10 全过，未拉开差异） |
| voltarget | fixed20、trail10 | 沪深300/创业板 20日波动率择链（确定性；今日选 A） |
| dual | fixed10/20、llm、trail10 | 线上 regime 的选股 + 不同持有 |
| blend50 | fixed20、trail10 | A/B 各 50%，不押 regime |
| dual-tilt | 0.5 / 0.7 + fixed20 | 换 regime 阈值 |
| live-A/B/dual | llm | **仅 12 月报告对照**，不进实验室 |

> 不是 6 个；是按“选股 × 持有 × 组合”展开的 20 个候选 + 3 个对照。12 月可继续加。

## 3. 前视验证（< 2026-10-01）的结论

用 `recommend-ai-ab` / `recommend-factors-ab` 在 **2025-07~2026-05（VAL）** 和 **2026-06~09（TEST）** 上跑逐票持有规则（均收益/均超额%，相对沪深300）：

| 规则 | A VAL | A TEST | B VAL | B TEST |
|---|---:|---:|---:|---:|
| fixed20 | 4.71 / 2.34 | -0.89 / 0.91 | 3.60 / 1.24 | 1.89 / 4.22 |
| fixed30 | 5.95 / 2.81 | — | 4.43 / 1.28 | -2.93 / 1.37 |
| llm（线上） | 2.81 / 1.39 | -0.68 / 0.24 | 2.04 / 0.80 | 1.53 / 2.40 |
| trail10 | 3.80 / 1.52 | -1.46 / 2.74 | 3.08 / 0.73 | 0.08 / 3.96 |
| trail12 | 3.80 / 1.49 | -2.10 / 3.02 | — | — |

- **B：fixed20 是唯一在 VAL+TEST 都稳的规则**；fixed30 在 VAL 最好但 TEST 转负。
- **A：fixed20/30 在 VAL 好；TEST 里 trail10/12 的超额最好**（但绝对仍负）。A 的选股在 2026-06~08 本身弱。
- **动态 vol/ATR/MA20/动量**整体不如固定长持；这不是拍脑袋 T+20，而是逐票规则搜索的结果。
- 结论：**没有单一规则在所有窗口都赢**；所以平台保留多个候选，让**前瞻一个月**来定。

## 4. 工具（该用的都用上）

### 已集成（Node，生产旁路）
- 逐票持有规则搜索（`hold-search.js`）、多策略注册表、每日 shadow、前瞻排行榜。
- bootstrap 95% CI、成本敏感性、风格基准（沪深300/创业板/中证1000）。
- holdout SHA-256 守卫（`guard.js`）、训练区间守卫。

### 研究 sidecar（Python，独立容器，12 月深挖）
| 工具 | 用途 | 状态 |
|---|---|---|
| **QuantStats** | tear sheet / Sharpe / MDD / 月度归因 | 已写 scaffold（`research/sidecar/`） |
| **Alphalens-reloaded** | 因子 IC / 分位收益 / 换手 | scaffold |
| **Qlib** | Alpha158/360、ML 选股、IC/ICIR | scaffold |
| **vectorbt** | 参数扫描（权重/持有/阈值） | scaffold |
| **Optuna** | 贝叶斯调参 | scaffold |
| **MLflow** | run 记录/对比 | scaffold |
| **Promptfoo** | A 链 prompt/模型版本回归 | scaffold |
| **Deflated Sharpe / PBO** | 多重检验/过拟合 | scaffold |
| **Riskfolio-Lib** | 仓位/风险平价 | scaffold |
| **arch** | 波动率 regime | scaffold |

> 不在生产主机上装 Qlib/MLflow 等重依赖；sidecar 只读挂载数据，避免影响线上。

## 5. 12 月怎么评

1. 跑 `eval-strategies.js --from 2026-11-04 --to 2026-12-05` → 排行榜。
2. 看前 5 名的 **均超额 + bootstrap CI + 成本后**，再和线上 3 个对照比。
3. 用 sidecar 的 **QuantStats** 出 tear sheet、**Deflated Sharpe** 校正多重检验。
4. 选出的赢家**不直接替换线上**；先作为下一轮 shadow 的基准，再决定是否上线。

## 6. 红线

- 不用 2026-10-08~11-04 的 holdout 训练/选规则。
- 不用 2026-11-04~12-05 的前瞻结果回头改策略再重评同一段。
- 线上 `recommend*`、cron、`model.json` 不动；shadow 只写 `/data/shadow`。


> 11-04 是 backfill：选股只用 ≤11-03 的数据，11-04 开盘建仓；11-05 起才是真正的盘前前瞻。
