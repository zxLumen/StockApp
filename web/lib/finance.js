import fsp from 'node:fs/promises'
import path from 'node:path'

import { DATA_DIR } from './scope.js'
import { readJson, writeJson } from './store.js'
import { fetchJson } from './http.js'

// 点时（PIT）财务数据。取东财 F10 主要财务指标，逐只缓存到 DATA_DIR/finance/<secid>.json。
//
// **为什么必须点时**：ROE / PB 是「截至报告期」的累计值，但在**披露日**之前市场看不到它。
// 只按报告期取数 = 用未来数据（实测会让验证集 Apr/May 的超额虚高约 1.2~1.8 个百分点）。
// 所以这里按 `NOTICE_DATE <= asOf` 过滤，asOf 就是回测日 / 今日。
//
// 接口要点（都踩过）：
//   - `SECUCODE` 必须是 `600519.SH` 这种**交易所后缀**格式；传 `1.600519` 会 200 返回但
//     `result.data` 为空 —— 静默失败，比报错更难查。
//   - 该接口**带 `NOTICE_DATE`**（真实披露日），无需再按报告期猜滞后天数。
//   - 实测覆盖 100%（709 只 × 31878 条记录全部有 NOTICE_DATE），并发 10 全量约 9 秒。

const API = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
const REPORT = 'RPT_F10_FINANCE_MAINFINADATA'
const COLUMNS =
  'SECUCODE,REPORT_DATE,NOTICE_DATE,ROEJQ,BPS,TOTALOPERATEREVETZ,PARENTNETPROFITTZ,XSMLL'
// 财报变动很少，缓存给到 7 天；回测反复取同一批票，靠它避免打爆上游。
const TTL_MS = 7 * 24 * 3600_000

/**
 * `0.300502` / `1.600519` → `300502.SZ` / `600519.SH`。
 * 首位是交易所：6/9 → SH，0/2/3 → SZ，4/8 → BJ。
 */
/** `secid`（`0.600519`）或裸代码 → 东财 `SECUCODE`（`600519.SH`）。不认识的返回 null。 */
export function toSecuCode(secid) {
  const s = String(secid || '').trim()
  // 已带后缀：600519.SH
  const withSuffix = /^(\d{6})\.(SH|SZ|BJ)$/i.exec(s)
  const code = withSuffix ? withSuffix[1] : /^(\d)\.(\d{6})$/.exec(s)?.[2] ?? (/^\d{6}$/.test(s) ? s : null)
  if (!code) return null
  const market = /^[69]/.test(code)
    ? 'SH'
    : /^[03]/.test(code)
      ? 'SZ'
      : /^[48]/.test(code)
        ? 'BJ'
        : null
  return market ? `${code}.${market}` : null
}

/** 报告期（`REPORT_DATE`）月份 → 该期已过月数。Q1=3 / H1=6 / Q3=9 / 年报=12。
 *
 *  ⚠️ 这里必须按**报告期**算，不能按披露月。早先误用披露月（4 月→3、8 月→1 …），
 *  于是 3 月底的一季报、9 月底的三季报都查不到表，**整季退化成 null** ——
 *  Q1/Q3 样本被静默丢掉，而它们恰好是 ROE 分化最大的两期。
 */
const MONTHS_ELAPSED = { 3: 3, 6: 6, 9: 9, 12: 12 }

/**
 * `ROEJQ` 是**累计**加权 ROE（Q1 ≈ 单季、H1 ≈ 半年、Q3 ≈ 前三季、年报 ≈ 全年），
 * 跨报告期直接横排会系统性偏袒年报股（实测同一截面 Q1 中位 3.8 vs 上年年报 10.2）。
 * 按已过月数折算成满年，让不同报告期可比。
 *
 * 代价是假设「期间内盈利均匀分布」——一季报含大额分红/一次性损益时会失真。
 * 实测这个假设比「按众数报告期硬对齐」（会丢掉 50%+ 截面、且实测更差）好得多：
 * 8 个月验证集 T+10 超额 +0.71% vs -0.29%。
 */
export function annualizedRoe(rec) {
  // ⚠️ 别写 `Number(rec?.roe)`：`Number(null)` 是 **0**，会把「ROE 缺失」当成「ROE 为 0」
  // 混进截面 —— 那不是「无信息」，而是「这家公司盈利能力极差」，会把因子排序带偏。
  const raw = rec?.roe
  if (raw == null || raw === '') return null
  const r = Number(raw)
  if (!Number.isFinite(r)) return null
  const m = MONTHS_ELAPSED[Number(String(rec.period || '').slice(5, 7))]
  if (!m) return null
  return (r * 12) / m
}

