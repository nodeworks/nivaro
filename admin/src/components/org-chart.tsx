import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Maximize, Minus, Network, Plus } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

export interface OrgChartConfig {
  label_field: string
}

export interface OrgChartProps {
  collection: string
  config: OrgChartConfig
}

interface NestedNode {
  id: string | number
  children: NestedNode[]
  [key: string]: unknown
}

// ── Layout constants ─────────────────────────────────────────────────────────

const NODE_W = 176
const NODE_H = 56
const H_GAP = 20
const V_GAP = 52
const PADDING = 32

const MIN_ZOOM = 0.5
const MAX_ZOOM = 1.5
const ZOOM_STEP = 0.1

interface PlacedNode {
  node: NestedNode
  x: number // left
  y: number // top
  childCount: number
  collapsed: boolean
  hasVisibleChildren: boolean
}

interface Edge {
  from: { x: number; y: number } // parent bottom-center
  to: { x: number; y: number } // child top-center
}

/**
 * Computes a classic top-down org-chart layout: each subtree is as wide as the
 * sum of its visible children (or one node wide), parents are centered above
 * their children. Returns absolutely positioned nodes + elbow connector edges.
 */
function layoutTree(
  roots: NestedNode[],
  collapsedIds: Set<string>
): { placed: PlacedNode[]; edges: Edge[]; width: number; height: number } {
  const placed: PlacedNode[] = []
  const edges: Edge[] = []
  let maxDepth = 0

  const subtreeWidth = (node: NestedNode): number => {
    const collapsed = collapsedIds.has(String(node.id))
    if (collapsed || node.children.length === 0) return NODE_W
    const childrenWidth = node.children.reduce(
      (sum, c, i) => sum + subtreeWidth(c) + (i > 0 ? H_GAP : 0),
      0
    )
    return Math.max(NODE_W, childrenWidth)
  }

  const place = (node: NestedNode, left: number, depth: number): number => {
    maxDepth = Math.max(maxDepth, depth)
    const width = subtreeWidth(node)
    const collapsed = collapsedIds.has(String(node.id))
    const showChildren = !collapsed && node.children.length > 0
    const x = left + width / 2 - NODE_W / 2
    const y = depth * (NODE_H + V_GAP)

    placed.push({
      node,
      x,
      y,
      childCount: node.children.length,
      collapsed,
      hasVisibleChildren: showChildren
    })

    if (showChildren) {
      // When children are narrower than the node itself, center them under it
      const childrenWidth = node.children.reduce(
        (sum, c, i) => sum + subtreeWidth(c) + (i > 0 ? H_GAP : 0),
        0
      )
      let childLeft = left + (width - childrenWidth) / 2
      for (const child of node.children) {
        const cw = subtreeWidth(child)
        edges.push({
          from: { x: x + NODE_W / 2, y: y + NODE_H },
          to: { x: childLeft + cw / 2, y: (depth + 1) * (NODE_H + V_GAP) }
        })
        place(child, childLeft, depth + 1)
        childLeft += cw + H_GAP
      }
    }
    return width
  }

  let cursor = PADDING
  for (const root of roots) {
    const w = place(root, cursor, 0)
    cursor += w + H_GAP * 2
  }

  const width = Math.max(cursor - H_GAP * 2 + PADDING, NODE_W + PADDING * 2)
  const height = (maxDepth + 1) * (NODE_H + V_GAP) - V_GAP + PADDING * 2

  // Shift everything down by the top padding
  for (const p of placed) p.y += PADDING
  for (const e of edges) {
    e.from.y += PADDING
    e.to.y += PADDING
  }

  return { placed, edges, width, height }
}

/** Elbow connector: down from parent, across, down into child. */
function edgePath(e: Edge): string {
  const midY = e.from.y + (e.to.y - e.from.y) / 2
  if (e.from.x === e.to.x) {
    return `M ${e.from.x} ${e.from.y} L ${e.to.x} ${e.to.y}`
  }
  return `M ${e.from.x} ${e.from.y} L ${e.from.x} ${midY} L ${e.to.x} ${midY} L ${e.to.x} ${e.to.y}`
}

