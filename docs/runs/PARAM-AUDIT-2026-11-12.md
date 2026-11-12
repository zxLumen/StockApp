# Stage 2 · 参数化审计（2026-11-12）

**范围**：只审计 `docs/REQUIREMENTS.md §4` 列出的策略参数，不跑训练、不改 2026 数据、不部署。
**代码基线**：`main` @ `cc8fd40`（审计开始时）；本轮改动见文末。
**测试基线**：`cd web && npm test` → 281 tests / 281 pass / 0 fail（含本轮新增 2 条）。

## 结论表（7 项）

| # | 参数 | file:line 证据 | 结论 |
|---|---|---|---|
| 1 | `normalizeHoldDays` 是否锁定档位 | `web/lib/recommend.js:32-42`（`HOLD_DAYS_MIN/MAX/FALLBACK=1/60/5`，函数只做四舍五入与越界钳制）；`web/test/recommend.test.js:209-224`（1/3/4/5/7/10/12/20/23/45/60 均原样保留） | **已参数化**：`{3,5,10,20}` 档位锁已移除，模型可按个股给 1–60 任意交易日；1/60/5 只是防荒谬值的硬护栏，不是档位。 |
| 2 | `DEFAULT_WEIGHTS` | `web/lib/factors.js:220`（`DEFAULT_WEIGHTS = factorWeights()`）；`web/lib/model-config.js:31-41`（从 `MODEL.factors.weights` 读，`RECOMMEND_FACTOR_WEIGHTS` 仅覆盖）；`web/config/model.json:13-32` | **已参数化**：权重全部来自 `config/model.json`，代码不写死。注意当前值仍是引导值（`_note` 自述），Stage 3 训练后替换。 |
| 3 | `dualChain.thr` | `web/lib/model-config.js:24-25`（`tiltThreshold()` 读 `MODEL.dualChain.thr`）；`web/config/model.json:4-6`（0.6）；`web/lib/recommend.js:581-599`（`B_RETIRE_MIN_TILT = 0.6` + `pickChain` 取 `max(thr, 0.6)`） | **已参数化**：阈值可从模型/`RECOMMEND_DUAL_THR` 改；但 B 退役后另有硬编码下限 0.6（策略护栏，不是训练参数，当前 `STOCK_ENABLE_B!=1` 时恒走 A）。 |
| 4 | `regimeTilt` 的 `lo` / `hi` | `web/lib/model-config.js:26-30`（`tiltRange()` 读 `MODEL.tilt.lo/hi`）；`web/config/model.json:7-10`（-0.02 / 0.04）；`web/lib/factors.js:250-251`（线性映射使用 `tiltRange()`） | **已参数化**：lo/hi 来自模型，`RECOMMEND_REGIME_LO/HI` 仅用于稳健性检验覆盖。 |
| 5 | `OBJECTIVE` / `RECOMMEND_DEV_HI` | `web/lib/rank.js:193-194`（`OBJECTIVE = objectiveConfig()`）；`web/lib/model-config.js:42-52`（`objectiveConfig()` + 新增 `objectiveDeviationRange()`）；`web/config/model.json:34-41`；`web/lib/recommend.js:689-693`；`web/scripts/optimize-factors.js:130-132`；`web/scripts/score-candidates.js:45-46` | **已参数化**：OBJECTIVE 全字段读模型；`RECOMMEND_DEV_HI` 本轮修复为统一从 `objectiveDeviationRange()` 取 `objective.devHi`，脚本不再写死 40。`RECOMMEND_MAX_DEV` 仍保留为客观初筛的临时 env 覆盖。 |
| 6 | `poolPages` / `topCandidates` / `finalPicks` / `maxPerIndustry` | `web/lib/model-config.js:53-54`（`selectConfig()`）；`web/config/model.json:43-48`；`web/lib/recommend.js:22`（`SEL`）、`:635-638`、`:646`（daily 默认值）、`:1069`（refresh A 链用 `SEL.topCandidates`） | **已参数化（有 2 处残留）**：4 个参数已接 `model.json`；`web/lib/recommend.js:947` 的 A 链 `topCandidates: 100` 仍写死（与当前模型同值），B 链 `candPool=30` 也写死（见 `:915` / `:953`）。均不影响当前线上产出，已列入后续任务。 |
| 7 | `HIDDEN_RECOMMEND_*` | `web/lib/recommend.js:1147-1149`（`FROM=2026-03-01` / `TO=2026-09-30`） | **仍写死（有意）**：纯展示隔离窗口，不参与训练/选股；按任务要求不动。若要改，属产品展示口径变更，不是参数化。 |

