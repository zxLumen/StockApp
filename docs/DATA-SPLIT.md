# 数据划分与用途（新协议）

> 要求事实源见 [`REQUIREMENTS.md`](REQUIREMENTS.md)。本文只讲**划分与红线**。
> 旧划分已作废，见 `docs/archive/2026-10/DATA-SPLIT.md`。
> 最近更新：2026-10-06。

## 0. 划分（硬性）

| 集合 | 区间 | 用途 | 可否用于调参 |
| --- | --- | --- | --- |
| **训练 Train** | 2024-01-01 ~ 2024-12-31 | 拟合全部可训练参数 | ✅ |
| **验证 Val** | 2025-01-01 ~ 2025-12-31 | 选型确认 | ⚠️ 只检验 |
| **测试 Test** | 2026-01-01 ~ 2026-12-31 | 冻结后**只评一次** | ❌ 红线 |
| **前瞻 Forward** | 2026-10 之后 | 最终干净证据 | ❌ 红线 |

- **2026 完全排除在"模型"之外**（训练/验证/调参/prompt 开发一律不得用）。
- **测试集封口**：参数冻结前不得计算 2026 的任何汇总。

## 1. Point-in-time 红线

每一步（特征 / 拟合 / prompt / 评估）只用 `≤ 决策日 D` 的数据：

- 日K 截断 `≤ D`；财务 `NOTICE_DATE ≤ asOf`（越界报错）；公告/新闻 `time ≤ D`。
- 训练/验证/测试共用同一 `asOf` 注入，禁止"全量"旁路。
- **事件因子窗口按交易日**：回看 N 个交易日（默认 5，见 `config/model.json` 的
  `factors.eventWindowDays`），含其间自然日；`basisDate` 先对齐到 `≤` 它的最后一个交易日
  （见 `lib/ann-factor.js` 的 `eventWindowDays`）。这样窗口恒覆盖 N 个交易日，不被长假扭曲。
  公告归档（`ann-archive`）由每日 `scripts/recommend.js` 自动补当日（best-effort）。

## 2. 数据可用性（决定各窗口能否真跑）

| 数据 | 现状 | 需要补 |
| --- | --- | --- |
| 日K（`kline-cache`） | 最早 **2024-04-15**（limit 600） | **重抓 limit 1023**，回到 ~2022，覆盖 2024 全年 |
| 新闻（`news-archive`） | 2024-04~12 已补；2025-01~09；2026-02~10 | 补 **2024-01~03**；尽量多列（现单列 347 偏薄） |
| 公告（`ann-archive`） | **2024-01 ~ 2026-10**（已回补，963 日） | 每日由 `scripts/recommend.js` 自动续档 |
| 财务（`finance`） | 点时可用（实测 2024-06 起覆盖正常） | 无需 |

## 3. 目录 → 保留 / 重置

- **保留（原始事实源，不删）**：`kline-cache` / `news-archive` / `ann-archive` / `finance`。
- **重置（旧协议派生结果，作废）**：
  - 拟合参数：`DEFAULT_WEIGHTS`、`thr`、`HIDDEN_RECOMMEND_*` 等（代码内常量，改为训练产物）。
  - 评估目录：`data/recommend-ai-ab` / `recommend-factors-ab` / `recommend-2025-09` /
    `recommend-factors-oos` / `recommend-bt` / `llm-rank*` / `info-sent` 等。
  - 归档留证：`docs/archive/2026-10/`。

## 4. 旧协议为何作废

旧划分在 2026 上选型/调参又把 2026 当前瞻，样本内当成绩；`thr=0.6` 是"看过全部评估窗后"
挑的。详见归档 README。

## 5. 各方案

三套方案（A-only / B-only / 双链路）**各自**按本文划分训练/验证/测试，各自留档
（`docs/runs/`）。
