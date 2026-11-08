# deploy/

StockApp 的部署入口。CI 只构建 `ghcr.io/zxlumen/stock-web`，部署时 SSH 到服务器，
`authorized_keys` 的 `command=` 把该密钥强制绑定到本目录的 `stock-ci-run.sh`，
`SSH_ORIGINAL_COMMAND`（即传给 ssh 的参数）就是本次要部署的 git sha。

## 自动部署做了什么

`stock-ci-run.sh`（服务器上的副本会先从本仓 main 匿名取回最新版再执行）：

1. 校验 GHCR 上存在 `<git-sha>` 镜像，不存在直接失败（CI 可能仍在构建）；
2. **打回滚点**：读取当前运行中 `docker-stock-1` 的镜像 ID，打上
   `ghcr.io/zxlumen/stock-web:rollback-YYYYMMDD-HHMMSS`；只保留最近 3 个
   rollback tag；取不到运行中的容器时只打日志、跳过，不中断部署；
3. `docker pull <git-sha>` → `docker tag <git-sha> latest`；
4. `env STOCK_TAG=latest docker compose up -d stock`，只重建 stock 一个服务
   （compose 工程在 `zxLumen-Blog/docker`，容器名 `docker-stock-1`）。

## 回滚

先列出可用回滚点（`CREATED` 越新越靠上）：

```bash
sudo docker images | grep 'stock-web.*rollback'
```

假设要回到 `rollback-20261108-090000`：

```bash
cd /home/ubuntu/zxLumen-Blog/docker
sudo docker tag ghcr.io/zxlumen/stock-web:rollback-20261108-090000 ghcr.io/zxlumen/stock-web:latest \
  && sudo env STOCK_TAG=rollback-20261108-090000 docker compose up -d stock
```

（compose 里 image 是 `${STOCK_TAG:-latest}`，直接 `STOCK_TAG=rollback-…` 即可；
同时把 `latest` 指回该镜像，避免下一次全量部署前 tag 含义不一致。）

### 回滚后 smoke 检查

```bash
# 站点 200
curl -sS -o /dev/null -w 'http=%{http_code}\n' https://stock.zxlumen.cn/

# 容器状态 / 重启次数 / 实际镜像 ID
sudo docker inspect docker-stock-1 \
  --format '{{.State.Status}} restarts={{.RestartCount}} image={{.Image}}'
```

预期：`http=200`、`running`、`restarts=0`，且容器 image ID 与所选 rollback tag
的镜像 ID 一致（`sudo docker images --no-trunc | grep rollback-…`）。