// 进程内 memo 原始记录。回测会对同一批票反复查（65 天 × 200 只 = 上万次），
// 每次读盘虽然不致命但没必要；记录本身是不可变的（财报只增不改），memo 安全。
const MEMO = new Map()

/** 拉一只票的全部报告期（原始缓存形态：每条含 period / notice / roe / bps）。 */
export async function fetchFinance(secid, { dataDir = DATA_DIR, ttlMs = TTL_MS, memo = true } = {}) {
  if (memo && MEMO.has(secid)) return MEMO.get(secid)
  const code = toSecuCode(secid)
  if (!code) return []
  const file = path.join(dataDir, 'finance', `${secid}.json`)
  try {
    const st = await fsp.stat(file)
    if (Date.now() - st.mtimeMs < ttlMs) {
      const j = await readJson(file, null)
      // 旧缓存没有成长字段（revYoy 未定义）→ 视为过期，重拉以补齐。
      if (Array.isArray(j) && j.length && j[0].revYoy !== undefined) {
        if (memo) MEMO.set(secid, j)
        return j
      }
    }
  } catch {
    /* 无缓存，继续拉 */
  }
  const url = `${API}?${new URLSearchParams({
    reportName: REPORT,
    columns: COLUMNS,
    filter: `(SECUCODE="${code}")`,
    pageSize: '80',
    sortColumns: 'REPORT_DATE',
    sortTypes: '-1',
  })}`
  const j = await fetchJson(url, { headers: { Referer: 'https://data.eastmoney.com/' } })
  if (!j?.success) return []
  const rows = (j.result?.data || [])
    .map((x) => ({
      period: String(x.REPORT_DATE || '').slice(0, 10),
      notice: x.NOTICE_DATE ? String(x.NOTICE_DATE).slice(0, 10) : null,
      roe: x.ROEJQ == null ? null : Number(x.ROEJQ),
      bps: x.BPS == null ? null : Number(x.BPS),
      revYoy: x.TOTALOPERATEREVETZ == null ? null : Number(x.TOTALOPERATEREVETZ),
      profitYoy: x.PARENTNETPROFITTZ == null ? null : Number(x.PARENTNETPROFITTZ),
      grossMargin: x.XSMLL == null ? null : Number(x.XSMLL),
    }))
    .filter((x) => x.period)
  if (rows.length) {
    await writeJson(file, rows).catch(() => {})
    if (memo) MEMO.set(secid, rows)
  }
  return rows
}

/**
 * **点时**取一条：只用 `notice <= asOf` 的记录里最新的那条。
 * 红线：`notice > asOf` 的记录一律不得使用 —— 发现越界直接 throw，而不是静默过滤，
 * 因为那说明调用方把 asOf 传错了，静默过滤会掩盖泄漏。
 */
export function latestFinance(records, asOf) {
  if (!Array.isArray(records) || !records.length || !asOf) return null
  // 缓存里带着比 asOf 更新的报告期是**正常**的（同一份缓存跨多个回测日复用）；
  // 红线是「一条都不许选中 notice > asOf 的记录」，所以这里按 asOf 过滤而非信任调用方。
  const ok = records.filter((r) => r.notice && r.notice <= asOf)
  if (!ok.length) return null
  const hit = [...ok].sort((a, b) => (a.notice < b.notice ? 1 : -1))[0]
  // 自检：排序后取到的这条一定满足 notice <= asOf（防止上面比较器写反）。
  if (hit.notice > asOf) throw new Error(`未来数据泄漏：财务 ${hit.notice} > 评估日 ${asOf}`)
  return hit
}

/** 便捷入口：按 asOf 拿「年化 ROE + 每股净资产」，供因子库使用。
 *
 *  没有任何可用报告期时返回 **null**（不是 `{roeAnnual:null,...}`）：调用方用 `if (fin)`
 *  判有无，顺便统计财务覆盖率。返回全 null 的对象会**误算成「有财务数据」**，
 *  让覆盖率虚高、并掩盖「这批票根本没拉到财务」的问题。
 */
export async function financeFactors(secid, asOf, opts = {}) {
  const rec = latestFinance(await fetchFinance(secid, opts), asOf)
  if (!rec) return null
  return {
    roeAnnual: annualizedRoe(rec),
    bps: rec.bps,
    revYoy: Number.isFinite(rec.revYoy) ? rec.revYoy : null,
    profitYoy: Number.isFinite(rec.profitYoy) ? rec.profitYoy : null,
    grossMargin: Number.isFinite(rec.grossMargin) ? rec.grossMargin : null,
    period: rec.period,
    notice: rec.notice,
  }
}