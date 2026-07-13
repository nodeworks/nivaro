import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Waypoints } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Record graph explorer — radial neighborhood of one record. Click a node to
 * recenter on it (breadcrumb back-stack), double-click to open the record.
 * Pure SVG; one API hop per center.
 */

interface GraphNode {
  collection: string
  id: string
  label: string
}

interface GraphEdge {
  kind: 'm2o' | 'o2m' | 'm2m'
  via: string
  node: GraphNode
}

const KIND_COLOR: Record<GraphEdge['kind'], string> = {
  m2o: '#8b5cf6',
  o2m: '#00ceff',
  m2m: '#f59e0b'
}

const W = 780
const H = 560
const CX = W / 2
const CY = H / 2
const R = 210

export function RecordGraphSheet({
  collection,
  item,
  open,
  onOpenChange
}: {
  collection: string
  item: string
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const navigate = useNavigate()
  const [center, setCenter] = useState<{ collection: string; id: string }>({
    collection,
    id: item
  })
  const [stack, setStack] = useState<Array<{ collection: string; id: string }>>([])

  const { data, isLoading } = useQuery({
    queryKey: ['record-graph', center.collection, center.id],
    queryFn: () =>
      api
        .get<{ data: { node: GraphNode; edges: GraphEdge[]; truncated: boolean } }>(
          `/record-graph/${center.collection}/${center.id}`
        )
        .then((r) => r.data.data),
    enabled: open,
    staleTime: 30_000
  })

  function recenter(node: GraphNode) {
    setStack((prev) => [...prev, center])
    setCenter({ collection: node.collection, id: node.id })
  }
  function back() {
    setStack((prev) => {
      const next = [...prev]
      const last = next.pop()
      if (last) setCenter(last)
      return next
    })
  }
  function openWhenClosed(v: boolean) {
    if (v) {
      setCenter({ collection, id: item })
      setStack([])
    }
    onOpenChange(v)
  }

  const edges = data?.edges ?? []
  const n = edges.length

  return (
    <Sheet open={open} onOpenChange={openWhenClosed}>
      <SheetContent className='w-[860px] overflow-y-auto sm:max-w-[860px]'>
        <SheetHeader>
          <SheetTitle className='flex items-center gap-2 text-[15px]'>
            <Waypoints className='h-4 w-4 text-nvr-cyan' /> Record graph
            {stack.length > 0 && (
              <Button
                size='sm'
                variant='ghost'
                className='ml-2 h-6 px-2 text-[11px]'
                onClick={back}
              >
                <ArrowLeft className='mr-1 h-3 w-3' /> Back
              </Button>
            )}
          </SheetTitle>
        </SheetHeader>

        <div className='mt-2 flex items-center gap-4 text-[11px] text-slate-400'>
          {(['m2o', 'm2m', 'o2m'] as const).map((k) => (
            <span key={k} className='flex items-center gap-1.5'>
              <span className='h-2 w-2 rounded-full' style={{ background: KIND_COLOR[k] }} />
              {k === 'm2o' ? 'Parent' : k === 'o2m' ? 'Child' : 'Linked'}
            </span>
          ))}
          <span className='ml-auto'>click = explore · double-click = open</span>
        </div>

        {isLoading ? (
          <p className='mt-10 text-center text-[13px] text-slate-400'>Resolving relations…</p>
        ) : (
          <svg viewBox={`0 0 ${W} ${H}`} className='mt-2 w-full select-none'>
            <title>Record relation graph</title>
            {/* edges */}
            {edges.map((e, i) => {
              const angle = (i / Math.max(1, n)) * Math.PI * 2 - Math.PI / 2
              const x = CX + Math.cos(angle) * R
              const y = CY + Math.sin(angle) * R
              return (
                <line
                  key={`l-${e.kind}-${e.node.collection}-${e.node.id}-${i}`}
                  x1={CX}
                  y1={CY}
                  x2={x}
                  y2={y}
                  stroke={KIND_COLOR[e.kind]}
                  strokeOpacity={0.35}
                  strokeWidth={1.25}
                />
              )
            })}
            {/* neighbor nodes */}
            {edges.map((e, i) => {
              const angle = (i / Math.max(1, n)) * Math.PI * 2 - Math.PI / 2
              const x = CX + Math.cos(angle) * R
              const y = CY + Math.sin(angle) * R
              const rightSide = Math.cos(angle) >= 0
              return (
                // biome-ignore lint/a11y/useKeyWithClickEvents: canvas-style diagram
                <g
                  key={`n-${e.kind}-${e.node.collection}-${e.node.id}-${i}`}
                  transform={`translate(${x},${y})`}
                  className='cursor-pointer'
                  onClick={() => recenter(e.node)}
                  onDoubleClick={() => navigate(`/collections/${e.node.collection}/${e.node.id}`)}
                >
                  <circle r={7} fill={KIND_COLOR[e.kind]} className='transition-all hover:r-9' />
                  <text
                    x={rightSide ? 12 : -12}
                    y={-2}
                    textAnchor={rightSide ? 'start' : 'end'}
                    className='fill-slate-700 text-[10.5px] font-medium dark:fill-slate-300'
                  >
                    {e.node.label.length > 28 ? `${e.node.label.slice(0, 27)}…` : e.node.label}
                  </text>
                  <text
                    x={rightSide ? 12 : -12}
                    y={10}
                    textAnchor={rightSide ? 'start' : 'end'}
                    className='fill-slate-400 text-[8.5px]'
                  >
                    {e.node.collection} · {e.via}
                  </text>
                </g>
              )
            })}
            {/* center node */}
            <g
              className='cursor-pointer'
              onDoubleClick={() => navigate(`/collections/${center.collection}/${center.id}`)}
            >
              <circle cx={CX} cy={CY} r={14} fill='#172940' stroke='#00ceff' strokeWidth={3} />
              <text
                x={CX}
                y={CY + 32}
                textAnchor='middle'
                className='fill-slate-900 text-[12px] font-semibold dark:fill-slate-100'
              >
                {(data?.node.label ?? '').slice(0, 40)}
              </text>
              <text x={CX} y={CY + 46} textAnchor='middle' className='fill-slate-400 text-[9.5px]'>
                {center.collection}/{center.id}
              </text>
            </g>
            {edges.length === 0 && (
              <text x={CX} y={CY - 40} textAnchor='middle' className='fill-slate-400 text-[12px]'>
                No related records
              </text>
            )}
          </svg>
        )}
        {data?.truncated && (
          <p className={cn('text-center text-[11px] text-amber-500')}>
            Some relation lists were capped at 12 — open the record for the full sets.
          </p>
        )}
      </SheetContent>
    </Sheet>
  )
}