## 本轮唯一修复：`RECOMMEND_DEV_HI`

**问题**：生产 `recommend.js` 已读 `OBJECTIVE.devHi`，但 `optimize-factors.js` 与 `score-candidates.js` 仍各自写死回退值 `15 / 40`。模型改了 `objective.maxDeviation/devHi` 后，训练/打分脚本不会跟着变，Stage 3 会出现「生产与训练口径不一致」。

**修法**：
- `web/lib/model-config.js:44-52` 新增 `objectiveDeviationRange()`：
  - 默认读 `config/model.json` 的 `objective.maxDeviation` / `objective.devHi`；
  - `RECOMMEND_DEV_LO/HI` 仍可覆盖（调参/回测）。
- `web/lib/recommend.js:692-693` 改用它（默认仍是 15 → 40，线上行为不变）。
- `web/scripts/optimize-factors.js:130-132`、`web/scripts/score-candidates.js:45-46` 改用它，删掉写死的 15/40。
- 顺手修正 env 空字符串：`model-config.js:16-21` 把空值视为未设置，避免 `Number('') === 0` 把参数静默覆盖成 0。
- 新增 `web/test/model-config.test.js` 2 条：默认值来自模型；env 覆盖与非法值回落。
- **影响面**：默认模型值不变（15/40），生产输出不变；只改训练/打分脚本的参数来源。

## 测试栈修复（为满足 `npm test` 验收）

`test/intraday.test.js` 直接 `import ../src/lib/intraday.ts`，在 Node 20.20.2 下报 `ERR_UNKNOWN_FILE_EXTENSION`，导致 272 项中 1 个测试文件失败。按仓库既有模式（`boardSort.js + .d.ts`、`aiHighlightTokens.js + .d.ts`）改为：

- 新增 `web/src/lib/intraday.js`（纯 JS 实现）
- 新增 `web/src/lib/intraday.d.ts`（类型声明）
- 删除 `web/src/lib/intraday.ts`
- `test/intraday.test.js` 改 import `.js`

结果：`npm test` **281/281 通过、0 失败**；`npm run typecheck` 通过。

## TODO 更新

- Stage 2 已完成项打勾：持仓周期、`DEFAULT_WEIGHTS`、`thr`/`tilt lo·hi`、`OBJECTIVE`/`RECOMMEND_DEV_HI`、训练脚本窗口、事件因子窗口、`HIDDEN_RECOMMEND_*` 审计。
- 仍留 1 项未完成：`poolPages/topCandidates/finalPicks/maxPerIndustry` 的 2 处残留（`runRecommendRegime` A 链 `topCandidates:100`、B 链 `candPool=30`），预计 **<2 小时**，已列入后续任务。
- 修正 Stage 1 的日K勾选：抽样 266 个 `web/data/kline-cache` 文件，248 个仍是 600 根，240 个首月为 2024-04；「1888 只 × 1023 根」不成立，改为未完成。

## Stage 3 能否开跑

**暂不能开跑。** 主要缺 2024 全年日K：Stage 3 要「2024 训练 → 2025 验证」，但抽样 248/266 个缓存只有 600 根、240 个从 2024-04 起，2024-01~03 缺失。先完成 Stage 1 的日K重抓（limit 1023，覆盖 2024 全年）再开。

其余条件：
- 参数化：本轮已把训练/打分的偏离区间统一到模型；训练窗口已支持 `--train/--val`；事件窗口已参数化。
- 数据：2024 新闻/公告已覆盖（news 2023-12 起、ann 2024-01 起）。
- 待清理（不阻塞训练脚本，但影响流程纪律）：Stage 0 的派生结果（`data/recommend` 70 个文件等）尚未重置；2 处 `topCandidates/candPool` 残留可用 <2h 清掉。
- `HIDDEN_RECOMMEND_*` 不影响 Stage 3（展示层）。

## 变更

- `web/lib/model-config.js`
- `web/lib/recommend.js`
- `web/scripts/optimize-factors.js`
- `web/scripts/score-candidates.js`
- `web/src/lib/intraday.js`（新）、`web/src/lib/intraday.d.ts`（新）、删除 `web/src/lib/intraday.ts`
- `web/test/intraday.test.js`、`web/test/model-config.test.js`（新）
- `TODO.md`、本文件

不部署、不 push。
