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

> **数据划分（训练/验证/测试/评估、隐藏窗口）见 [`docs/DATA-SPLIT.md`](docs/DATA-SPLIT.md)** ——
> 线上只展示 2026-10 起的前瞻，2026-03~09 是训练/验证样本故隐藏。改任何窗口都要同时
> 改该文档与代码常量。

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