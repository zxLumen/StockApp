# StockApp · 股票速览

主站（`zxLumen-Blog`）的股票面板应用。沪深港 / 美股 / 场外基金：K 线、实时快照、
自选股、板块榜、热点新闻、AI 解读。

- 数据源：东方财富公开接口（服务端代理）+ 新浪财经滚动新闻
- 前端：React 19 + Vite 6 + lightweight-charts 5
- 服务端：Node 22 原生 `http`（无框架），自选股与 AI 配置落 JSON 文件
- 部署：GHCR 镜像 → 服务器 Docker 容器 → Caddy 反代 `stock.${DOMAIN}`

## 本地开发

```bash
cd web
npm install
npm run dev        # 前端 5173（代理 /api 到 8789）+ 后端 8789
```

或分开跑：`npm run dev:api` / `npm run dev:web`。

生产模式：

```bash
cd web
npm run build
npm start          # 只起服务端，托管 web/dist
```

校验：`npm run typecheck && npm test && npm run build`。

### 站长身份（AI 设置入口）

顶栏的 ⚙ **只对站长渲染**（`web/src/App.tsx`），AI 的 provider / 模型 / Key 也只能在
里面配。要让它出现，二选一：

```bash
# ① 跟博客共用一把 SESSION_SECRET —— 博客登录态直接被认成站长（推荐）
#    照抄 zxLumen-Blog/apps/next-home/.env.local 里的 SESSION_SECRET 那一行
cp ../../zxLumen-Blog/apps/next-home/.env.local /tmp/x   # 取值用，别提交
printf 'SESSION_SECRET=<同一值>\nSTOCK_VISITOR_AI=1\n' > web/.env

# ② 没跑博客时的兜底：token 在数据目录 owner.token（0600）
#    访问一次 /?owner=<token> 换取 stock_owner cookie，之后顶栏 ⚙ 就会出现
```

`web/.env` 不入库（`.gitignore` 已忽略），`npm run dev` / `npm start` 都用
`node --env-file-if-exists=.env` 读取，改完**重启进程**才生效。

## 功能

| 能力 | 说明 |
| --- | --- |
| 沪深港 | 上证 / 深证 / 创业板 / 恒生 / 恒生科技指数；港股个股 `116.*` |
| 美股 | 道指 / 纳指100 / 标普500；个股 `105/106/107/100.*` |
| 基金 | 场外基金搜索 + 官方净值曲线（**无盘中估值**，东财实时估值接口已下线） |
| K 线 | 日/周/月 + 5/15/30/60 分，MA5/10/20，副图成交量 |
| 搜索 | 代码 / 名称 / 拼音首字母；板块按名称检索相关个股 |
| 自选 | 服务端 JSON 持久化，按 scope（访客 cid / 站长 / MOCK 身份）隔离 |
| 板块 | 行业 + 概念涨跌幅榜，点击进成分股列表（东财 → 新浪兜底） |
| 新闻 | 全市场要闻；个股走东财搜索 API，搜不到才退回要闻关键词匹配 |
| AI | 站长配置 provider / 模型 / Key，访客开关；SSE 流式解读。provider 分槽，各服务商的地址 / 模型 / Key 互不覆盖。思考链模型自动 `reasoning_effort=none`，截断时给可操作报错而非空白 |

默认落地页：**沪 / 深 / 港 三条日K + 沪深港主要指数快照 + 当日热点新闻**。

## 每日推荐（regime 双链路）

服务器 cron 收盘后跑 `docker exec docker-stock-1 node scripts/recommend.js`，产物落
`DATA_DIR/recommend/<生效日>.json`（前端「推荐」页签读它）。

**两条链路每天都跑，按当日 tilt 择一落盘**：

| 链路 | 触发 | 候选池 | 选股 | 性格 |
| --- | --- | --- | --- | --- |
| A | `tilt >= 0.6` | 成交额池 500 只 | AI 初筛 100 + 买入评分 Top10 | 激进（强涨市弹性足） |
| B | `tilt < 0.6` | 稳健池 1451 只 | 客观多因子 Top10（AI 只解读） | 保守（跌市/震荡市更稳） |

`tilt` = 沪深300 近 20 日涨幅 + 高于 MA20 的幅度，线性映射到 `[0,1]`，只用 ≤ 基准日的日K
（`lib/factors.js` 的 `regimeTilt`；口径集中在 `lib/recommend.js` 的 `resolveTilt`）。
**逐日判断，不是按月**。产物里 `regime: { tilt, thr, chain, ranBoth }` 记录当天的判据，
事后复盘「择链对不对」全靠它。

常用开关：

```bash
node scripts/recommend.js --dry-run              # 只跑不落盘，打印 Top10
node scripts/recommend.js --dual-thr 0.5          # 调阈值（默认 0.6）
node scripts/recommend.js --single-chain          # 回退单链路（默认 B 口径）
node scripts/recommend.js --single-chain --strategy ai   # 回退旧 AI 链路
node scripts/recommend.js --out-subdir tmp-check  # 产物写别的目录（验证用）
```

