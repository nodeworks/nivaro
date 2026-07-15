import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Key, Link2, Maximize2, Search, Share2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Entity-relationship explorer.
 *
 * A 140-table hairball is unreadable, so this is FOCUS-based: a searchable
 * table list on the left, and a canvas that shows ONE table at a time —
 * its columns (with PK / FK markers) in a centered card, surrounded by only
 * its direct neighbors, with just the edges that touch it. Click a neighbor
 * to re-center on it (with a back stack); double-click to open the editor.
 */

type Relation = {
  id: number
  many_collection: string
  many_field: string | null
  one_collection: string | null
  one_field: string | null
  junction_field: string | null
}

type Edge = {
  key: string
  from: string // the table holding the FK / the near side
  to: string
  kind: 'm2o' | 'm2m'
  label: string | null
}

interface Neighbor {
  name: string
  kind: 'm2o' | 'm2m'
  label: string | null
  direction: 'out' | 'in' // out = focused → neighbor (focused holds FK)
}

interface TableColumn {
  name: string
  data_type: string | null
  nullable: boolean
  is_primary_key: boolean
}
interface TableRelationRow {
  column_name: string
  referenced_table: string
}
interface TableDetail {
  name: string
  columns: TableColumn[]
  relations: TableRelationRow[]
}

/** Build the collapsed edge set (junction pairs → single M2M edge). */
function buildEdges(collections: Set<string>, relations: Relation[]): Edge[] {
  const consumed = new Set<number>()
  const edges: Edge[] = []
  const byJunction = new Map<string, Relation[]>()
  for (const r of relations) {
    if (r.junction_field != null && r.one_collection) {
      const list = byJunction.get(r.many_collection) ?? []
      list.push(r)
      byJunction.set(r.many_collection, list)
    }
  }
  for (const [junction, rels] of byJunction) {
    if (rels.length >= 2) {
      const [a, b] = rels
      if (a.one_collection && b.one_collection) {
        edges.push({
          key: `m2m:${junction}`,
          from: a.one_collection,
          to: b.one_collection,
          kind: 'm2m',
          label: junction
        })
        for (const r of rels) consumed.add(r.id)
      }
    }
  }
  for (const r of relations) {
    if (consumed.has(r.id) || !r.one_collection) continue
    if (r.many_collection.startsWith('directus_') || r.one_collection.startsWith('directus_'))
      continue
    edges.push({
      key: `m2o:${r.id}`,
      from: r.many_collection,
      to: r.one_collection,
      kind: 'm2o',
      label: r.many_field
    })
  }
  return edges.filter(
    (e) =>
      (collections.has(e.from) || e.from.startsWith('nivaro_')) &&
      (collections.has(e.to) || e.to.startsWith('nivaro_'))
  )
}

const NEIGHBOR_W = 150
const NEIGHBOR_H = 42
const CENTER_W = 260

