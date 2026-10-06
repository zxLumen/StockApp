# runs/ · 每次训练 / 验证 / 测试的留档

> 规范见 `docs/REQUIREMENTS.md` §6。**每次运行都必须在此落下一条记录**，防止记忆退化。

## 目录结构

```
docs/runs/
  <A|B|dual>/
    train-YYYYMMDD-HHMM/
    val-YYYYMMDD-HHMM/
    test-YYYYMMDD-HHMM/
      config.json     # 参数、数据窗口、asOf 纪律
      command.txt     # 完整可复现命令
      result.json     # 指标（机器可读）
      log.txt         # 原始日志
      summary.md      # 结论 + 当时可见的数据 + 决策
```

## 每条记录的强制字段

- **方案**：A-only / B-only / 双链路。
- **阶段**：train / val / test。
- **数据窗口**：用到的日期区间；并显式声明**未使用未来数据**（`≤ asOf`）。
- **参数**：本次拟合/选定的全部参数（含 prompt 版本）。
- **命令**：`command.txt` 必须能一键复现。
- **结果**：`result.json` 至少含超额、胜率、逐月分布；结算按**每只票自选持有周期**。
- **结论**：`summary.md` 写清"当时能看到什么、据此做了什么决定"。

## 红线（摘自 REQUIREMENTS §8）

- 测试集（2026）在参数冻结前**不得**出现任何汇总。
- 任何一步不得使用 `> 决策日` 的数据。

> 说明：`log.txt` / `result.json` 若很大，可用 `.gitignore` 排除大文件、只提交
> `config/summary/command`；但**原始日志需在服务器/本地留存**并在 `summary.md` 注明位置。
