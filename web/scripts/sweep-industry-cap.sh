#!/usr/bin/env bash
# 扫 maxPerIndustry（行业分散上限）对 B 链路成绩的影响（**生产口径**：backtest + eval-backtest）。
#
#   bash scripts/sweep-industry-cap.sh ["99 4 3 2"] [from] [to]
#
# 对每个上限值：用一份改过 select.maxPerIndustry 的临时 model.json（RECOMMEND_MODEL_CONFIG 覆盖）
# 跑一次全区间回测 → 分别评估 2024 训练段与 2025 验证段。
# 产物：$OUT（默认 /tmp/opencode/cap-sweep）下 bt-<cap>.log / eval-<cap>-{train,val}.log。
# 注意：K线缓存自 2024-04-17 起，故训练段从 2024-04-17 开始；口径含幸存者偏差（见 docs/runs）。
set -euo pipefail
cd "$(dirname "$0")/.."
CAPS="${1:-99 4 3 2}"
FROM="${2:-2024-04-17}"
TO="${3:-2025-12-31}"
OUT="${OUT:-/tmp/opencode/cap-sweep}"
mkdir -p "$OUT"

for cap in $CAPS; do
  echo ">>> backtest cap=$cap"
  node -e "const fs=require('fs');const m=JSON.parse(fs.readFileSync('config/model.json','utf8'));m.select.maxPerIndustry=$cap;fs.writeFileSync('$OUT/model-$cap.json',JSON.stringify(m,null,2))"
  RECOMMEND_MODEL_CONFIG="$OUT/model-$cap.json" node scripts/backtest.js \
    --strategy factors --bare --pool stable --from "$FROM" --to "$TO" --out "bt-cap$cap" --force \
    > "$OUT/bt-$cap.log" 2>&1
  node scripts/eval-backtest.js --dir "bt-cap$cap" --from 2024-04-17 --to 2024-12-31 > "$OUT/eval-$cap-train.log" 2>&1
  node scripts/eval-backtest.js --dir "bt-cap$cap" --from 2025-01-01 --to 2025-12-31 > "$OUT/eval-$cap-val.log" 2>&1
  echo ">>> done cap=$cap"
done
echo ">>> 全部完成，产物在 $OUT"
