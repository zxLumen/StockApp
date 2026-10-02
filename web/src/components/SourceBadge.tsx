interface Props {
  source?: string
  label?: string
}

/**
 * 数据源徽标：只有「降级到备用源」时才显示。
 * 东财按 IP 掐连接时页面还能出数，但价格可能是延迟的，得让人看得出来。
 */
export default function SourceBadge({ source, label }: Props) {
  if (!source || source === 'eastmoney') return null
  return (
    <span className="src-badge" title={`东财接口暂不可用，已降级到${label || source}数据`}>
      {label || source} · 降级
    </span>
  )
}