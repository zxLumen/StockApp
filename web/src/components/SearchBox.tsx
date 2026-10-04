import { useEffect, useRef, useState } from 'react'
import { searchBoards, searchFunds, searchMarket } from '../api'
import type { BoardCategory, Market, Selection } from '../types'

interface Props {
  market: Market
  onPick: (s: Selection) => void
}

type Row = { key: string; label: string; sub: string; selection: Selection }

/** 板块分类标签（搜索结果里标出来，避免「行业」和「概念」同名时看不清）。 */
const BOARD_KIND_LABEL: Record<BoardCategory, string> = {
  industry: '行业',
  concept: '概念',
  csi: '中证',
}

export default function SearchBox({ market, onPick }: Props) {
  const [q, setQ] = useState('')
  /** 标的 = 个股 / 基金（走上游搜索）；板块 = 本地全量索引（90 行业 + 293 概念 + 10 中证）。 */
  const [tab, setTab] = useState<'target' | 'board'>('target')
  const [boardKind, setBoardKind] = useState<'' | BoardCategory>('')
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
        if (tab === 'board') {
          const { items } = await searchBoards(key, boardKind || undefined)
          if (mine !== seq.current) return
          setRows(
            items.map((b) => ({
              key: b.secid,
              label: b.name,
              sub: `${BOARD_KIND_LABEL[b.kind ?? 'industry']} · ${b.code}`,
              selection: {
                kind: 'board' as const,
                secid: b.secid,
                code: b.code,
                name: b.name,
                market: 'cn' as const,
                cid: b.cid ?? null,
              },
            })),
          )
          setHint(items.length ? '' : '没找到匹配的板块（可试试代码 / 名称，如 881121 / 半导体）')
        } else if (market === 'fund') {
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
  }, [q, market, tab, boardKind])

  return (
    <div className="search" ref={boxRef}>
      <div className="search-tabs">
        <button className={`chip${tab === 'target' ? ' on' : ''}`} onClick={() => setTab('target')}>
          标的
        </button>
        <button className={`chip${tab === 'board' ? ' on' : ''}`} onClick={() => setTab('board')}>
          板块
        </button>
        {tab === 'board' && (
          <>
            <button className={`chip${boardKind === '' ? ' on' : ''}`} onClick={() => setBoardKind('')}>
              全部
            </button>
            <button
              className={`chip${boardKind === 'industry' ? ' on' : ''}`}
              onClick={() => setBoardKind('industry')}
            >
              行业
            </button>
            <button
              className={`chip${boardKind === 'concept' ? ' on' : ''}`}
              onClick={() => setBoardKind('concept')}
            >
              概念
            </button>
            <button className={`chip${boardKind === 'csi' ? ' on' : ''}`} onClick={() => setBoardKind('csi')}>
              中证
            </button>
          </>
        )}
      </div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={
          tab === 'board'
            ? '搜板块，如 881121 / 半导体 / 支付'
            : market === 'fund'
              ? '搜场外基金，如 沪深300 / 000001'
              : '搜代码 / 名称 / 拼音，如 600519 / 茅台 / mt'
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