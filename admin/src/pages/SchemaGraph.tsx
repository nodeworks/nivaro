import { useQuery } from '@tanstack/react-query'
import { Waypoints } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { api } from '@/lib/api'
import { formatNumber } from '@/lib/utils'

/**
 * Force-directed schema explorer — the whole database as a living graph.
 * Hand-rolled physics (repulsion + spring edges + centering, rAF ticks),
 * nodes sized by row count, edges weighted by 7-day write volume from the
 * activity log. Drag nodes, wheel to zoom, drag canvas to pan, click a node
 * to open its table editor.
 */

interface TableInfo {
  name: string
  registered: boolean
  display_name: string | null
  color: string | null
}

interface RelationRow {
  many_collection: string
  one_collection: string | null
  junction_field: string | null
}

interface SimNode {
  id: string
  label: string
  x: number
  y: number
  vx: number
  vy: number
  r: number
  rows: number
  writes: number
  color: string
  fixed: boolean
}

interface SimEdge {
  a: number
  b: number
  m2m: boolean
}

const W = 1600
const H = 1100

export function SchemaGraphPage() {
  const navigate = useNavigate()
  const svgRef = useRef<SVGSVGElement>(null)

  const { data: tables } = useQuery({
    queryKey: ['dm-tables'],
    queryFn: () => api.get<{ data: TableInfo[] }>('/data-model').then((r) => r.data.data)
  })
  const { data: relations } = useQuery({
    queryKey: ['dm-relations'],
    queryFn: () =>
      api.get<{ data: RelationRow[] }>('/data-model/relations').then((r) => r.data.data)
  })
  const { data: stats } = useQuery({
    queryKey: ['dm-graph-stats'],
    queryFn: () =>
      api
        .get<{ data: { rows: Record<string, number>; writes_7d: Record<string, number> } }>(
          '/data-model/graph-stats'
        )
        .then((r) => r.data.data)
  })

  const [nodes, setNodes] = useState<SimNode[]>([])
  const [edges, setEdges] = useState<SimEdge[]>([])
  const [hover, setHover] = useState<string | null>(null)
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const dragRef = useRef<{ node: number | null; panning: boolean; sx: number; sy: number }>({
    node: null,
    panning: false,
    sx: 0,
    sy: 0
  })
  const runningRef = useRef(0)

  // Build the simulation set once inputs settle
  useEffect(() => {
    if (!tables || !relations) return
    const business = tables.filter(
      (t) => t.registered && !t.name.startsWith('nivaro_') && !t.name.startsWith('directus_')
    )
    const index = new Map(business.map((t, i) => [t.name, i]))
    const rowsOf = (n: string) => stats?.rows[n] ?? 0
    const maxRows = Math.max(1, ...business.map((t) => rowsOf(t.name)))

    const simNodes: SimNode[] = business.map((t, i) => {
      const angle = (i / business.length) * Math.PI * 2
      const rows = rowsOf(t.name)
      return {
        id: t.name,
        label: t.display_name ?? t.name,
        x: W / 2 + Math.cos(angle) * 380 + (((i * 37) % 60) - 30),
        y: H / 2 + Math.sin(angle) * 320 + (((i * 53) % 60) - 30),
        vx: 0,
        vy: 0,
        r: 8 + Math.sqrt(rows / maxRows) * 26,
        rows,
        writes: stats?.writes_7d[t.name] ?? 0,
        color: t.color ?? '#00ceff',
        fixed: false
      }
    })

    const seen = new Set<string>()
    const simEdges: SimEdge[] = []
    for (const rel of relations) {
      const a = index.get(rel.many_collection)
      const b = rel.one_collection ? index.get(rel.one_collection) : undefined
      if (a === undefined || b === undefined || a === b) continue
      const key = a < b ? `${a}-${b}` : `${b}-${a}`
      if (seen.has(key)) continue
      seen.add(key)
      simEdges.push({ a, b, m2m: rel.junction_field != null })
    }
    setNodes(simNodes)
    setEdges(simEdges)
    runningRef.current = 300 // settle ticks
  }, [tables, relations, stats])

  // Physics loop
  useEffect(() => {
    if (nodes.length === 0) return
    let raf: number
    const tick = () => {
      if (runningRef.current > 0) {
        runningRef.current--
        setNodes((prev) => {
          const next = prev.map((n) => ({ ...n }))
          // Repulsion (O(n²) — fine for a few hundred tables)
          for (let i = 0; i < next.length; i++) {
            for (let j = i + 1; j < next.length; j++) {
              const dx = next[j].x - next[i].x
              const dy = next[j].y - next[i].y
              const d2 = Math.max(400, dx * dx + dy * dy)
              const f = 9000 / d2
              const d = Math.sqrt(d2)
              const fx = (dx / d) * f
              const fy = (dy / d) * f
              next[i].vx -= fx
              next[i].vy -= fy
              next[j].vx += fx
              next[j].vy += fy
            }
          }
          // Springs
          for (const e of edges) {
            const na = next[e.a]
            const nb = next[e.b]
            const dx = nb.x - na.x
            const dy = nb.y - na.y
            const d = Math.max(1, Math.sqrt(dx * dx + dy * dy))
            const target = na.r + nb.r + 90
            const f = (d - target) * 0.004
            na.vx += (dx / d) * f * 2
            na.vy += (dy / d) * f * 2
            nb.vx -= (dx / d) * f * 2
            nb.vy -= (dy / d) * f * 2
          }
          // Centering + integrate
          for (const n of next) {
            n.vx += (W / 2 - n.x) * 0.0006
            n.vy += (H / 2 - n.y) * 0.0006
            if (!n.fixed) {
              n.vx *= 0.85
              n.vy *= 0.85
              n.x += n.vx
              n.y += n.vy
            }
          }
          return next
        })
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [nodes.length, edges])

  const nodeIndex = useMemo(() => new Map(nodes.map((n, i) => [n.id, i])), [nodes])
  const hoverEdges = useMemo(() => {
    if (!hover) return null
    const hi = nodeIndex.get(hover)
    return new Set(edges.filter((e) => e.a === hi || e.b === hi).flatMap((e) => [e.a, e.b]))
  }, [hover, edges, nodeIndex])

  const maxWrites = Math.max(1, ...nodes.map((n) => n.writes))

  function svgPoint(e: React.PointerEvent): [number, number] {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return [0, 0]
    const px = ((e.clientX - rect.left) / rect.width) * W
    const py = ((e.clientY - rect.top) / rect.height) * H
    return [(px - view.x) / view.k, (py - view.y) / view.k]
  }

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-8 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-3'>
          <Waypoints className='h-4 w-4 text-nvr-cyan' />
          <div>
            <h1 className='text-[16px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
              Schema Graph
            </h1>
            <p className='text-[12px] text-muted-foreground'>
              Collections sized by row count, edges from relations. Drag nodes, wheel to zoom, click
              to open.
            </p>
          </div>
        </div>
      </header>

      <div className='relative flex-1 overflow-hidden bg-slate-50 dark:bg-background'>
        {/* biome-ignore lint/a11y/noSvgWithoutTitle: interactive canvas titled by header */}
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className='h-full w-full touch-none select-none'
          onWheel={(e) => {
            const factor = e.deltaY < 0 ? 1.1 : 0.9
            setView((v) => ({ ...v, k: Math.min(4, Math.max(0.3, v.k * factor)) }))
          }}
          onPointerDown={(e) => {
            dragRef.current = { node: null, panning: true, sx: e.clientX, sy: e.clientY }
          }}
          onPointerMove={(e) => {
            const d = dragRef.current
            if (d.node !== null) {
              const [x, y] = svgPoint(e)
              setNodes((prev) =>
                prev.map((n, i) => (i === d.node ? { ...n, x, y, vx: 0, vy: 0 } : n))
              )
              runningRef.current = Math.max(runningRef.current, 60)
            } else if (d.panning) {
              const rect = svgRef.current?.getBoundingClientRect()
              const scale = rect ? W / rect.width : 1
              setView((v) => ({
                ...v,
                x: v.x + (e.clientX - d.sx) * scale,
                y: v.y + (e.clientY - d.sy) * scale
              }))
              dragRef.current = { ...d, sx: e.clientX, sy: e.clientY }
            }
          }}
          onPointerUp={() => {
            if (dragRef.current.node !== null) {
              const i = dragRef.current.node
              setNodes((prev) => prev.map((n, j) => (j === i ? { ...n, fixed: false } : n)))
            }
            dragRef.current = { node: null, panning: false, sx: 0, sy: 0 }
          }}
        >
          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {edges.map((e, i) => {
              const a = nodes[e.a]
              const b = nodes[e.b]
              if (!a || !b) return null
              const active = !hoverEdges || (hoverEdges.has(e.a) && hoverEdges.has(e.b))
              const heat = Math.max(a.writes, b.writes) / maxWrites
              return (
                <line
                  key={`e-${a.id}-${b.id}-${i}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={e.m2m ? '#f59e0b' : '#00ceff'}
                  strokeWidth={0.75 + heat * 3}
                  strokeOpacity={active ? 0.25 + heat * 0.5 : 0.05}
                  strokeDasharray={e.m2m ? '4 3' : undefined}
                />
              )
            })}
            {nodes.map((n, i) => {
              const dimmed = hoverEdges && !hoverEdges.has(i) && hover !== n.id
              return (
                // biome-ignore lint/a11y/useKeyWithClickEvents: canvas-style diagram
                <g
                  key={n.id}
                  transform={`translate(${n.x},${n.y})`}
                  className='cursor-pointer'
                  opacity={dimmed ? 0.2 : 1}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    setNodes((prev) => prev.map((x, j) => (j === i ? { ...x, fixed: true } : x)))
                    dragRef.current = { node: i, panning: false, sx: e.clientX, sy: e.clientY }
                  }}
                  onPointerEnter={() => setHover(n.id)}
                  onPointerLeave={() => setHover(null)}
                  onClick={(e) => {
                    // suppress click after a real drag
                    if (Math.abs(e.clientX - dragRef.current.sx) < 4) {
                      navigate(`/data-model/${n.id}`)
                    }
                  }}
                >
                  <circle
                    r={n.r}
                    fill={n.color}
                    fillOpacity={0.18}
                    stroke={n.color}
                    strokeWidth={n.writes > 0 ? 2 : 1}
                  />
                  <text
                    y={-n.r - 5}
                    textAnchor='middle'
                    className='fill-slate-700 text-[11px] font-medium dark:fill-slate-300'
                  >
                    {n.label}
                  </text>
                  <text y={4} textAnchor='middle' className='fill-slate-500 text-[9px]'>
                    {formatNumber(n.rows)}
                  </text>
                </g>
              )
            })}
          </g>
        </svg>

        {hover && (
          <div className='pointer-events-none absolute bottom-4 left-4 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12px] shadow-sm dark:border-border dark:bg-card'>
            <p className='font-medium text-slate-800 dark:text-foreground'>{hover}</p>
            <p className='text-slate-400'>
              {formatNumber(nodes.find((n) => n.id === hover)?.rows ?? 0)} rows ·{' '}
              {formatNumber(nodes.find((n) => n.id === hover)?.writes ?? 0)} writes this week
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
