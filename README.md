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
| AI | 站长配置 provider / 模型 / Key，访客开关；SSE 流式解读。provider 分槽，各服务商的地址 / 模型 / Key 互不覆盖 |

默认落地页：**沪 / 深 / 港 三条日K + 沪深港主要指数快照 + 当日热点新闻**。

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

写入一律「写 .tmp → copyFile 备份 .bak → rename」，并对同一文件串行化。

## 身份与 scope

- `stock_cid`（HttpOnly）：访客身份，缺省自动下发。
- `stock_owner`：站长兜底，`/?owner=<STOCK_OWNER_TOKEN>` 换取。
- `zx_admin`：博客下发的管理员 cookie（`<exp>.<hmac>`），与主站同 `SESSION_SECRET`。
- `zx_mock`：站长开 MOCK 后，该请求**整体按普通访客处理**（无站长特权，数据落到 mock cid）。

## 环境变量

见 `web/.env.example`。`SESSION_SECRET` 与主站一致才能单点登录。

## 上游稳定性（重要）

东财 `push2` / `push2his` 会按来源 IP 直接掐连接（返回 0 字节、无状态码）。
应对：

- 每主机串行 + 最小间隔 300ms；连续失败 3 次熔断 60s；
- `push2` / `push2his` 各有 4 个镜像域名组成池，失败自动换、记住上次成功的主机；
- TTL 缓存 + **stale-on-error**（上游抖动时宁可给旧数据，也不要整页空白）；
- `/api/status` 的 `upstream` 字段能看到各主机的熔断状态。

因此单台服务器上，本应用的上游容错主要靠缓存而不是重试风暴；不要为了「刷新一下」频繁穿透缓存。