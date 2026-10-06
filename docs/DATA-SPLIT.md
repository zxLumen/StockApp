# 数据集划分与用途（留档 · 唯一权威）

> 本文是 StockApp 因子 / 链路研究的**数据划分唯一权威说明**。任何新增回测、调参、
> 评估窗口，**必须同时更新本文与代码里的对应常量**：
>
> - `web/scripts/optimize-factors.js` 的 `RANGES` / `TRAIN_KEYS` / `HOLD_KEYS`
> - `web/scripts/tune-factors.js` 的 `TRAIN` / `VAL`
> - `web/scripts/factor-ic.js`、`score-candidates.js`、`score-info.js`、`eval-*.js` 的默认 `--from/--to`
> - `web/lib/recommend.js` 的 `HIDDEN_RECOMMEND_FROM` / `HIDDEN_RECOMMEND_TO`
>
> **改了窗口不更新本文 = 违规。** 数据文件本身被 `.gitignore` 忽略（不进仓库），
> 本文是划分口径的唯一记录。

## 0. 速览

| 集合 | 日期区间 | 用途 | 可用于调参 | 线上展示 |
| --- | --- | --- | --- | --- |
| **训练集 Train** | 2026-07-01 ~ 2026-09-30 | 拟合因子权重、事件权重、`midRev/q` 等参数 | ✅ | ❌ 隐藏 |
| **验证集 Validation** | 2026-03-01 ~ 2026-06-30 | 选型检验、单参数确认（不反复搜） | ⚠️ 只检验 | ❌ 隐藏 |
| **评估集 Eval** | 2024-09 / 2025-01 / 2025-08 / 2025-09 + 2026-02~09 各月 | A/B 链路对照、选 `thr` | ⚠️ 见 §4 | ❌（2026-03~09 段隐藏）|
| **样本外封存 Sealed OOS** | 2025-09 | 冻结词表后**只看一次** | ❌ 红线 | ❌ |
| **测试 / 前瞻 Test/Forward** | 2026-10-01 ~ | 真实前瞻、线上对外展示 | ❌ 红线 | ✅ 展示 |

> 2026-02~09 是**因子优化总窗口**（8 个月）。其内部再分：**训练 7-9 月、验证 3-6 月**，
> 2 月不进 train/val 分组，只进「全窗口均值 / 最差月」统计。
> 2025-09 同时是「评估窗口」和「封存样本外」，以 §5 的红线为准。

## 1. 训练集 Train —— 2026-07-01 ~ 2026-09-30

- **用途**：拟合 `DEFAULT_WEIGHTS`（`reversal/midRev/upShadow/q/event` 等）与 tilt 相关参数。
- **代码常量**：`optimize-factors.js:38 const TRAIN_KEYS = ['Jul','Aug','Sep']`
  （对应 `RANGES:33-35`，2026-07/08/09）。
- **权重来源可追溯**：`web/lib/factors.js:213-224`（非网格搜索；训练均 +1.47（7-9）/ 验 +1.11（3-6）），
  `:234`（`midRev=0.35` 训练/验证/留一月 CV 一致）。
- **⚠️ 关键事实**：**2026-09（9 月）属于训练集**，即 9 月数据**被用于调整模型**。
  因此它**不是**前瞻 / 样本外，不得当作「实盘成绩」对外展示（见 §6）。

## 2. 验证集 Validation —— 2026-03-01 ~ 2026-06-30

- **用途**：训练得到配置后用于检验（选型、单参数确认）。
- **代码常量**：`optimize-factors.js:39 const HOLD_KEYS = ['Mar','Apr','May','Jun']`。
- **规则**：验证集**只做检验**，不在其上反复搜索（否则退化成第二个训练集）。
  当前窗口已从早期「7/8/9 三个月既训练又报告」的坑里扩到 2026-02~09，见
  `optimize-factors.js:7-10`。

## 3. 测试集 / 前瞻 Test / Forward —— 2026-10-01 起

- **用途**：真实前瞻（生产 cron 每天产出），**线上唯一对外展示**的推荐。
- **红线**：把 2026-10 起的前瞻数据当**测试集**（只判不改）。若将来要据此重标 `thr`
  （`TODO.md` 第 2 项），须把那批数据在本文里**重新归类为验证**，此后新产出才是新测试集 ——
  不能用「测试集」反复调参。
- **线上形态**：`recommend.js` 默认双链路（`thr=0.6`）每日落盘
  `DATA_DIR/recommend/<生效日>.json`，经 `/api/recommend*` 展示。
- **双链路归档**：每日同时把 A、B 两条各写一份到 `recommend-ai-fwd/`、`recommend-factors-fwd/`
  （标准 payload + 当天 `tilt/thr`），用于积累样本外 A/B 对照。归档**只增不改**。

## 4. 评估集 / 回测窗口

用于 **A 链路 vs B 链路**对照与 `thr` 选择，**不是**训练/验证的替代品。

- **A 回测**：`data/recommend-ai-ab/`（成交额池 + AI 初筛 100 + 买入评分）
- **B 回测**：`data/recommend-factors-ab/`（稳健池 + 客观多因子）
- 两者实测均覆盖 `2024-09-03 ~ 2026-09-01`，**且非连续**，只有以下窗口月：
  `2024-09`、`2025-01`、`2025-08`、`2025-09`、`2026-02 ~ 2026-09`（各月约 18~23 个交易日）。
- **复现命令**：`node scripts/eval-ab-combo.js --a recommend-ai-ab --b recommend-factors-ab --thr 0.6 --from … --to …`
  （见 `TODO.md:30`、`README.md:92`）。
