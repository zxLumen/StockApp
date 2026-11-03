# 研究 / 评估层（Research）

> 这一层**只读**真实数据，不改线上策略、不改 `web/lib/*` 生产代码、不改 cron。
> 目的：用可复现的方式评估 A/B/dual 与模拟持仓，并为后续调优提供**不污染 holdout** 的流程。

## 先读这三份

1. **[HOLDOUT.md](./HOLDOUT.md)** —— 哪些数据只能评、不能训（最重要）
2. **[METHODOLOGY.md](./METHODOLOGY.md)** —— 指标口径、基准、成本、已知局限
3. **[FINDINGS-2026-11-04.md](./FINDINGS-2026-11-04.md)** —— 本期真实 holdout 的结论

其他：
- [TUNING-PROTOCOL.md](./TUNING-PROTOCOL.md) —— 训练/验证/holdout 的划分与 walk-forward 规则
- [TOOLING.md](./TOOLING.md) —— 工具调研（Qlib/vectorbt/QuantStats/…）与 sidecar 方案
- [RUN-2026-11-04.md](./RUN-2026-11-04.md) —— 由脚本生成的逐日明细

## 目录

```
research/holdout/                 # 冻结的真实前瞻快照（只读）
  forward/{dual,A,B}/*.json       # 2026-10-08 ~ 2026-11-04
  actions/2026-10-30.json         # PIT actions 快照
  benchmarks.json                 # 沪深300/中证500/中证1000/创业板/科创50
  manifest.json                   # SHA-256 清单（脚本强校验）
docs/research/                    # 本目录（方法/结论/工具）
research/reports/                 # 评估 JSON 输出
web/scripts/research/             # 研究脚本（不被生产引用）
```

## 快速运行

```bash
# 1) 校验快照没被改动
node web/scripts/research/guard.js --check --snapshot research/holdout

# 2) 跑 holdout 评估（容器内，仓库挂 /repo，数据卷挂 /data）
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD:/repo" -v docker_stock-data:/data -w /repo/web \
  ghcr.io/zxlumen/stock-web:latest \
  node scripts/research/eval-holdout.js --data-dir /data --snapshot /repo/research/holdout \
    --from 2026-10-08 --to 2026-11-04 \
    --out /repo/docs/research/RUN-2026-11-04.md \
    --json /repo/research/reports/holdout-2026-11-04.json
```

## 红线

- **2026-10-01 起**的真实前瞻数据 = holdout，**只能评估，禁止训练/调参/选特征/选阈值**。
- 训练/调参必须使用 `< 2026-10-01` 的数据（日K PIT 回测；现有 `tune-factors.js` 的 7/8 月窗口）。
- 任何对快照的改动都要更新 `manifest.json` 并显式说明；`eval-holdout.js` 会校验 SHA-256。
- 评估读**快照**，不读线上 `/data/recommend*`（线上会被每日刷新/追加，且 actions 会带入未来信息）。