export function ErdViewPage() {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [focused, setFocused] = useState<string | null>(null)
  const [stack, setStack] = useState<string[]>([])
  const canvasRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })

  const { data: collectionsData } = useQuery({
    queryKey: ['collections', 'tables_only'],
    queryFn: () =>
      api
        .get<{ data: Array<{ collection: string }> }>('/collections?tables_only=true')
        .then((r) => r.data.data)
  })
  const { data: relationsData } = useQuery({
    queryKey: ['data-model-relations'],
    queryFn: () => api.get<{ data: Relation[] }>('/data-model/relations').then((r) => r.data.data)
  })

  const { edges, degree, tables } = useMemo(() => {
    if (!collectionsData || !relationsData)
      return { edges: [] as Edge[], degree: new Map<string, number>(), tables: [] as string[] }
    const cols = new Set(
      collectionsData.map((c) => c.collection).filter((c) => !c.startsWith('directus_'))
    )
    const e = buildEdges(cols, relationsData)
    const deg = new Map<string, number>()
    for (const edge of e) {
      deg.set(edge.from, (deg.get(edge.from) ?? 0) + 1)
      deg.set(edge.to, (deg.get(edge.to) ?? 0) + 1)
    }
    const list = [...cols].sort(
      (a, b) => (deg.get(b) ?? 0) - (deg.get(a) ?? 0) || a.localeCompare(b)
    )
    return { edges: e, degree: deg, tables: list }
  }, [collectionsData, relationsData])

  // Auto-focus the most-connected table on first load
  useEffect(() => {
    if (!focused && tables.length > 0) setFocused(tables[0])
  }, [tables, focused])

  // Track canvas size for radial layout
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { data: detail } = useQuery({
    queryKey: ['erd-table', focused],
    queryFn: () =>
      api.get<{ data: TableDetail }>(`/data-model/${focused}`).then((r) => r.data.data),
    enabled: !!focused,
    staleTime: 60_000
  })

  // Neighbors of the focused table (deduped, FK-labeled)
  const neighbors = useMemo((): Neighbor[] => {
    if (!focused) return []
    const map = new Map<string, Neighbor>()
    for (const e of edges) {
      if (e.from === focused && e.to !== focused) {
        if (!map.has(e.to))
          map.set(e.to, { name: e.to, kind: e.kind, label: e.label, direction: 'out' })
      } else if (e.to === focused && e.from !== focused) {
        if (!map.has(e.from))
          map.set(e.from, { name: e.from, kind: e.kind, label: e.label, direction: 'in' })
      }
    }
    return [...map.values()].sort((a, b) => (degree.get(b.name) ?? 0) - (degree.get(a.name) ?? 0))
  }, [focused, edges, degree])

  function focus(name: string) {
    if (name === focused) return
    setStack((s) => (focused ? [...s, focused] : s))
    setFocused(name)
  }
  function back() {
    setStack((s) => {
      const next = [...s]
      const prev = next.pop()
      if (prev) setFocused(prev)
      return next
    })
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? tables.filter((t) => t.toLowerCase().includes(q)) : tables
  }, [tables, search])

  // Elliptical layout — spread neighbors across the full canvas so they clear
  // the (potentially tall) center card. Wide screens get a wider ellipse.
  const cx = size.w / 2
  const cy = size.h / 2
  const rx = Math.max(240, size.w / 2 - NEIGHBOR_W / 2 - 24)
  const ry = Math.max(180, size.h / 2 - NEIGHBOR_H - 40)
  const cardMaxH = Math.min(Math.max(260, size.h * 0.62), size.h - 80)
  const laidOut = neighbors.map((n, i) => {
    // start at top, walk around; nudge the ring so cards never sit dead-center
    const angle = (i / Math.max(1, neighbors.length)) * Math.PI * 2 - Math.PI / 2
    return { ...n, x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry }
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-8 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2.5'>
          <Link
            to='/data-model'
            className='rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted'
          >
            <ArrowLeft className='h-4 w-4' />
          </Link>
          <Share2 className='h-4 w-4 text-nvr-cyan' />
          <div>
            <h1 className='text-[16px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
              Data Model — ERD
            </h1>
            <p className='text-[12px] text-muted-foreground'>
              {tables.length} tables · {edges.length} relations · pick a table to explore its
              connections
            </p>
          </div>
        </div>
      </header>

      <div className='flex flex-1 min-h-0 overflow-hidden'>
        {/* Table list */}
        <aside className='flex w-[272px] shrink-0 flex-col border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
          <div className='shrink-0 border-b border-slate-100 p-2 dark:border-border'>
            <div className='relative'>
              <Search className='absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder='Find a table…'
                className='h-8 w-full rounded-md border border-slate-200 pl-7 pr-2 text-[12.5px] focus:outline-none focus:ring-1 focus:ring-[#00ceff] dark:border-border dark:bg-background'
              />
            </div>
          </div>
          <div className='min-h-0 flex-1 overflow-y-auto'>
            {filtered.map((t) => (
              <button
                key={t}
                type='button'
                onClick={() => focus(t)}
                className={cn(
                  'flex w-full items-center gap-2 border-b border-slate-50 px-3 py-2 text-left dark:border-border/40',
                  focused === t ? 'bg-accent' : 'hover:bg-slate-50 dark:hover:bg-muted/40'
                )}
              >
                <span className='min-w-0 flex-1'>
                  <span
                    className={cn(
                      'block truncate text-[12.5px]',
                      focused === t
                        ? 'font-semibold text-nvr-navy dark:text-nvr-cyan'
                        : 'font-medium text-slate-700 dark:text-foreground'
                    )}
                  >
                    {t}
                  </span>
                </span>
                <span className='shrink-0 rounded-full bg-slate-100 px-1.5 text-[10px] tabular-nums text-slate-400 dark:bg-muted'>
                  {degree.get(t) ?? 0}
                </span>
              </button>
            ))}
            {filtered.length === 0 && (
              <p className='p-4 text-center text-[12px] text-slate-400'>No match.</p>
            )}
          </div>
        </aside>

        {/* Focused neighborhood canvas */}
        <div
          ref={canvasRef}
          className='relative min-h-0 flex-1 overflow-hidden bg-slate-50 dark:bg-background'
        >
          {stack.length > 0 && (
            <button
              type='button'
              onClick={back}
              className='absolute left-4 top-4 z-10 flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[12px] text-slate-600 shadow-sm hover:text-nvr-navy dark:border-border dark:bg-card dark:text-slate-300'
            >
              <ArrowLeft className='h-3.5 w-3.5' /> Back
            </button>
          )}

          {!focused ? (
            <div className='flex h-full items-center justify-center text-[13px] text-slate-400'>
              Pick a table to explore its relationships.
            </div>
          ) : (
            <>
              {/* Edges: center → each neighbor */}
              <svg className='pointer-events-none absolute inset-0 h-full w-full'>
                <title>Relationships for {focused}</title>
                {laidOut.map((n) => {
                  const x2 = n.x
                  const y2 = n.y > cy ? n.y - NEIGHBOR_H / 2 : n.y + NEIGHBOR_H / 2
                  return (
                    <g key={n.name}>
                      <path
                        d={`M ${cx} ${cy} L ${x2} ${y2}`}
                        fill='none'
                        stroke={n.kind === 'm2m' ? '#f59e0b' : '#00ceff'}
                        strokeWidth={1.5}
                        strokeOpacity={0.5}
                        strokeDasharray={n.kind === 'm2m' ? '5 3' : undefined}
                      />
                      {n.label && (
                        <text
                          x={(cx + x2) / 2}
                          y={(cy + y2) / 2 - 3}
                          textAnchor='middle'
                          className='fill-slate-400 font-mono text-[9.5px]'
                        >
                          {n.label.length > 20 ? `${n.label.slice(0, 19)}…` : n.label}
                        </text>
                      )}
                    </g>
                  )
                })}
              </svg>

              {/* Neighbor cards */}
              {laidOut.map((n) => (
                <button
                  key={n.name}
                  type='button'
                  onClick={() => focus(n.name)}
                  onDoubleClick={() => navigate(`/data-model/${n.name}`)}
                  className='absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-start rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-left shadow-sm transition-colors hover:border-nvr-cyan dark:border-border dark:bg-card'
                  style={{ left: n.x, top: n.y, width: NEIGHBOR_W }}
                >
                  <span className='w-full truncate text-[12px] font-medium text-slate-700 dark:text-foreground'>
                    {n.name}
                  </span>
                  <span className='flex items-center gap-1 text-[10px] text-slate-400'>
                    {n.kind === 'm2m' ? (
                      <>
                        <Link2 className='h-2.5 w-2.5' /> many-to-many
                      </>
                    ) : n.direction === 'out' ? (
                      'references →'
                    ) : (
                      '← referenced by'
                    )}
                  </span>
                </button>
              ))}

              {/* Center card — columns with PK / FK markers */}
              <div
                className='absolute -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border-2 border-nvr-cyan bg-white shadow-lg dark:bg-card'
                style={{ left: cx, top: cy, width: CENTER_W, maxHeight: cardMaxH }}
              >
                <div className='flex items-center justify-between gap-2 border-b border-slate-200 bg-nvr-navy px-3 py-2 dark:border-border'>
                  <span className='truncate text-[13px] font-semibold text-white'>{focused}</span>
                  <button
                    type='button'
                    title='Open table editor'
                    onClick={() => navigate(`/data-model/${focused}`)}
                    className='rounded p-0.5 text-white/60 hover:bg-white/10 hover:text-white'
                  >
                    <Maximize2 className='h-3.5 w-3.5' />
                  </button>
                </div>
                <div className='overflow-y-auto' style={{ maxHeight: size.h - 130 }}>
                  {(detail?.columns ?? []).map((c) => {
                    const fk = detail?.relations?.find((r) => r.column_name === c.name)
                    return (
                      <div
                        key={c.name}
                        className={cn(
                          'flex items-center gap-1.5 border-b border-slate-50 px-3 py-1 text-[11.5px] last:border-0 dark:border-border/40',
                          fk && 'cursor-pointer hover:bg-accent/60'
                        )}
                        onClick={fk ? () => focus(fk.referenced_table) : undefined}
                      >
                        {c.is_primary_key ? (
                          <Key className='h-3 w-3 shrink-0 text-amber-500' />
                        ) : fk ? (
                          <Link2 className='h-3 w-3 shrink-0 text-nvr-cyan' />
                        ) : (
                          <span className='h-3 w-3 shrink-0' />
                        )}
                        <span
                          className={cn(
                            'truncate font-mono',
                            c.is_primary_key
                              ? 'font-semibold text-slate-800 dark:text-slate-100'
                              : 'text-slate-600 dark:text-slate-300'
                          )}
                        >
                          {c.name}
                        </span>
                        {fk ? (
                          <span className='ml-auto shrink-0 truncate text-[10px] text-nvr-cyan'>
                            → {fk.referenced_table}
                          </span>
                        ) : (
                          <span className='ml-auto shrink-0 text-[10px] text-slate-300 dark:text-slate-500'>
                            {c.data_type ?? ''}
                            {c.nullable ? '' : ' ·'}
                          </span>
                        )}
                      </div>
                    )
                  })}
                  {!detail && (
                    <p className='px-3 py-3 text-[11.5px] text-slate-400'>Loading columns…</p>
                  )}
                </div>
                {neighbors.length === 0 && detail && (
                  <div className='border-t border-slate-100 px-3 py-1.5 text-[10.5px] text-slate-400 dark:border-border'>
                    No relations to other tables.
                  </div>
                )}
              </div>

              {/* Neighbor count / hint */}
              <div className='pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-slate-200 bg-white/90 px-3 py-1 text-[11px] text-slate-400 shadow-sm dark:border-border dark:bg-card/90'>
                {neighbors.length} connected table{neighbors.length === 1 ? '' : 's'} · click a card
                or FK to explore · double-click to open
              </div>
            </>
          )}

          <div className='pointer-events-none absolute right-4 top-4 flex items-center gap-3 text-[11px] text-slate-400'>
            <span className='flex items-center gap-1.5'>
              <svg width='20' height='6' aria-hidden='true'>
                <line x1='0' y1='3' x2='20' y2='3' stroke='#00ceff' strokeWidth='1.5' />
              </svg>
              foreign key
            </span>
            <span className='flex items-center gap-1.5'>
              <svg width='20' height='6' aria-hidden='true'>
                <line
                  x1='0'
                  y1='3'
                  x2='20'
                  y2='3'
                  stroke='#f59e0b'
                  strokeWidth='1.5'
                  strokeDasharray='4 3'
                />
              </svg>
              many-to-many
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
