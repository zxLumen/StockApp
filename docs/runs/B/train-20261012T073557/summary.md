# 冻结 B / train（行业分散上限）

- version: b-2024-train-abs+cap3
- 时间: 2026-10-12T07:35:57.518Z
- 变更:

```json
{
  "select": {
    "poolPages": 5,
    "topCandidates": 100,
    "finalPicks": 10,
    "maxPerIndustry": 3
  }
}
```

## 结论

- `select.maxPerIndustry` 由 **99（关闭）→ 3**：单一大类最多 3 只（≤30%），强制 ≥4 个板块。
- 依据：生产管线口径扫 `{99,4,3,2}`（训练 2024-04-17~12、验证 2025），`4` 几乎不生效；
  `3` 验证段均值几乎不变（-0.05pp）而最差月略优、`2` 均值代价明显。**详见 [`cap-sweep.md`](cap-sweep.md)**。
- 行业来源改为本地冻结映射 `config/industry-map.json`（申万一级，`lib/industry.js`），
  不再依赖不稳定的逐只东财 f127 —— 这也是上限能长期生效的前提。
- 未使用 2026（测试集红线）。局限：幸存者偏差、训练段仅 9 个月，各档差异多在噪声内。
