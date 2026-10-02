import { useEffect, useRef, useState } from 'react'
import { searchFunds, searchMarket } from '../api'
import type { Market, Selection } from '../types'

interface Props {
  market: Market
  onPick: (s: Selection) => void
}

type Row = { key: string; label: string; sub: string; selection: Selection }

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
        if (market === 'fund') {
          const { items } = await searchFunds(key)
          if (mine !== seq.current) return
          setRows(
            items.map((f) => ({
              key: f.code,
              label: f.name,
              sub: `${f.code}${f.type ? ` · ${f.type}` : ''}`,
              selection: {
                kind: 'fund' as const,
                secid: f.code,
                code: f.code,
                name: f.name,
                market: 'fund' as const,
              },
            })),
          )
          setHint(items.length ? '' : '没找到匹配的基金')
        } else {
          const { items } = await searchMarket(key, market)
          if (mine !== seq.current) return
          setRows(
            items.map((s) => ({
              key: s.secid,
              label: s.name,
              sub: `${s.code}${s.type ? ` · ${s.type}` : ''}`,
              selection: {
                kind: 'stock' as const,
                secid: s.secid,
                code: s.code,
                name: s.name,
                market,
              },
            })),
          )
          setHint(items.length ? '' : '没找到匹配的标的（可试试代码 / 名称 / 拼音首字母）')
        }
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
          market === 'fund' ? '搜场外基金，如 沪深300 / 000001' : '搜代码 / 名称 / 拼音，如 600519 / 茅台 / mt'
        }
        aria-label="搜索标的"
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