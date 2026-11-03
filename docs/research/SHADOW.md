# Shadow（独立验证策略）运行手册

## 是什么

- 记录**线上 A/B/dual 的每日 top10 快照**；持有规则（fixed/trail/llm）由 `research/configs/strategies-2026-11.json` 在评估时逐票应用，不再固定 T+20。
- 写独立目录 `/data/shadow/{A,B,dual}/<生效日>.json`；**绝不写** `recommend*` / `recommend-actions.json`。
- 线上策略、cron、参数、输出完全不变；shadow 是纯旁路。候选策略清单见 [PLATFORM.md](./PLATFORM.md)。

## 运行

- 主机脚本：`/home/ubuntu/stock-shadow.sh`
- cron（交易日）：
  ```
  30 19 * * 1-5 /home/ubuntu/stock-shadow.sh >/dev/null 2>&1
  30 20 * * 1-5 /home/ubuntu/stock-shadow.sh >/dev/null 2>&1
  ```
  19:30 在线上 18:30 批处理之后；20:30 是补跑（已存在则跳过）。
- 容器：一次性 `docker run --rm`，挂 `docker_stock-data:/data`，只读挂 `web/scripts/shadow.js`；不占 web 容器内存。
- 日志：`~/zx-stock-shadow.log`
- 日期：默认取线上 `recommend/` 的最新生效日；也可 `--date YYYY-MM-DD`。
- 强制覆盖：`--force`；只打印不写：`--dry-run`。

## 为什么用 18:30 版本，不用 09:00 盘前刷新

shadow 的买入价是**生效日开盘**。18:30 的版本在开盘前已知，可交易；09:00 刷新发生在开盘前但可能改票，且 shadow 若在 09:30 后才记录，买入价已过。为保持「决策 → 次日开盘」的可交易性，shadow 固定用 18:30 版本，**不跟 09:00 刷新**。这是与线上的一处有意差异，12 月评估时需注明。

## 停用

删除上面两条 cron 即可；已写入的 shadow 文件保留，不影响线上。

## 12 月评估

跑 `web/scripts/research/eval-strategies.js`，见 [PLATFORM.md](./PLATFORM.md) 第 5 节。
