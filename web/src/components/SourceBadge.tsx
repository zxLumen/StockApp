interface Props {
  source?: string
  label?: string
  /**
   * 这个源是该市场的**首选源**吗？默认 false。
   *
   * 板块不一样：同花顺 / 中证不是「东财挂了才用的备胎」，而是目前唯一能给
   * 板块 K 线和成分股的源（东财 90.BK* 按 IP 掐连接）。标成「降级」会让人
   * 误以为数据不可靠，所以板块那边传 primary，走中性徽标。
   */
  primary?: boolean
}

/**
 * 数据源徽标。
 *
 * 默认行为：只有「降级到备用源」时才显示。东财按 IP 掐连接时页面还能出数，
 * 但价格可能是延迟的，得让人看得出来（所以 eastmoney 本身不标）。
 */
export default function SourceBadge({ source, label, primary = false }: Props) {
  if (!source || source === 'eastmoney') return null
  if (primary) {
    return (
      <span className="src-badge src-badge-primary" title={`数据源：${label || source}`}>
        {label || source}
      </span>
    )
  }
  return (
    <span className="src-badge" title={`东财接口暂不可用，已降级到${label || source}数据`}>
      {label || source} · 降级
    </span>
  )
}
