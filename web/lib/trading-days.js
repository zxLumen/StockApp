// A 股交易日历：下一交易日 / 是否交易日，跳**周末 + 沪深交易所法定节假日**。
// 周末用 UTC 的星期分量判定（避免本地时区把日期挪一天）；节假日维护为闭区间表。
//
// 来源：上交所《关于XXXX年部分节假日休市安排的通知》
//   2024 上证公告〔2023〕47号 https://www.sse.com.cn/disclosure/announcement/general/c/c_20231226_5733939.shtml
//   2025 上证公告〔2024〕38号 https://www.sse.com.cn/disclosure/announcement/general/c/c_20241223_10767108.shtml
//   2026 上证公告〔2025〕45号 https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml
// 区间为闭区间（含两端，周末本就会被 isWeekday 拦，写全只为可读）。新的一年安排公布后追加即可。

const HOLIDAY_INTERVALS = [
  // 2024
  ['2023-12-30', '2024-01-01'], // 元旦
  ['2024-02-09', '2024-02-17'], // 春节
  ['2024-04-04', '2024-04-06'], // 清明
  ['2024-05-01', '2024-05-05'], // 劳动节
  ['2024-06-10', '2024-06-10'], // 端午
  ['2024-09-15', '2024-09-17'], // 中秋
  ['2024-10-01', '2024-10-07'], // 国庆
  // 2025
  ['2025-01-01', '2025-01-01'], // 元旦
  ['2025-01-28', '2025-02-04'], // 春节
  ['2025-04-04', '2025-04-06'], // 清明
  ['2025-05-01', '2025-05-05'], // 劳动节
  ['2025-05-31', '2025-06-02'], // 端午
  ['2025-10-01', '2025-10-08'], // 国庆 + 中秋（连休）
  // 2026
  ['2026-01-01', '2026-01-03'], // 元旦
  ['2026-02-15', '2026-02-23'], // 春节
  ['2026-04-04', '2026-04-06'], // 清明
  ['2026-05-01', '2026-05-05'], // 劳动节
  ['2026-06-19', '2026-06-21'], // 端午
  ['2026-09-25', '2026-09-27'], // 中秋
  ['2026-10-01', '2026-10-07'], // 国庆
]

const pad = (n) => String(n).padStart(2, '0')

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + n))
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}

/** 周一 ~ 周五（UTC 星期分量）。 */
export function isWeekday(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return wd >= 1 && wd <= 5
}

/** 是否落在法定休市区间内。 */
export function isHoliday(iso) {
  return HOLIDAY_INTERVALS.some(([s, e]) => iso >= s && iso <= e)
}

/** 是否交易日（非周末且非节假日）。 */
export function isTradingDay(iso) {
  return isWeekday(iso) && !isHoliday(iso)
}

/**
 * 下一交易日：从 iso 后一天起，跳过周末与法定节假日。
 * 推荐脚本在「生成日」收盘后跑，文件名用**推荐生效日**（下一交易日），
 * 这样标题里的日期 = 用户实际参考 / 买入的交易日，而不是分析发生的那天。
 */
export function nextTradingDay(iso) {
  let d = iso
  for (let i = 0; i < 90; i += 1) {
    d = addDays(d, 1)
    if (isTradingDay(d)) return d
  }
  throw new Error(`nextTradingDay: 找不到下一个交易日（输入 ${iso}）`)
}