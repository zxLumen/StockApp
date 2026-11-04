# 监控与窗口报告（2026-11）

## 1. 每天在跑什么

| 时间 | 任务 | 说明 |
|---|---|---|
| 09:00 | 线上盘前刷新 | 线上 A/B/dual，不变 |
| 18:30 | 线上盘后推荐 | 线上 A/B/dual，不变 |
| 19:30/20:30/21:30 | `stock-shadow.sh` | 记录 A/B/dual 次日快照 + 计算 Btuned 新 B 选股 |
| 任意时间 | 策略实验室 | `https://stock.zxlumen.cn/` →「策略实验室」；30 策略的推荐/持仓/排行榜 |

## 2. 窗口报告（自动发邮件）

- 收件人：**liuzixiang@zxlumen.cn**；发件人：`no-reply@zxlumen.cn`（msmtp/Resend）。
- 通道已验证：2026-11-04 03:22 测试邮件，Resend 返回 250。
- 窗口与定时（22:00，线上/实验室数据已就绪）：

| 日期 | 标签 | 含义 |
|---|---|---|
| 2026-11-10 | `week1` | 第 1 周（5 个生效日） |
| 2026-11-24 | `mid` | 月中（约 15 个生效日） |
| 2026-12-04 | `final` | 一个月 |
| 2026-12-08 | `finalplus` | 完整前瞻窗（到 12-05） |

- 每次自动执行：
  1. `eval-strategies.js` 跑前瞻排行榜；
  2. 生成 `docs/research/WINDOW-<date>-<label>.md`；
  3. 发 HTML 邮件（含自动结论、Top 8、线上对照、最差 3、口径提醒、实验室链接）。

## 3. 邮件/报告里的判定口径

- 主指标：**均超额**（同窗口风格基准）+ bootstrap 95% CI；辅以均收益、胜率、成本 0.3% 后。
- 必须对照 **live-A / live-B / live-dual**（近似；未复刻 AI 提前终止）。
- 样本 < 3 个生效日 → 不出排名；一个月样本 → 只作**指示**，不作最终定论。
- 8 个独立策略 → 多重检验；最终用 Deflated Sharpe/PBO（sidecar）校正。
- **不要**用窗口结果回头改策略再重评同一段；下一轮用新的一段。

## 4. 各窗口看什么 / 决策

### 11-10（第 1 周）
- 看数据完整性：A/B/dual/Btuned 是否每天都有；实验室持仓是否正常。
- 看 Top/Bottom 是否与**前视验证**一致（B fixed20、A fixed20/30 或 trail10/12）。
- **不淘汰**任何策略；只记录异常。

### 11-24（月中）
- 淘汰：连续落后线上对照、且 CI 明显为负的候选。
- 加新引擎（若已训练/验证）：A 选股过滤/量化大盘 A、B 因子全量搜索、dual 波动率目标。
- 仍然**不改线上**。

### 12-04（一个月）
- 主排名：均超额 + CI + 成本后 + 回撤。
- 选出 1-2 个候选，和线上 A/B/dual 做逐日对照；给出“是否值得进入下一轮 shadow”的结论。
- 不直接替换线上。

### 12-08（完整窗）
- 补上 12-05 的数据，出最终版；写 `docs/research/FINAL-2026-12.md`。

## 5. 前视验证（< 2026-10-01）的参考

| 规则 | A VAL | A TEST | B VAL | B TEST |
|---|---:|---:|---:|---:|
| fixed20 | 4.71 / 2.34 | -0.89 / 0.91 | 3.60 / 1.24 | 1.89 / 4.22 |
| fixed30 | 5.95 / 2.81 | — | 4.43 / 1.28 | -2.93 / 1.37 |
| llm（线上） | 2.81 / 1.39 | -0.68 / 0.24 | 2.04 / 0.80 | 1.53 / 2.40 |
| trail10 | 3.80 / 1.52 | -1.46 / 2.74 | 3.08 / 0.73 | 0.08 / 3.96 |

> 格式：均收益% / 均超额%（相对沪深300）。完整见 [STRATEGY-2026-11.md](./STRATEGY-2026-11.md)。

## 6. 手动重跑

```bash
/home/ubuntu/stock-lab-report.sh mid --dry-run   # 只生成 md，不发邮件
/home/ubuntu/stock-lab-report.sh mid             # 生成并发邮件
```

- 日志：`~/zx-stock-lab-report.log`
- 报告：`docs/research/WINDOW-<date>-<label>.md`
- 排行榜 JSON：`research/reports/leaderboard.json`
- 实验室接口：`/api/lab/strategies`、`/api/lab/recommend`、`/api/lab/positions`、`/api/lab/leaderboard`

## 7. 红线

- 线上 `recommend*`、cron、`model.json` 不动；实验室只读 `/data/shadow`。
- 不用前瞻窗训练/调参；不用窗口结果反复重评同一段。
- 报告是决策辅助，不是收益承诺。