- **生成命令**（目录名须显式 `--out`，代码里无默认写入点）：
  `node scripts/backtest.js --out recommend-ai-ab --strategy ai --from … --to …`；
  B 侧同理 `--out recommend-factors-ab --strategy factors`。
- **⚠️ 已知局限**：`2026-07/08` 的 A/B 对照**用的是训练集月份**，属样本内对照；
  `thr=0.6` 是在**看过全部评估窗口之后**挑的，本身带评估环过拟合（`TODO.md:53-58`）。

## 5. 样本外封存 Sealed OOS —— 2025-09

- **用途**：真正的样本外检验窗口，**冻结词表 / 定死参数之后只看一次**。
- **数据目录**：`data/recommend-2025-09/`（`2025-09-05 ~ 2025-10-01`）。
- **红线**：看过一次后，**不得再据此调参**；否则它就不再是样本外。
  当前结论保留在 `web/lib/factors.js:242`（`event` 加权重后 2025-09 仍为负）。
- 该窗口的历史数据靠 `archive-history.js`（`2025-08-01 ~ 2025-09-30`）回补。

## 6. 线上展示口径（隐藏窗口）

- **规则**：**2026-03-01 ~ 2026-09-30（验证 3-6 月 + 训练 7-9 月）不对访客展示**，
  线上只展示 **2026-10 起的前瞻**。
- **代码（唯一实现处）**：`web/lib/recommend.js:846-857` 的 `HIDDEN_RECOMMEND_FROM/TO`
  + `isHiddenRecommendDate`；服务端 `listRecommendDates`（`:865`）与
  `loadRecommend`（`:877-879`，显式 `?date=` 也挡）双重过滤。
- **理由原文**：这些天是训练/验证样本，展示等于把样本内数据当实盘，误导访客并污染
  「整体盈亏」口径（`web/lib/recommend.js:849-851`）。
- **注意**：本地 `data/recommend/` 里 2026-07~09 的文件是**因子策略的批量回放**
  （2026-10-04/05 一次性生成，`pickedBy=factor`、无 `regime`），**不是**当天真实产出，
  也不是双链路产物；它们因落在隐藏窗口而不对外。

## 7. 数据目录 → 集合 对照

| 目录 | 归属 | 说明 |
| --- | --- | --- |
| `data/recommend/` | 线上展示 | 生产产物；2026-03~09 段被隐藏窗口过滤 |
| `data/recommend-bt/` | 回测 | `backtest.js` 默认输出；**不可写进 `recommend/`**（`:41-43` 警告会顶掉真实历史）|
| `data/recommend-ai-ab/` | 评估集·A | A 链路回测样本 |
| `data/recommend-factors-ab/` | 评估集·B | B 链路回测样本 |
| `data/recommend-ai-fwd/` | 前瞻归档·A | 每日真实前瞻时**同时归档**的 A 链路 Top10（2026-10 起累积）|
| `data/recommend-factors-fwd/` | 前瞻归档·B | 同上，B 链路；哪天是哪条由文件内 `regime.tilt` 决定 |
| `data/recommend-2025-09/` | 样本外封存 | 2025-09 OOS |
| `data/llm-rank/` | 调参 | LLM 逐股打分（`score-candidates.js`），默认 2026-07~08 |
| `data/llm-rank-regime/` | 调参 | 同上，regime 条件化 prompt，覆盖到 2026-09-30 |
| `data/info-sent/` | 调参 | LLM 资讯情绪分 |
| `data/ann-archive/`、`data/news-archive/` | 因子输入 | 公告/新闻归档（`≤D` 只读）|
| `data/kline-cache/`、`data/finance/` | 因子输入 | 日K / 点时财务缓存（非划分产物）|

## 8. 脚本 → 默认窗口 对照

| 脚本 | 默认窗口 / 划分 |
| --- | --- |
| `optimize-factors.js` | `RANGES` 2026-02~09；`TRAIN_KEYS=Jul/Aug/Sep`、`HOLD_KEYS=Mar-Jun`；`--cv` 留一月 |
| `tune-factors.js` | 训练 2026-07、验证 2026-08（早期快脚本）|
| `factor-ic.js` | 2026-02-01 ~ 2026-09-30 |
| `score-candidates.js` | 2026-07-01 ~ 2026-08-31（`--regime` 写 `llm-rank-regime`）|
| `score-info.js` | 2026-07-01 ~ 2026-08-31 |
| `eval-backtest.js` | 读 `recommend/`（可 `--dir`），`--from/--to` 任意 |
| `eval-ab-combo.js` | 读 A/B 回测目录，`--thr 0.3,0.4,0.5,0.6` |
| `backtest.js` | `--days 30` 或 `--from/--to`；输出默认 `recommend-bt/` |
| `recommend.js` | 生产每日；`basisDate=当天`，`--dual-thr 0.6` |

## 9. 红线规则

1. **测试/前瞻（2026-10+）与封存样本外（2025-09）绝不用于调参、选型、改阈值。**
2. 训练/验证窗口内的数据**不得对外展示**（隐藏窗口），也不得被当作「实盘成绩」。
3. A/B 评估用到训练月（如 2026-07/08）时，结论必须标注「样本内」。
4. `thr=0.6` 等阈值属「看过评估窗后选取」，**未来只用前瞻数据重标定**（`TODO.md:53-58`）。
5. 回测脚本输出**只能**写 `recommend-bt/` 等独立目录，**禁止**写 `data/recommend/`。
6. 改动任何窗口 → 同步改本文 + 对应代码常量。

## 10. 变更记录

- 2026-10-06：初版。固化「训练 2026-07~09 / 验证 2026-03~06 / 封存样本外 2025-09 /
  前瞻 2026-10 起」四段口径，以及线上隐藏窗口 2026-03-01~2026-09-30 的来由。
