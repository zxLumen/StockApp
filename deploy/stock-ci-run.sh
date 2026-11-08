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
# ⚠️ compose 工程不在本仓：stock 服务定义在 zxLumen-Blog/docker/docker-compose.yml，
# 容器名 docker-stock-1。此前 `cd $(dirname $0)` 进 StockApp/deploy 后 compose 报
# "no configuration file provided"，导致 CI 的 deploy job 连续失败（11-04 / 11-05 / 11-07）。
COMPOSE_DIR="${STOCK_COMPOSE_DIR:-/home/ubuntu/zxLumen-Blog/docker}"
cd "${COMPOSE_DIR}" || exit 1

echo "==> StockApp 部署 请求 tag=${REQUESTED_TAG} → compose tag=${COMPOSE_TAG}"
SUDO=""
[[ "${EUID}" -eq 0 ]] || SUDO="sudo -n"

# 镜像还没构建好（CI 仍在 build）→ 明确失败，别静默跳过。
if ! ${SUDO} docker manifest inspect "${STOCK_IMAGE}" >/dev/null 2>&1; then
  echo "[stock-deploy] 镜像不存在：${STOCK_IMAGE}（CI 可能还在构建）"
  exit 1
fi

# ── 回滚点：在重建之前，把「当前正在运行的 stock 镜像」打上时间戳 tag ──
# 必须放在 compose up 之前，否则拿到的是刚部署的新镜像。取不到运行中的容器
# （首次部署 / 容器名变了）只打日志跳过，绝不中断部署。
ROLLBACK_KEEP="${ROLLBACK_KEEP:-3}"
STOCK_CONTAINER="${STOCK_CONTAINER:-docker-stock-1}"
# 容器不存在时 inspect 非 0，必须 `|| true`，否则 pipefail + set -e 会直接中断部署
CURRENT_IMAGE_ID="$(${SUDO} docker inspect --format '{{.State.Running}} {{.Image}}' "${STOCK_CONTAINER}" 2>/dev/null \
  | awk '$1 == "true" {print $2}' || true)"
if [ -z "${CURRENT_IMAGE_ID}" ]; then
  # 容器名兜底：按 compose 服务名找当前容器
  RUNNING_CID="$(${SUDO} docker compose ps -q stock 2>/dev/null || true)"
  if [ -n "${RUNNING_CID}" ]; then
    CURRENT_IMAGE_ID="$(${SUDO} docker inspect --format '{{.Image}}' "${RUNNING_CID}" 2>/dev/null || true)"
  fi
fi

if [ -n "${CURRENT_IMAGE_ID}" ]; then
  ROLLBACK_TAG="rollback-$(date +%Y%m%d-%H%M%S)"
  if ${SUDO} docker tag "${CURRENT_IMAGE_ID}" "${REPO_IMAGE}:${ROLLBACK_TAG}"; then
    echo "[stock-deploy] 回滚点 ${REPO_IMAGE}:${ROLLBACK_TAG} ← ${CURRENT_IMAGE_ID}"
    # 时间戳格式可按字典序倒排 = 新旧，只保留最近 ROLLBACK_KEEP 个
    OLD_ROLLBACK_TAGS="$(${SUDO} docker images --format '{{.Repository}}:{{.Tag}}' "${REPO_IMAGE}" 2>/dev/null \
      | grep -E "^${REPO_IMAGE}:rollback-[0-9]{8}(-[0-9]{6})?$" | sort -r | tail -n +$((ROLLBACK_KEEP + 1)) || true)"
    while IFS= read -r old_tag; do
      [ -n "${old_tag}" ] || continue
      ${SUDO} docker rmi "${old_tag}" >/dev/null 2>&1 || true
      echo "[stock-deploy] 清理旧回滚点 ${old_tag}"
    done <<< "${OLD_ROLLBACK_TAGS}"
  else
    echo "[stock-deploy] 打回滚 tag 失败，继续部署"
  fi
else
  echo "[stock-deploy] 未找到运行中的 ${STOCK_CONTAINER}，跳过回滚 tag"
fi

# 只拉 stock、只重建 stock —— 不碰 app / caddy / 其它子应用。
# 拉 CI 指定的构建，并同步打上 latest：保证部署的就是本次构建，
# 且 compose 里的 image 引用与主站一致（避免每次主站部署重建 stock）。
${SUDO} docker pull "${STOCK_IMAGE}"
${SUDO} docker tag "${STOCK_IMAGE}" "${REPO_IMAGE}:${COMPOSE_TAG}"
${SUDO} env STOCK_TAG="${COMPOSE_TAG}" docker compose up -d stock

${SUDO} docker compose ps stock
echo "[stock-deploy] 完成 请求 tag=${REQUESTED_TAG} → compose tag=${COMPOSE_TAG}"
