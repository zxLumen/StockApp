import { useEffect, useRef, useState } from 'react'
import { searchBoards, searchFunds, searchMarket } from '../api'
import type { BoardCategory, Market, SearchItem, Selection } from '../types'

interface Props {
  market: Market
  onPick: (s: Selection) => void
}

type Row = { key: string; label: string; sub: string; tag: string; selection: Selection }

/** 板块分类标签（搜索结果里标出来，避免「行业」和「概念」同名时看不清）。 */
const BOARD_KIND_LABEL: Record<BoardCategory, string> = {
  industry: '行业',
  concept: '概念',
  csi: '中证',
}

/**
 * 个股/指数的类型标签：优先按 `classify` 判，判不出的用交易所代码兜底。
 * 目标是让每条结果**一眼看清是哪一类**（个股 / 指数 / 港股 …），不用先选方向。
 */
function targetTag(s: SearchItem): string {
  const c = String(s.classify || '').toUpperCase()
  const t = String(s.type || '')
  // 期货要排在港交所前面判：新浪把「XX期货」也归在 HKSTOCKF 里
  if (c.includes('FUTURE') || c.includes('FUT') || t.includes('期货')) return '期货'
  if (c === 'ASTOCK') return t.includes('港') ? '港股' : '个股'
  if (c.includes('INDEX') || c === 'ZS') return '指数'
  if (c === 'HK' || c.includes('HKSTOCK')) return '港股'
  if (c.includes('FUND')) return '基金'
  // 兜底：按 secid 前缀
  const m = String(s.secid || '').split('.')[0]
  if (m === '116') return '港股'
  if (['100', '105', '106', '107', '153', '155'].includes(m)) return '美股'
  return s.type || '个股'
}

export default function SearchBox({ market, onPick }: Props) {
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const boxRef = useRef<HTMLDivElement | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  // 不再让用户先选「标的 / 板块」——输入后**同时**搜标的与板块，合并结果、各自标类型。
  useEffect(() => {
    const key = q.trim()
    if (!key) {
      setRows([])
      setHint('')
      return
    }
    const mine = ++seq.current
    setBusy(true)
    const timer = setTimeout(async () => {
      try {
        const boardP = searchBoards(key).catch(() => ({ items: [] }))
        const targetP =
          market === 'fund'
            ? searchFunds(key).then((r) => r.items.map((f) => ({ __fund: true as const, f })))
            : searchMarket(key, market).then((r) => r.items.map((s) => ({ __fund: false as const, s })))
        const [boards, targets] = await Promise.all([boardP, targetP])
        if (mine !== seq.current) return

        const out: Row[] = []
        // 板块在前（本地索引，最稳；行业/概念/中证同名时靠标签区分）
        for (const b of boards.items) {
          out.push({
            key: `board:${b.secid}`,
            label: b.name,
            sub: b.code,
            tag: BOARD_KIND_LABEL[b.kind ?? 'industry'],
            selection: {
              kind: 'board' as const,
              secid: b.secid,
              code: b.code,
              name: b.name,
              market: 'cn' as const,
              cid: b.cid ?? null,
            },
          })
        }
        for (const t of targets) {
          if (t.__fund) {
            const f = t.f
            out.push({
              key: `fund:${f.code}`,
              label: f.name,
              sub: `${f.code}${f.type ? ` · ${f.type}` : ''}`,
              tag: '基金',
              selection: {
                kind: 'fund' as const,
                secid: f.code,
                code: f.code,
                name: f.name,
                market: 'fund' as const,
              },
            })
          } else {
            const s = t.s
            out.push({
              key: `stock:${s.secid}`,
              label: s.name,
              sub: s.code,
              tag: targetTag(s),
              selection: {
                kind: 'stock' as const,
                secid: s.secid,
                code: s.code,
                name: s.name,
                market,
              },
            })
          }
        }
        setRows(out)
        setHint(out.length ? '' : '没找到匹配的标的或板块（可试试代码 / 名称 / 拼音首字母）')
        setOpen(true)
      } catch (err) {
        if (mine !== seq.current) return
        setRows([])
        setHint(err instanceof Error ? err.message : '查询失败')
      } finally {
        if (mine === seq.current) setBusy(false)
      }
    }, 260)
    return () => clearTimeout(timer)
  }, [q, market])

  return (
    <div className="search" ref={boxRef}>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={
          market === 'fund'
            ? '搜基金 / 标的 / 板块，如 沪深300 / 000001'
            : '搜代码 / 名称 / 拼音 / 板块，如 600519 / 茅台 / 半导体'
        }
        aria-label="搜索标的或板块"
      />
      {busy && <span className="search-spin" aria-hidden />}
      {open && (rows.length > 0 || hint) && (
        <div className="search-drop">
          {rows.map((r) => (
            <button
              key={r.key}
              className="search-row"
              onClick={() => {
                onPick(r.selection)
                setQ('')
                setRows([])
                setOpen(false)
              }}
            >
              <span className={`search-tag tag-${r.selection.kind}`}>{r.tag}</span>
              <span className="search-name">{r.label}</span>
              <span className="search-sub">{r.sub}</span>
            </button>
          ))}
          {hint && <div className="search-hint">{hint}</div>}
        </div>
      )}
    </div>
  )
}