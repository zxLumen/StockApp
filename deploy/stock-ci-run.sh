#!/usr/bin/env bash
# StockApp 每日面板的 CI 部署入口。
#
# 与主站（zxLumen-Blog）的 ci-run.sh 同构，但**只更新 stock 一个服务**：
# 主站的 deploy.sh 会连带 pull app / opentodo / yijing / luminari 并重建它们，
# 用主站的 SHA 去触发会拉不到 `zx-home:<sha>` 而整体失败，所以子应用必须走自己的入口。
#
# 调用方式：由服务器 authorized_keys 的 command= 强制绑定到本脚本，
# SSH_ORIGINAL_COMMAND 即本次要部署的镜像 tag（CI 传 git sha）。
#   ssh -i <deploy-key> ubuntu@<host> <git-sha>
set -euo pipefail

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
REPO_URL="${REPO_URL:-https://github.com/zxLumen/StockApp.git}"
BRANCH="${BRANCH:-main}"

# 服务器仓库从不 `git pull`，本脚本也从公开仓库匿名取回「脚本自身」再执行
# （用 STOCK_DEPLOY_FETCHED 守卫避免无限自取；写 .fetched 再 exec，避免覆盖正在
# 运行的脚本导致 bash 增量读取错乱）。
if [ -z "${STOCK_DEPLOY_FETCHED:-}" ]; then
  export STOCK_DEPLOY_FETCHED=1
  TMP="$(mktemp -d)"
  trap 'rm -rf "${TMP}"' EXIT
  if git -C "${TMP}" init -q \
    && git -C "${TMP}" remote add origin "${REPO_URL}" \
    && git -C "${TMP}" fetch -q --depth 1 origin "${BRANCH}" \
    && git -C "${TMP}" checkout -q FETCH_HEAD -- deploy/stock-ci-run.sh; then
    install -m 0755 "${TMP}/deploy/stock-ci-run.sh" "${SELF}.fetched"
    exec "${SELF}.fetched"
  fi
  echo "[stock-deploy] 取回脚本失败，沿用服务器上现有版本继续"
fi

REQUESTED_TAG="${SSH_ORIGINAL_COMMAND:-latest}"
REPO_IMAGE="ghcr.io/zxlumen/stock-web"
STOCK_IMAGE="${REPO_IMAGE}:${REQUESTED_TAG}"
# compose 统一用 latest：主站 deploy.sh 也是 STOCK_TAG=latest。两处 image 引用
# 一致后，主站全量部署不会再因为 tag 字符串不同而无谓地重建 stock。
COMPOSE_TAG="latest"
cd "$(dirname "$0")" || exit 1

echo "==> StockApp 部署 请求 tag=${REQUESTED_TAG} → compose tag=${COMPOSE_TAG}"
SUDO=""
[[ "${EUID}" -eq 0 ]] || SUDO="sudo -n"

# 镜像还没构建好（CI 仍在 build）→ 明确失败，别静默跳过。
if ! ${SUDO} docker manifest inspect "${STOCK_IMAGE}" >/dev/null 2>&1; then
  echo "[stock-deploy] 镜像不存在：${STOCK_IMAGE}（CI 可能还在构建）"
  exit 1
fi

# 只拉 stock、只重建 stock —— 不碰 app / caddy / 其它子应用。
# 拉 CI 指定的构建，并同步打上 latest：保证部署的就是本次构建，
# 且 compose 里的 image 引用与主站一致（避免每次主站部署重建 stock）。
${SUDO} docker pull "${STOCK_IMAGE}"
${SUDO} docker tag "${STOCK_IMAGE}" "${REPO_IMAGE}:${COMPOSE_TAG}"
${SUDO} env STOCK_TAG="${COMPOSE_TAG}" docker compose up -d stock

${SUDO} docker compose ps stock
echo "[stock-deploy] 完成 请求 tag=${REQUESTED_TAG} → compose tag=${COMPOSE_TAG}"
