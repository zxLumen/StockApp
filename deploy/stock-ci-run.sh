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

IMAGE_TAG="${SSH_ORIGINAL_COMMAND:-latest}"
STOCK_IMAGE="ghcr.io/zxlumen/stock-web:${IMAGE_TAG}"
cd "$(dirname "$0")" || exit 1

echo "==> StockApp 部署 IMAGE_TAG=${IMAGE_TAG}"
SUDO=""
[[ "${EUID}" -eq 0 ]] || SUDO="sudo -n"

# 镜像还没构建好（CI 仍在 build）→ 明确失败，别静默跳过。
if ! ${SUDO} docker manifest inspect "${STOCK_IMAGE}" >/dev/null 2>&1; then
  echo "[stock-deploy] 镜像不存在：${STOCK_IMAGE}（CI 可能还在构建）"
  exit 1
fi

# 只拉 stock、只重建 stock —— 不碰 app / caddy / 其它子应用。
${SUDO} env STOCK_TAG="${IMAGE_TAG}" docker compose pull stock
${SUDO} env STOCK_TAG="${IMAGE_TAG}" docker compose up -d stock

${SUDO} docker compose ps stock
echo "[stock-deploy] 完成 IMAGE_TAG=${IMAGE_TAG}"