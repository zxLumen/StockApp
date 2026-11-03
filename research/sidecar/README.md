# 研究 sidecar（Python）

> 独立容器跑 QuantStats / Alphalens / Qlib / vectorbt / Optuna / MLflow；
> **不装在线上 Node 镜像**，只读挂载数据，避免影响生产。

## 用法

```bash
# 1) 构建（一次性；建议在另一台机器/CI，不在生产容器里）
docker build -t stock-research -f research/sidecar/Dockerfile research/sidecar

# 2) 导出 shadow 快照为 parquet
docker run --rm -v docker_stock-data:/data:ro -v "$PWD/research:/research" \
  stock-research python /research/sidecar/export.py --data-dir /data --out /research/reports/shadow.parquet

# 3) QuantStats tear sheet（把 eval-strategies 的 JSON 转成收益 CSV 后）
docker run --rm -v "$PWD/research:/research" stock-research \
  python /research/sidecar/quantstats_report.py --in /research/reports/returns.csv --out /research/reports/tearsheets
```

## 工具分工

- **QuantStats**：月度 tear sheet / Sharpe / MDD / 月度归因。
- **Alphalens-reloaded**：B 链因子 IC / 分位收益 / 换手。
- **Qlib**：Alpha158/360 + ML 选股，长周期 walk-forward。
- **vectorbt**：权重/持有/阈值的大网格。
- **Optuna**：在训练/验证集上调参（禁止碰 holdout）。
- **MLflow**：记录每次 run 的参数/指标/artifact。
- **Promptfoo**：A 链 prompt/模型版本回归（Node CLI，也可不进 sidecar）。
- **Deflated Sharpe / PBO**：多重检验校正（可用 mlfinlab/pypbo 或自实现）。

## 红线

- 只读挂载 `/data`；不写生产数据。
- 训练/调参只用 `< 2026-10-01`；holdout 只评。
- 不把 sidecar 依赖装进生产 `web/Dockerfile`。
