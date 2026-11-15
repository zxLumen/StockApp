# StockApp · 待办（新协议）

> 要求见 [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md)，划分见 [`docs/DATA-SPLIT.md`](docs/DATA-SPLIT.md)。
> 旧待办已归档：`docs/archive/2026-10/TODO.md`。
> **本文件不再保留任何旧评估结论**（旧记忆已清空）。
> Stage 2 参数逐项证据见 [`docs/runs/PARAM-AUDIT-2026-11-12.md`](docs/runs/PARAM-AUDIT-2026-11-12.md)。

## 目标

三套方案（**A-only / B-only / 双链路**）**各自独立、从头训练、各自留档**：
2024 训练 → 2025 验证 → 2026 只评一次；全程 point-in-time，无未来数据。

## 阶段

- [ ] **0. 留档 + 清空派生结果**
  - [x] 归档旧规划（`docs/archive/2026-10/`）
  - [x] `docs/REQUIREMENTS.md` / `docs/DATA-SPLIT.md` / `docs/runs/` 骨架
  - [ ] 重置派生结果：`data/recommend*/`、`llm-rank*/`、`info-sent/`（保留 kline/news/ann/finance）
    - 现状（11-12）：`data/recommend` 70 个文件、`recommend-ai-fwd` 5 个、`recommend-factors-fwd` 6 个仍在；**未重置（>2h）**
- [x] **1. 数据准备**
  - [x] 重抓日K（limit 1023，覆盖 2024 全年）
    - 2026-11-15：宇宙并集 1888 只，1885 只需重抓；3 轮跑完 **0 网络失败**（`docs/runs/KLINE-COVERAGE-2026-11-15.md`）
    - 复核时补齐 3 只「旧 600 根但首日早于 2024-03-01」的漏网票（信达证券/海通证券/中国重工，定向 `--secid` 重抓，0 失败）：600→861/1023/1023 根
    - 2024-01-02 前已上市的 **1786/1786 = 100%** 区间覆盖 2024-01-02~12-31（其中 1725 只 242 个交易日逐日无缺，61 只停牌等自然缺口）；另有 72 只 2024 年后上市（无 2024 数据）、30 只 2024 年内上市（按上市日部分覆盖）
    - 字面口径 `bars≥1000 且首日≤2024-01-05` 为 **1628/1888 = 86.23%**：新浪日K单次上限 1023 根（窗口起点≈2022-08-22），未达标的 260 只首日**全部**晚于该起点，天然不足 1000 根；该口径的理论上限即 86.23%，数学上不可达，不伪造通过
  - [x] 回补 2024 新闻（01~03 及缺口）—— news-archive 现 2023-12~2026-10
  - [x] 回补 2024 公告（及 2025/2026-01 缺口）—— ann-archive 现 2024-01~2026-10
  - [x] 产出「数据可用性报告」→ `docs/runs/DATA-AVAILABILITY.md`
- [ ] **2. 参数化改造（"不写死"）**
  - [x] 持仓周期：`normalizeHoldDays` 已去掉 `{3,5,10,20}` 档位锁，模型可按个股给 1–60 任意交易日；`factorHoldDays` 仅在 AI 失败时兜底（`web/lib/recommend.js:32-42`、`:809-811`）
  - [x] 因子权重 `DEFAULT_WEIGHTS` → `config/model.json` `factors.weights`（`web/lib/factors.js:220`、`web/lib/model-config.js:31-41`）；当前仍是引导值，Stage 3 训练后替换
  - [x] 门控 `thr` / `regimeTilt` lo·hi → `config/model.json` `dualChain.thr` / `tilt.lo·hi`（`web/lib/model-config.js:24-30`）；B 退役另有硬下限 0.6（`web/lib/recommend.js:581-599`，策略护栏）
  - [x] `OBJECTIVE` / `RECOMMEND_DEV_HI` → `config/model.json` `objective.*`；新增 `objectiveDeviationRange()` 统一训练/打分脚本的 15/40 来源（`web/lib/model-config.js:42-52`、`web/scripts/optimize-factors.js:130-132`、`web/scripts/score-candidates.js:45-46`）
  - [ ] `poolPages / topCandidates / finalPicks / maxPerIndustry` → `config/model.json` `select.*` 已接；残留 `runRecommendRegime` A 链 `topCandidates: 100`（`web/lib/recommend.js:947`）与 B 链 `candPool=30`（`:915` / `:953`），预计 **<2h**
  - [x] 训练脚本窗口参数化：`optimize-factors` 支持 `--train <year> --val <year>`，`RANGES/TRAIN_KEYS/HOLD_KEYS` 由年份自动展开（`web/scripts/optimize-factors.js:27-46`）
  - [x] 事件因子窗口参数化：`config/model.json` `factors.eventWindowDays`（默认 5）；改**交易日**口径（`lib/ann-factor.js` `eventWindowDays`，含其间自然日），`basisDate` 对齐前一交易日；`recommend.js` 每日自动归档当日公告
  - [x] `HIDDEN_RECOMMEND_*` 审计：保留硬编码展示窗口 `2026-03-01~09-30`（`web/lib/recommend.js:1147-1149`），纯展示隔离、不参与训练、不参数化（按 11-12 决定不动）
- [ ] **3. 训 B-only**：2024 拟合 → 2025 验证 → 冻结（留档）
  - 2026-11-15 结论：**2024 日K数据阻塞已解除**（2024-01-02 前上市股票 1786/1786 完整覆盖；抽样 20 只对新浪 20460 条 0 差异；npm test 281 全过）。字面 bars≥1000 口径 86.23% 受新浪 1023 根上限约束不可达，按 2024 覆盖口径判定通过。Stage 3 训练本轮未启动，未碰 2026 数据、未 push、未部署。
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
