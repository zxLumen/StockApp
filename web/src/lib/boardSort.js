/**
 * 板块列表的**排序规则**（纯函数，无 JSX / 无 React）。
 *
 * 单独拆出来是为了能被 `node --test` 直接测 —— 排序逻辑写在 BoardHome.tsx 里就测不了，
 * 而这里恰恰是有坑的地方（见下面 null 的处理）。
 *
 * 为什么要自己排：上游给的顺序不能直接用。
 *   - 同花顺**概念**索引是完全无序的（300188、300382、300386、300337……），
 *     293 个概念全都带 changePct，不排就是一团乱麻。
 *   - 同花顺**行业**第 1 页是涨幅降序，但第 2 页被限流时那 40 个行业 changePct 为 null，
 *     上游只能把它们**追加在尾部** —— 看着像有序，其实尾部是乱的。
 */

/** 可排字段。value 对应 Board 上的字段名，pick 负责取数。 */
export const SORT_KEYS = ['changePct', 'amount', 'netInflow', 'up', 'name']

/** 中文按拼音排（Intl.Collator 比 localeCompare 稳定，且只构造一次）。 */
const NAME_COLLATOR = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

/** 取排序值：null / undefined / 非有限数一律当 null（表示「没数据」）。 */
function pick(b, key) {
  if (key === 'name') return b.name
  const v = b[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * 排序板块列表。**不修改入参**，返回新数组。
 *
 * 三条规则，都是被真实数据逼出来的：
 *
 *  1. **缺数据恒沉底**（升序降序都一样）。40 个行业没有 changePct 是因为上游限流，
 *     不是因为它们涨跌幅为 0。若按数值排，`null` 会被当成 0 塞进中间，
 *     读者会误以为那是「涨幅接近 0」的一批。
 *
 *  2. **同值按 code 兜底**。同涨跌幅的板块每次刷新顺序不能变，
 *     否则表格会在两次点击之间自己重排，看着像 bug。
 *
 *  3. **名称列忽略方向之外的数值逻辑**，直接按中文拼音。
 *
 * @param {Array<object>} list 全量板块
 * @param {string} key 排序字段，见 SORT_KEYS
 * @param {'asc'|'desc'} dir 方向
 */
export function sortBoards(list, key, dir) {
  const sign = dir === 'asc' ? 1 : -1
  return [...list].sort((a, b) => {
    const va = pick(a, key)
    const vb = pick(b, key)

    // 规则 1：两边都没数据 → 交给规则 2 的 code 兜底；只有一边没数据 → 没数据的沉底
    if (va === null && vb !== null) return 1
    if (va !== null && vb === null) return -1

    if (va !== null && vb !== null && va !== vb) {
      // 规则 3：名称是字符串，只能比字典序；sign 对名称同样生效（asc = A→Z）
      const cmp = typeof va === 'string' && typeof vb === 'string'
        ? NAME_COLLATOR.compare(va, vb)
        : va - vb
      if (cmp !== 0) return cmp * sign
    }

    // 规则 2：数值相等、或都是 null 时按 code 稳定排序（不随 sign 反转）
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0
  })
}

/**
 * 每个分类的默认排序键 —— 中证 10 个行业是静态名单，一个行情字段都没有，
 * 按涨幅排会得到「10 个 null」，毫无意义，所以默认按名称。
 */
export const DEFAULT_SORT = {
  industry: { key: 'changePct', dir: 'desc' },
  concept: { key: 'changePct', dir: 'desc' },
  csi: { key: 'name', dir: 'asc' },
}

/** 这个分类下哪些字段真的排得了（没有数据的列不给你点，省得点了发现不动）。 */
export function sortableKeys(sample) {
  const keys = new Set()
  for (const k of SORT_KEYS) {
    if (k === 'name' || (Array.isArray(sample) && sample.some((b) => pick(b, k) !== null))) keys.add(k)
  }
  return keys
}

/** 列表里有几个板块在 `key` 上缺数据 —— 用来提示「N 个已排在末尾」。 */
export function countMissing(list, key) {
  if (key === 'name') return 0
  return list.reduce((n, b) => (pick(b, key) === null ? n + 1 : n), 0)
}