export function OrgChart({ collection, config }: OrgChartProps) {
  const navigate = useNavigate()
  const viewportRef = useRef<HTMLDivElement>(null)
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())
  const [zoom, setZoom] = useState(1)

  const { data: roots, isLoading } = useQuery({
    queryKey: ['tree-nested', collection],
    queryFn: () =>
      api.get<{ data: NestedNode[] }>(`/tree/${collection}/nested`).then((r) => r.data.data),
    enabled: !!collection,
    staleTime: 10_000
  })

  const { placed, edges, width, height } = useMemo(
    () => layoutTree(roots ?? [], collapsedIds),
    [roots, collapsedIds]
  )

  const toggleCollapse = useCallback((id: string | number) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev)
      const key = String(id)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

  const handleFit = () => {
    const viewport = viewportRef.current
    if (!viewport || width === 0) return
    const scale = clampZoom(
      Math.min((viewport.clientWidth - 16) / width, (viewport.clientHeight - 16) / height)
    )
    setZoom(scale)
  }

  if (isLoading) {
    return (
      <div className='flex-1 p-8 space-y-4'>
        <div className='flex justify-center'>
          <Skeleton className='h-14 w-44 rounded-lg' />
        </div>
        <div className='flex justify-center gap-6'>
          <Skeleton className='h-14 w-44 rounded-lg' />
          <Skeleton className='h-14 w-44 rounded-lg' />
          <Skeleton className='h-14 w-44 rounded-lg' />
        </div>
      </div>
    )
  }

  if (!roots || roots.length === 0) {
    return (
      <div className='flex flex-1 flex-col items-center justify-center py-16 text-center'>
        <Network className='mb-2 h-7 w-7 text-slate-300 dark:text-slate-600' />
        <p className='text-[13px] text-slate-400 dark:text-muted-foreground'>
          No items to display in the chart
        </p>
      </div>
    )
  }

  return (
    <div className='relative flex flex-1 min-h-0 flex-col'>
      {/* Zoom controls */}
      <div className='absolute right-3 top-3 z-10 flex items-center gap-px overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm dark:border-border dark:bg-card'>
        <button
          type='button'
          title='Zoom out'
          aria-label='Zoom out'
          disabled={zoom <= MIN_ZOOM}
          onClick={() => setZoom((z) => clampZoom(Math.round((z - ZOOM_STEP) * 10) / 10))}
          className='flex size-7 items-center justify-center text-slate-500 hover:bg-slate-50 disabled:opacity-40 dark:text-slate-400 dark:hover:bg-accent'
        >
          <Minus className='h-3.5 w-3.5' />
        </button>
        <span className='w-11 select-none text-center text-[11px] font-medium tabular-nums text-slate-500 dark:text-slate-400'>
          {Math.round(zoom * 100)}%
        </span>
        <button
          type='button'
          title='Zoom in'
          aria-label='Zoom in'
          disabled={zoom >= MAX_ZOOM}
          onClick={() => setZoom((z) => clampZoom(Math.round((z + ZOOM_STEP) * 10) / 10))}
          className='flex size-7 items-center justify-center text-slate-500 hover:bg-slate-50 disabled:opacity-40 dark:text-slate-400 dark:hover:bg-accent'
        >
          <Plus className='h-3.5 w-3.5' />
        </button>
        <button
          type='button'
          title='Fit to view'
          aria-label='Fit to view'
          onClick={handleFit}
          className='flex h-7 items-center gap-1 border-l border-slate-200 px-2 text-[11px] font-medium text-slate-500 hover:bg-slate-50 dark:border-border dark:text-slate-400 dark:hover:bg-accent'
        >
          <Maximize className='h-3 w-3' />
          Fit
        </button>
      </div>

      {/* Chart canvas — horizontal + vertical scroll */}
      <div ref={viewportRef} className='flex-1 overflow-auto bg-slate-50/60 dark:bg-background'>
        <div
          style={{
            width: width * zoom,
            height: height * zoom
          }}
        >
          <div
            className='relative'
            style={{
              width,
              height,
              transform: `scale(${zoom})`,
              transformOrigin: 'top left'
            }}
          >
            {/* Connector lines */}
            <svg
              width={width}
              height={height}
              className='absolute inset-0'
              aria-hidden='true'
              role='presentation'
            >
              {edges.map((e) => (
                <path
                  key={`${e.from.x}-${e.from.y}-${e.to.x}-${e.to.y}`}
                  d={edgePath(e)}
                  fill='none'
                  className='stroke-slate-300 dark:stroke-slate-600'
                  strokeWidth={1.5}
                />
              ))}
            </svg>

            {/* Node cards */}
            {placed.map(({ node, x, y, childCount, collapsed }) => {
              const label = String(node[config.label_field] ?? node.id)
              return (
                // biome-ignore lint/a11y/useSemanticElements: card hosts a nested collapse button, so it cannot be a <button>
                <div
                  key={String(node.id)}
                  role='button'
                  tabIndex={0}
                  onClick={() => navigate(`/collections/${collection}/${node.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      navigate(`/collections/${collection}/${node.id}`)
                    }
                  }}
                  className={cn(
                    'group absolute flex cursor-pointer flex-col justify-center rounded-lg border bg-white px-3 shadow-sm transition-colors',
                    'border-slate-200 hover:border-nvr-cyan hover:shadow dark:border-border dark:bg-card dark:hover:border-nvr-cyan'
                  )}
                  style={{ left: x, top: y, width: NODE_W, height: NODE_H }}
                >
                  <span className='truncate text-[13px] font-medium text-slate-800 dark:text-foreground'>
                    {label}
                  </span>
                  <span className='mt-0.5 flex items-center gap-1 text-[11px] text-slate-400 dark:text-muted-foreground'>
                    <span className='truncate font-mono'>#{String(node.id)}</span>
                    {childCount > 0 && (
                      <span className='ml-auto shrink-0 rounded-full bg-nvr-cyan/10 px-1.5 py-px font-medium text-nvr-navy dark:bg-nvr-cyan/15 dark:text-nvr-cyan'>
                        {childCount}
                      </span>
                    )}
                  </span>

                  {/* Collapse / expand toggle */}
                  {childCount > 0 && (
                    <button
                      type='button'
                      title={collapsed ? 'Expand' : 'Collapse'}
                      aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleCollapse(node.id)
                      }}
                      className='absolute -bottom-2.5 left-1/2 flex size-5 -translate-x-1/2 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-400 shadow-sm hover:border-nvr-cyan hover:text-nvr-cyan dark:border-border dark:bg-card'
                    >
                      {collapsed ? (
                        <ChevronRight className='h-3 w-3' />
                      ) : (
                        <ChevronDown className='h-3 w-3' />
                      )}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