择链口径与回测评估 `scripts/eval-ab-combo.js --thr 0.6` 一致；选型依据与后续优化方向见
仓库根目录 `TODO.md`。

**每日双链路归档**：写 `recommend/` 的同时，会把 A、B 两条**各归档一份**到
`recommend-ai-fwd/`、`recommend-factors-fwd/`（含当天 `tilt/thr`），用于积累真实前瞻的
A/B 对照数据 —— 判定「A 是不是背过历史行情」、日后重标阈值都靠它。线上展示仍只读
`recommend/`。攒够后用：
`node scripts/eval-ab-combo.js --a recommend-ai-fwd --b recommend-factors-fwd`。

**盘前刷新（`--refresh`）**：另一条 cron 在**交易日 09:00**（开盘前）跑
`node scripts/recommend.js --refresh`，用**最新公告（含隔夜/周末）重算当天推荐**。要点：

- **重算 A、B 两条链路（修法 1）** —— 公告事件因子只被 `selectByFactors` 消费（B），但 A 的**个股资讯
  标题**窗口会随周末/长假变旧（周末 ~2.5 天、国庆 8 天、春节 11 天）；当天选中的若恰好是 A，就会丢掉
  隔夜/假期资讯。故盘前把 A（用**最新资讯**重选）与 B 都重算，覆盖当天选中的那条；两条前瞻归档也都
  刷新，保证 A/B 对照与持仓页一致。（旧实现只刷 B、A 日保持收盘产物不动。）
- **候选池用 point-in-time**（B = `kline-cache/universe-stable.json`、A = `kline-cache/universe-amount-10.json`，
  均取 **≤ 上一交易日**的日K，`poolFromUniverse`），**不拿盘前实时快照**：开盘前新浪榜单
  `trade/amount` 全为 0，直接用它会把整池误判成「停牌」→ 两条链路一起空仓、刷新直接失败
  （2026-10-12 首次上线即踩此坑）。
- 价格基准取**上一交易日**收盘（`basisDate=prevTradingDay`），事件窗口末端延伸到运行日
  （纳入隔夜/周末公告，`lib/ann-factor.js` 的 `eventWindowDays`）。若把手动/回补挪到盘后，用
  `--event-day <YYYY-MM-DD>` 把事件窗口末端钉到更早的一天，避免当日白天公告造成未来信息泄漏。
- 后置流程走「方案甲」——**替换**当天 B 的建仓（`replaceEntryPositions`：清旧仓→按新 top 重建，
  重派生臣服标记；当天选链为 B 时同时替换 dual）+ 重跑 `reconcileCross`，**不跑 `decideActions`**
  （持仓的延长/终止交给当晚收盘那次）。生效日 E 的持仓要等 E 收盘才落库，09:00 刷新时替换基本是空操作，
  主要是手动/盘后重跑时的安全网；A 的建仓不经 `ensureEntryPositions`（A 不臣服），在 A 日替换 dual 会
  「删了旧仓却建不回」→ 反而丢仓，故 dual 只在选链为 B 时替换。
- **入场锚点**：新推荐产物带 `entryAnchor: 'effective'` → 买入价锚在**生效日开盘**（旧文件无此字段，
  仍按生成日收盘口径）。生效日当天日K还没有当日这根（新浪日K盘中不含当日），盈亏改用实时快照的
  **今开**兜底（推荐页与持仓页同理）；开盘前今开未形成才留空。前瞻归档 `recommend-*-fwd/` 也带上该字段，
  保证 A/B 归档、`recommend/`（dual）、持仓页**同口径**（回测脚本只认 `basisDate`，不受影响）。
- **刷新时间**：产物记 `generatedAt`（**首次生成**，盘前刷新不覆盖）+ `refreshedAt` / `refreshCount`
  （刷新时间与次数）。推荐页头部**始终**展示「生成 … · 最后刷新 …」（北京时间）；某条链路从未刷新过时，
  「最后刷新」即取「生成」时间（A/B/双链路统一）。

> **数据划分（训练/验证/测试/评估、隐藏窗口）见 [`docs/DATA-SPLIT.md`](docs/DATA-SPLIT.md)** ——
> 线上只展示 2026-10 起的前瞻，2026-03~09 是训练/验证样本故隐藏。改任何窗口都要同时
> 改该文档与代码常量。

## 模拟推荐持仓（历史回看）

`/api/positions` 把历史推荐当成一个模拟组合：每只 ¥10,000 等权、移动加权成本、盯市，
两套口径 —— `orig`（原始持有周期）/ `ai`（套用 `recommend-actions.json` 的提前终止 / 延长）。

- **日期选择**：与「每日推荐」同款日历（`‹ 日期 ›` + 弹出月历 + 「最新」），可选任一交易日。
- **回看口径（point-in-time）**：表格按**当日 actions 快照**（`actions-archive/<date>.json`）+ 截至该日
  生效的推荐重放；快照缺失时退回当前/最近口径并标「近似」（`actionsFaithful=false`）。
