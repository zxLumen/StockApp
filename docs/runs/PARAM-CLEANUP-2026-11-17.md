# A 链残留硬编码收口（2026-11-17）

## 结论

A 链最后 3 处残留已收进 `web/config/model.json`，行为值保持 **100 / 30** 不变：

| 位置 | 改前 | 改后 |
| --- | --- | --- |
| `web/lib/recommend.js:915` `runRecommendRegime` | `candPool = 30` | `candPool = SEL.candPool` |
| `web/lib/recommend.js:947` A 链 | `topCandidates: 100` | `topCandidates: SEL.topCandidates` |
| `web/lib/recommend.js:1021` `runRecommendRefresh` | `candPool = 30` | `candPool = SEL.candPool` |
| `web/config/model.json` `select` | 无 `candPool` | 新增 `"candPool": 30` |

`web/lib/recommend.js:953` / `:1075` 的 `Math.max(candPool, finalPicks)` 不变。

## 关键取舍

- `select.candPool` 放在 `select` 组里，与 `topCandidates/finalPicks` 同源；未新增 loader 函数，`selectConfig()` 已能透传。
- 不改默认值：`SEL.topCandidates=100`、`SEL.candPool=30`，线上/回测产出与改前一致。
- 只改参数来源，不动 A/B 链路逻辑、不写 `data/recommend/`、不读取/修改 2026 数据。

## 验收

```text
grep -nE "topCandidates: *100|candPool *= *30" web/lib/recommend.js
→ 0 命中（exit 1）

node -e "import('./lib/model-config.js').then(m=>...)"
→ {"topCandidates":100,"candPool":30,"poolPages":5,"finalPicks":10,"maxPerIndustry":3}

cd web && npm test
→ 281 tests / 281 pass / 0 fail

npm run typecheck
→ pass
```

## 部署

待 push 后补：CI run / 镜像 digest / stock.zxlumen.cn 200。
