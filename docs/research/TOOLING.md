# 工具调研（2026-11）

> 目标：在不影响线上 Node 服务的前提下，补研究/回测/统计/LLM 评测能力。

## 1. 研究/回测（Python sidecar，推荐）

| 工具 | 用途 | 适配度 | 备注 |
|---|---|---|---|
| **Qlib（微软）** | AI 量化全流程；Alpha158/360、IC/ICIR/RankIC、回测、模型库 | ★★★★★ | A 股友好；可与 R&D-Agent-Quant 配套 |
| **vectorbt** | 向量化、超快参数扫描 | ★★★★★ | 适合 holdDays/阈值/权重网格 |
| **Alphalens-reloaded** | 因子 IC、分位收益、换手 | ★★★★★ | 评估 B 链因子 |
| **QuantStats** | tear sheet：Sharpe/Sortino/Calmar/MDD/alpha-beta | ★★★★★ | 一键报告 |
| **pyfolio-reloaded / empyrical-reloaded** | 组合风险/收益归因 | ★★★★ | |
| **Backtrader / Zipline-reloaded / Backtesting.py** | 事件驱动，撮合/成本/滑点 | ★★★★ | 需要更真实的成交模型时 |
| **bt** | 组合/再平衡回测 | ★★★ | |
| **NautilusTrader** | 高性能、实盘级 | ★★★ | 以后接券商 |
| **PyPortfolioOpt / Riskfolio-Lib** | 组合优化/风险平价 | ★★★★ | 仓位/行业中性 |
| **statsmodels / arch / scipy** | 回归 alpha、GARCH、bootstrap | ★★★★ | |

## 2. A股数据/日历

- **AKShare**（免费、覆盖广）、**Tushare Pro**（质量高、积分）、**BaoStock**（免费稳定）、**efinance**（东财）。
- **exchange_calendars / pandas-market-calendars**：交易日历。
- 建议补 **PIT 成分股/退市股**，消除幸存者偏差。

## 3. 实验管理/调参/LLM 评测

| 工具 | 用途 | 适配度 |
|---|---|---|
| **Optuna** | 因子权重/阈值/持有期调参 | ★★★★★ |
| **MLflow**（自托管） | 记录 run 的参数/指标/曲线/artifact | ★★★★★ |
| **W&B** | 同上（托管） | ★★★★ |
| **DVC** | 数据/模型版本化 | ★★★ |
| **Promptfoo**（Node CLI） | prompt 版本对比、LLM-as-judge、回归测试 | ★★★★★（与当前栈最贴） |
| **inspect_ai / DeepEval / RAGAS** | Python 侧 LLM/RAG 评测 | ★★★★ |

## 4. 过拟合/显著性

- **Deflated Sharpe Ratio**（Bailey & López de Prado）、**pypbo**、**mlfinlab**。
- **bootstrap 置信区间** + **walk-forward** + 多市场状态分层。
- 记录尝试次数，避免“挑最好看的一次”。

## 5. Sidecar 方案（不碰生产）

```
research/sidecar/                # 独立的 Python 环境（不加入 web/）
  requirements.txt               # qlib, vectorbt, quantstats, alphalens-reloaded, ...
  export.py                      # 把 web/data 的 JSON/kline-cache 导出为 parquet
  eval.py                        # 读 parquet，跑指标/tear sheet
```
- 只读挂载：`-v repo/web/data:/data:ro`；不要写 `/data`。
- 运行：`docker run --rm -v repo:/repo -v repo/web/data:/data:ro research-sidecar ...`
- 生产 Node 服务不变；sidecar 只在研究和报告时运行。

## 6. 建议的落地顺序

1. 把本期 `eval-holdout.js` 的指标固化（已完成）。
2. 接 **QuantStats** 生成 tear sheet（周报）。
3. 用 **Optuna + MLflow** 做 B 链因子/行业上限的训练/验证调参。
4. 用 **Promptfoo** 做 A 链 prompt/模型版本的回归评测。
5. 用 **Qlib/vectorbt** 做更长周期的 walk-forward 与过拟合校正。
