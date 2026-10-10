# StockApp · 待办（新协议）

> 要求见 [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md)，划分见 [`docs/DATA-SPLIT.md`](docs/DATA-SPLIT.md)。
> 旧待办已归档：`docs/archive/2026-10/TODO.md`。
> **本文件不再保留任何旧评估结论**（旧记忆已清空）。

## 目标

三套方案（**A-only / B-only / 双链路**）**各自独立、从头训练、各自留档**：
2024 训练 → 2025 验证 → 2026 只评一次；全程 point-in-time，无未来数据。

## 阶段

- [ ] **0. 留档 + 清空派生结果**
  - [x] 归档旧规划（`docs/archive/2026-10/`）
  - [x] `docs/REQUIREMENTS.md` / `docs/DATA-SPLIT.md` / `docs/runs/` 骨架
  - [ ] 重置派生结果：`data/recommend*/`、`llm-rank*/`、`info-sent/`（保留 kline/news/ann/finance）
- [ ] **1. 数据准备**
  - [x] 重抓日K（limit 1023，覆盖 2024 全年）—— 1888 只 × 1023 根（2022-07 起）
  - [x] 回补 2024 新闻（01~03 及缺口）—— news-archive 现 2023-12~2026-10
  - [x] 回补 2024 公告（及 2025/2026-01 缺口）—— ann-archive 现 2024-01~2026-10
  - [x] 产出「数据可用性报告」→ `docs/runs/DATA-AVAILABILITY.md`
- [ ] **2. 参数化改造（"不写死"）**
  - [ ] 持仓周期：去掉 `normalizeHoldDays` 的 `{3,5,10,20}` 锁定；去掉 B 链路 `factorHoldDays` 强制，改为**模型按个股自由给**
  - [ ] 因子权重 `DEFAULT_WEIGHTS` → 训练产物
  - [ ] 门控 `thr` / `regimeTilt` lo·hi → 训练产物
  - [ ] `OBJECTIVE`（`rank.js`）/ `RECOMMEND_DEV_HI` → 训练产物
  - [ ] `poolPages / topCandidates / finalPicks / maxPerIndustry` → 训练产物
  - [ ] 训练脚本窗口参数化（`optimize-factors` 的 `RANGES/TRAIN_KEYS/HOLD_KEYS`）
  - [x] 事件因子窗口参数化：`config/model.json` `factors.eventWindowDays`（默认 5）；改**交易日**口径（`lib/ann-factor.js` `eventWindowDays`，含其间自然日），`basisDate` 对齐前一交易日；`recommend.js` 每日自动归档当日公告
  - [ ] `HIDDEN_RECOMMEND_*` 按新划分重算
- [ ] **3. 训 B-only**：2024 拟合 → 2025 验证 → 冻结（留档）
- [ ] **4. 训 A-only**：2024 开发 prompt/`w` → 2025 验证 → 冻结（留档）
- [ ] **5. 训双链路**：门控在 A、B 冻结后训（2024 选 / 2025 确认）→ 冻结（留档）
- [ ] **6. 一次性测试 2026**：三套各一次，按**每只票自选持有周期**结算（留档）
- [ ] **7. 上线 + 新留档**：双链路模式不变，只换冻结参数；更新 REQUIREMENTS/变更记录

## 红线（勿违反）

1. 2026 不参与任何训练/验证/调参/prompt。
2. 不用 `> 决策日` 的数据。
3. 冻结前不看测试集汇总。
4. 策略参数不写死。
5. 每阶段留档。
6. 回测不写进 `data/recommend/`。
