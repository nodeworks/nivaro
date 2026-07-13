import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Minus, Plus, Share2 } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Entity-relationship diagram over nivaro_collections + nivaro_relations.
 *
 * Pure SVG — no graph library. Mutual junction pairs collapse into a single
 * M2M edge (labeled with the junction table, node hidden); remaining
 * relations render as M2O/O2M edges toward the "one" side. Layout is a
 * BFS-ordered grid so connected tables land near each other.
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
  from: string
  to: string
  kind: 'm2o' | 'm2m'
  label: string | null
}

const CELL_W = 230
const CELL_H = 96
const NODE_W = 190
const NODE_H = 44

function buildGraph(collections: string[], relations: Relation[]) {
  const registered = new Set(collections)

  // Collapse mutual junction pairs into M2M edges
  const consumed = new Set<number>()
  const edges: Edge[] = []
  const hiddenJunctions = new Set<string>()

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
        hiddenJunctions.add(junction)
      }
    }
  }
  for (const r of relations) {
    if (consumed.has(r.id) || !r.one_collection) continue
    edges.push({
      key: `m2o:${r.id}`,
      from: r.many_collection,
      to: r.one_collection,
      kind: 'm2o',
      label: r.many_field
    })
  }

  // Node set: registered collections participating or standalone, minus
  // collapsed junctions and system tables (nivaro_files stays if referenced)
  const inEdges = new Set(edges.flatMap((e) => [e.from, e.to]))
  const nodes = [...registered]
    .filter((c) => !hiddenJunctions.has(c))
    .filter((c) => !c.startsWith('directus_'))
    .filter((c) => (c.startsWith('nivaro_') ? inEdges.has(c) : true))

  const visible = new Set(nodes)
  const visibleEdges = edges.filter((e) => visible.has(e.from) && visible.has(e.to))

  // Degree + BFS grid placement: connected clusters end up adjacent
  const degree = new Map<string, number>()
  const adj = new Map<string, Set<string>>()
  for (const e of visibleEdges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1)
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1)
    if (!adj.has(e.from)) adj.set(e.from, new Set())
    if (!adj.has(e.to)) adj.set(e.to, new Set())
    adj.get(e.from)?.add(e.to)
    adj.get(e.to)?.add(e.from)
  }
  const order: string[] = []
  const seen = new Set<string>()
  const sorted = [...nodes].sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0))
  for (const start of sorted) {
    if (seen.has(start)) continue
    const queue = [start]
    seen.add(start)
    while (queue.length) {
      const cur = queue.shift() as string
      order.push(cur)
      const neighbors = [...(adj.get(cur) ?? [])].sort(
        (a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0)
      )
      for (const n of neighbors) {
        if (!seen.has(n) && visible.has(n)) {
          seen.add(n)
          queue.push(n)
        }
      }
    }
  }

  const cols = Math.max(3, Math.ceil(Math.sqrt(order.length) * 1.25))
  const pos = new Map<string, { x: number; y: number }>()
  order.forEach((name, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    // Stagger odd rows half a cell so long edges dodge node centers
    const xOff = row % 2 === 1 ? CELL_W / 2 : 0
    pos.set(name, { x: col * CELL_W + xOff + 20, y: row * CELL_H + 20 })
  })

  return { nodes: order, edges: visibleEdges, pos, degree, cols }
}