- **收益曲线**：始终是**最新口径的完整曲线**（回看不会把它缩短），只在所选回看日在原始 / AI 两条曲线上
  打点标出位置（图标题同时标注「回看点」）——曲线回答「现在整体走到哪」，表格回答「那天是什么组合」。

## 数据存储

`STOCK_DATA_DIR`（容器内 `/data`）下：

```
watchlist/<scopeKey>.json   自选股（原子写 + .bak 回退 + 每文件串行锁）
settings.json               AI 配置（每个服务商一个槽位）
keys.json                   API Key，按服务商分键（0600）
owner.token                 未配 SESSION_SECRET 时的站长兜底 token（0600）
```

AI 配置是**分槽**的：每个服务商各自一套 `model` + `baseURL`，切 provider 只换「用哪个」，
不动任何槽位内容（也就不会出现「换了服务商、地址还留着上一个的」配着新 Key 打旧地址 → 上游 401）。
只有当前槽位会被拿去发请求；`publicSettings()` 也只回 Key 掩码，绝不回明文。

### 思考链模型（deepseek-v4.x 等）会把 max_tokens 吃光

这类模型把 reasoning 和正文记在**同一份 `max_tokens`** 上，而本应用不渲染思考过程 ——
思考就纯粹是浪费预算。实测同一问题、同样 `max_tokens=2048`：基线思考 2048 token、
**正文 0 字**（面板一片空白）；`max_tokens=4096` 思考 2825、只剩约 430 给正文，
**结尾被截断**；`8192` 思考更久、直接撞上 120s 超时。所以「加大 maxTokens」不是解法。

`lib/llm.js` 对实测支持该参数的 opencode 端点（`baseURL` 含 `opencode.ai`，与
`x-opencode-session` 同一判断）自动注入 `reasoning_effort: 'none'` —— 思考压到 0、
正文 1274 字、9.5s。DeepSeek / 智谱等**未验证**，故不发这个未知字段（免得被判 400）。

万一换个思考模型仍被截断，`streamChat` 会把 `finish_reason=length` 和
`completion_tokens_details.reasoning_tokens` 翻成一句可操作的报错
（提示调大「最大输出 tokens」），而不是静默返回空白；该判断放在 `catch` 之外，
**不会**被包装成「流式响应中断」——那会让人以为是网络问题。新装默认 `maxTokens` 为 4096。

写入一律「写 .tmp → copyFile 备份 .bak → rename」，并对同一文件串行化。

## 身份与 scope

- `stock_cid`（HttpOnly）：访客身份，缺省自动下发。
- `stock_owner`：站长兜底，`/?owner=<STOCK_OWNER_TOKEN>` 换取。
- `zx_admin`：博客下发的管理员 cookie（`<exp>.<hmac>`），与主站同 `SESSION_SECRET`。
- `zx_mock`：站长开 MOCK 后，该请求**整体按普通访客处理**（无站长特权，数据落到 mock cid）。

## 环境变量

见 `web/.env.example`。`SESSION_SECRET` 与主站一致才能单点登录。

## 部署（push 即上线）

`.github/workflows/docker-publish.yml` 的 `docker` job 推镜像
（`ghcr.io/zxlumen/stock-web:<sha>` + `:latest`），成功后的 `deploy` job 用 SSH 触发
`deploy/stock-ci-run.sh`：

- 服务器 `authorized_keys` 里这把密钥 `command=` 强制绑定该脚本，只能触发部署；
  **密钥与主站那把分开**，可单独吊销。
- `SSH_ORIGINAL_COMMAND` 即镜像 tag（CI 传 git sha）。
- 脚本**只** `pull + up -d stock`，不连带重建 app / caddy / 其它子应用
  —— 用主站的 `ci-run.sh` 会因为拉不到 `zx-home:<sha>` 而整体失败。
- 每次执行先从公开仓库取回脚本自身再跑（服务器从不 `git pull`），取回失败则沿用
  服务器上现有版本。

要部署**新配置**（`settings.json` / `keys.json`）不走这条流水线，文件在服务器上单独维护。

## 上游稳定性（重要）

东财 `push2` / `push2his` 会按来源 IP 直接掐连接（返回 0 字节、无状态码）。
应对：

- 每主机串行 + 最小间隔 300ms；连续失败 3 次熔断 60s；
- `push2` / `push2his` 各有 4 个镜像域名组成池，失败自动换、记住上次成功的主机；
- TTL 缓存 + **stale-on-error**（上游抖动时宁可给旧数据，也不要整页空白）；
- `/api/status` 的 `upstream` 字段能看到各主机的熔断状态。

因此单台服务器上，本应用的上游容错主要靠缓存而不是重试风暴；不要为了「刷新一下」频繁穿透缓存。