export function ErdViewPage() {
  const navigate = useNavigate()
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 0.85 })
  const [hover, setHover] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)

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

  const graph = useMemo(() => {
    if (!collectionsData || !relationsData) return null
    return buildGraph(
      collectionsData.map((c) => c.collection),
      relationsData
    )
  }, [collectionsData, relationsData])

  const highlightSet = useMemo(() => {
    if (!graph) return new Set<string>()
    const set = new Set<string>()
    if (hover) {
      set.add(hover)
      for (const e of graph.edges) {
        if (e.from === hover) set.add(e.to)
        if (e.to === hover) set.add(e.from)
      }
    }
    return set
  }, [graph, hover])

  const searchLower = search.trim().toLowerCase()

  function onWheel(e: React.WheelEvent) {
    e.preventDefault()
    const dir = e.deltaY > 0 ? 0.9 : 1.1
    setTransform((t) => ({ ...t, k: Math.min(2.5, Math.max(0.2, t.k * dir)) }))
  }
  function onMouseDown(e: React.MouseEvent) {
    dragRef.current = { x: e.clientX, y: e.clientY, tx: transform.x, ty: transform.y }
  }
  function onMouseMove(e: React.MouseEvent) {
    if (!dragRef.current) return
    const d = dragRef.current
    setTransform((t) => ({ ...t, x: d.tx + (e.clientX - d.x), y: d.ty + (e.clientY - d.y) }))
  }
  function onMouseUp() {
    dragRef.current = null
  }

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-8 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between gap-3'>
          <div className='flex items-center gap-2.5'>
            <Link
              to='/data-model'
              className='rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted'
            >
              <ArrowLeft className='h-4 w-4' />
            </Link>
            <Share2 className='h-4 w-4 text-nvr-cyan' />
            <h1 className='text-[16px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
              Data Model — ERD
            </h1>
            {graph && (
              <span className='text-[12px] text-muted-foreground'>
                {graph.nodes.length} tables · {graph.edges.length} relations
              </span>
            )}
          </div>
          <div className='flex items-center gap-2'>
            <input
              type='text'
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder='Find table…'
              className='h-8 w-48 rounded-md border border-slate-200 px-2 text-[12px] focus:outline-none focus:ring-1 focus:ring-[#00ceff] dark:border-border dark:bg-background'
            />
            <div className='flex items-center rounded-lg border border-slate-200 p-0.5 dark:border-border'>
              <button
                type='button'
                onClick={() => setTransform((t) => ({ ...t, k: Math.max(0.2, t.k * 0.85) }))}
                className='flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-muted'
                aria-label='Zoom out'
              >
                <Minus className='h-3.5 w-3.5' />
              </button>
              <button
                type='button'
                onClick={() => setTransform((t) => ({ ...t, k: Math.min(2.5, t.k * 1.18) }))}
                className='flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-muted'
                aria-label='Zoom in'
              >
                <Plus className='h-3.5 w-3.5' />
              </button>
            </div>
          </div>
        </div>
      </header>

      <div
        className='relative flex-1 min-h-0 cursor-grab overflow-hidden bg-slate-50 active:cursor-grabbing dark:bg-background'
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
      >
        {!graph ? (
          <div className='flex h-full items-center justify-center text-[13px] text-slate-400'>
            Loading data model…
          </div>
        ) : (
          <svg className='h-full w-full select-none'>
            <title>Entity relationship diagram</title>
            <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
              {/* Edges under nodes */}
              {graph.edges.map((e) => {
                const a = graph.pos.get(e.from)
                const b = graph.pos.get(e.to)
                if (!a || !b) return null
                const x1 = a.x + NODE_W / 2
                const y1 = a.y + NODE_H / 2
                const x2 = b.x + NODE_W / 2
                const y2 = b.y + NODE_H / 2
                const mx = (x1 + x2) / 2
                const my = (y1 + y2) / 2 - Math.min(60, Math.abs(x2 - x1) * 0.15)
                const active = hover != null && (e.from === hover || e.to === hover)
                const dimmed = hover != null && !active
                return (
                  <g key={e.key} opacity={dimmed ? 0.12 : 1}>
                    <path
                      d={`M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}`}
                      fill='none'
                      stroke={active ? '#00ceff' : e.kind === 'm2m' ? '#94a3b8' : '#cbd5e1'}
                      strokeWidth={active ? 2 : 1.25}
                      strokeDasharray={e.kind === 'm2m' ? '5 3' : undefined}
                    />
                    {active && e.label && (
                      <text
                        x={mx}
                        y={my + 4}
                        textAnchor='middle'
                        className='fill-slate-500 text-[10px] font-mono'
                      >
                        {e.label}
                      </text>
                    )}
                  </g>
                )
              })}
              {/* Nodes */}
              {graph.nodes.map((name) => {
                const p = graph.pos.get(name)
                if (!p) return null
                const isHover = hover === name
                const isNeighbor = highlightSet.has(name)
                const dimmed = hover != null && !isNeighbor
                const searchHit = searchLower.length > 0 && name.toLowerCase().includes(searchLower)
                const deg = graph.degree.get(name) ?? 0
                return (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: canvas-style diagram
                  <g
                    key={name}
                    transform={`translate(${p.x},${p.y})`}
                    opacity={dimmed ? 0.25 : 1}
                    onMouseEnter={() => setHover(name)}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => navigate(`/data-model/${name}`)}
                    className='cursor-pointer'
                  >
                    <rect
                      width={NODE_W}
                      height={NODE_H}
                      rx={8}
                      className={cn(
                        'stroke-1 transition-colors',
                        searchHit
                          ? 'fill-[#00ceff1a] stroke-[#00ceff]'
                          : isHover
                            ? 'fill-white stroke-[#00ceff] dark:fill-slate-800'
                            : 'fill-white stroke-slate-200 dark:fill-slate-900 dark:stroke-slate-700'
                      )}
                    />
                    <text
                      x={12}
                      y={NODE_H / 2 - 2}
                      className='fill-slate-800 text-[12px] font-medium dark:fill-slate-200'
                    >
                      {name.length > 24 ? `${name.slice(0, 23)}…` : name}
                    </text>
                    <text x={12} y={NODE_H / 2 + 13} className='fill-slate-400 text-[10px]'>
                      {deg} relation{deg !== 1 ? 's' : ''}
                    </text>
                  </g>
                )
              })}
            </g>
          </svg>
        )}
        <div className='pointer-events-none absolute bottom-3 left-4 flex items-center gap-4 text-[11px] text-slate-400'>
          <span className='flex items-center gap-1.5'>
            <svg width='24' height='6' aria-hidden='true'>
              <line x1='0' y1='3' x2='24' y2='3' stroke='#cbd5e1' strokeWidth='1.5' />
            </svg>
            M2O / O2M
          </span>
          <span className='flex items-center gap-1.5'>
            <svg width='24' height='6' aria-hidden='true'>
              <line
                x1='0'
                y1='3'
                x2='24'
                y2='3'
                stroke='#94a3b8'
                strokeWidth='1.5'
                strokeDasharray='5 3'
              />
            </svg>
            M2M (junction collapsed)
          </span>
          <span>Scroll to zoom · drag to pan · click a table to open it</span>
        </div>
      </div>
    </div>
  )
}
