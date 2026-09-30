import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  GripVertical,
  List,
  Maximize,
  Minus,
  Network,
  Plus,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, patch } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { Skeleton } from '../ui/skeleton'

/**
 * #743 — the collection browser's Tree view (moved out of the admin classic
 * browser). Shows when the collection has a tree config (Table Editor → Tree):
 * an indented list with sibling drag-to-reorder (when an order field is set),
 * move-to-another-parent and add-child, or an org chart of the same tree.
 */

export interface TreeConfig {
  id: number
  collection: string
  parent_field: string
  label_field: string
  order_field: string | null
  maintain_path?: boolean
}

interface FlatNode {
  id: string | number
  depth: number
  label: string
  parent_id?: string | number | null
  [key: string]: unknown
}

interface NestedNode {
  id: string | number
  children: NestedNode[]
  [key: string]: unknown
}

/** The collection's tree config, or null when it has none. */
export function useTreeConfig(collection: string) {
  const client = useNivaroClient()
  return useQuery({
    queryKey: ['tree-config', collection],
    queryFn: () =>
      client
        .request<{ data: TreeConfig | null }>(get(`/tree-configs/by-collection/${collection}`))
        .then((r) => r.data ?? null)
        .catch(() => null),
    enabled: !!collection && !collection.startsWith('nivaro_'),
    staleTime: 60_000,
    retry: false
  })
}

const parentKey = (n: FlatNode) => (n.parent_id == null ? '' : String(n.parent_id))

function reflattenWithOrder(all: FlatNode[], pk: string, orderedSiblings: FlatNode[]): FlatNode[] {
  const byParent = new Map<string, FlatNode[]>()
  for (const n of all) {
    const k = parentKey(n)
    const list = byParent.get(k)
    if (list) list.push(n)
    else byParent.set(k, [n])
  }
  byParent.set(pk, orderedSiblings)
  const ids = new Set(all.map((n) => String(n.id)))
  const roots = all.filter((n) => n.parent_id == null || !ids.has(String(n.parent_id)))
  const out: FlatNode[] = []
  const visit = (node: FlatNode) => {
    out.push(node)
    for (const c of byParent.get(String(node.id)) ?? []) visit(c)
  }
  for (const r of pk === '' ? orderedSiblings : roots) visit(r)
  if (out.length !== all.length) {
    const seen = new Set(out.map((n) => String(n.id)))
    for (const n of all) if (!seen.has(String(n.id))) out.push(n)
  }
  return out
}

/** Ids of `id` and everything under it — a node can't move beneath itself. */
function subtreeIds(nodes: FlatNode[], id: string): Set<string> {
  const kids = new Map<string, string[]>()
  for (const n of nodes) {
    const k = parentKey(n)
    const list = kids.get(k)
    if (list) list.push(String(n.id))
    else kids.set(k, [String(n.id)])
  }
  const out = new Set<string>([id])
  const stack = [id]
  while (stack.length) {
    const cur = stack.pop() as string
    for (const c of kids.get(cur) ?? []) {
      if (!out.has(c)) {
        out.add(c)
        stack.push(c)
      }
    }
  }
  return out
}

const VIEW_KEY = 'nivaro_tree_view_'

export function CollectionTree({
  collection,
  config,
  onOpen,
  onAddChild
}: {
  collection: string
  config: TreeConfig
  onOpen: (id: string | number) => void
  onAddChild?: (parentId: string | number) => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [view, setView] = useState<'list' | 'org'>(() => {
    try {
      return localStorage.getItem(`${VIEW_KEY}${collection}`) === 'org' ? 'org' : 'list'
    } catch {
      return 'list'
    }
  })
  const changeView = (v: 'list' | 'org') => {
    setView(v)
    try {
      localStorage.setItem(`${VIEW_KEY}${collection}`, v)
    } catch {
      /* private mode */
    }
  }

  const {
    data: nodes = [],
    isLoading,
    error: nodesError
  } = useQuery({
    queryKey: ['tree-nodes', collection],
    queryFn: () =>
      client
        .request<{ data: FlatNode[] }>(get(`/tree/${collection}/nodes`))
        .then((r) => r.data ?? []),
    enabled: view === 'list',
    staleTime: 10_000
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['tree-nodes', collection] })
    qc.invalidateQueries({ queryKey: ['tree-nested', collection] })
  }

  // ── Move to another parent ────────────────────────────────────────────────
  const [moving, setMoving] = useState<FlatNode | null>(null)
  const [moveSearch, setMoveSearch] = useState('')
  const move = useMutation({
    mutationFn: ({ id, parentId }: { id: string | number; parentId: string | number | null }) =>
      client.request(patch(`/tree/${collection}/${id}/move`, { parent_id: parentId })),
    onSuccess: () => {
      invalidate()
      toast.success('Moved')
    },
    onError: (err) =>
      toast.error((err as { response?: { error?: string } }).response?.error ?? 'Move failed')
  })
  const moveTargets = useMemo(() => {
    if (!moving) return []
    const blocked = subtreeIds(nodes, String(moving.id))
    const q = moveSearch.trim().toLowerCase()
    return nodes
      .filter((n) => !blocked.has(String(n.id)))
      .filter(
        (n) =>
          !q ||
          String(n.label ?? '')
            .toLowerCase()
            .includes(q)
      )
      .slice(0, 200)
  }, [moving, nodes, moveSearch])

  // ── Sibling reorder ───────────────────────────────────────────────────────
  const reorderEnabled = !!config.order_field
  const [optimistic, setOptimistic] = useState<FlatNode[] | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: fresh server data supersedes the optimistic order
  useEffect(() => setOptimistic(null), [nodes])
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; pos: 'before' | 'after' } | null>(null)
  const display = optimistic ?? nodes
  const reorder = useMutation({
    mutationFn: ({
      anchorId,
      order
    }: {
      anchorId: string
      order: Array<{ id: string | number; sort: number }>
    }) => client.request(patch(`/tree/${collection}/${anchorId}/reorder`, { order })),
    onSuccess: () => {
      invalidate()
      toast.success('Order updated')
    },
    onError: (err) => {
      setOptimistic(null)
      toast.error((err as { response?: { error?: string } }).response?.error ?? 'Could not reorder')
    }
  })
  const clearDrag = () => {
    setDragId(null)
    setDropTarget(null)
  }
  const handleDrop = (targetId: string, pos: 'before' | 'after') => {
    const dragNode = display.find((n) => String(n.id) === dragId)
    const targetNode = display.find((n) => String(n.id) === targetId)
    if (!dragId || !dragNode || !targetNode || dragId === targetId) return clearDrag()
    if (parentKey(dragNode) !== parentKey(targetNode)) return clearDrag()
    const pk = parentKey(dragNode)
    const ordered = display.filter((n) => parentKey(n) === pk && String(n.id) !== dragId)
    const idx = ordered.findIndex((n) => String(n.id) === targetId)
    if (idx === -1) return clearDrag()
    ordered.splice(pos === 'before' ? idx : idx + 1, 0, dragNode)
    setOptimistic(reflattenWithOrder(display, pk, ordered))
    reorder.mutate({ anchorId: dragId, order: ordered.map((n, i) => ({ id: n.id, sort: i + 1 })) })
    clearDrag()
  }

  const toggleBtn = (v: 'list' | 'org', label: string, Icon: typeof List) => (
    <button
      type='button'
      onClick={() => changeView(v)}
      aria-pressed={view === v}
      data-cbv-tree-mode={v}
      className={cn(
        'flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium transition-colors',
        view === v
          ? 'bg-accent text-accent-foreground'
          : 'bg-white text-slate-500 hover:bg-muted dark:bg-slate-900 dark:text-slate-400'
      )}
    >
      <Icon className='h-3 w-3' />
      {label}
    </button>
  )

  return (
    <div className='flex min-h-0 flex-1 flex-col' data-cbv-tree>
      <div className='flex shrink-0 items-center justify-between gap-2 border-b border-slate-100 px-3 py-1.5 dark:border-slate-800'>
        <span className='text-[11.5px] text-slate-500 dark:text-slate-400'>
          {reorderEnabled && view === 'list'
            ? 'Drag a row within its parent to reorder.'
            : 'Grouped by parent.'}
        </span>
        <div className='flex overflow-hidden rounded-md border border-slate-200 dark:border-slate-700'>
          {toggleBtn('list', 'List', List)}
          <span className='w-px bg-slate-200 dark:bg-slate-700' />
          {toggleBtn('org', 'Org chart', Network)}
        </div>
      </div>

      {moving && (
        <div
          className='shrink-0 space-y-2 border-b border-slate-100 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-800/50'
          data-cbv-tree-move
        >
          <div className='flex items-center gap-2 text-[12px]'>
            <span className='text-slate-600 dark:text-slate-300'>
              Move <b>{moving.label}</b> under…
            </span>
            <button
              type='button'
              className='ml-auto text-slate-400 hover:text-slate-600'
              aria-label='Cancel move'
              onClick={() => setMoving(null)}
            >
              <X className='h-3.5 w-3.5' />
            </button>
          </div>
          <input
            value={moveSearch}
            onChange={(e) => setMoveSearch(e.target.value)}
            placeholder='Find a parent…'
            aria-label='Find a parent'
            className='h-7 w-full rounded border border-slate-200 bg-white px-2 text-[12px] dark:border-slate-700 dark:bg-slate-900'
          />
          <div className='max-h-48 overflow-y-auto rounded border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900'>
            <button
              type='button'
              data-cbv-tree-move-target='__root__'
              onClick={() => {
                move.mutate({ id: moving.id, parentId: null })
                setMoving(null)
              }}
              className='block w-full px-2 py-1 text-left text-[12px] italic text-slate-500 hover:bg-muted'
            >
              Top level (no parent)
            </button>
            {moveTargets.map((n) => (
              <button
                key={String(n.id)}
                type='button'
                data-cbv-tree-move-target={String(n.id)}
                onClick={() => {
                  move.mutate({ id: moving.id, parentId: n.id })
                  setMoving(null)
                }}
                style={{ paddingLeft: 8 + n.depth * 12 }}
                className='block w-full truncate py-1 pr-2 text-left text-[12px] text-slate-700 hover:bg-muted dark:text-slate-200'
              >
                {n.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {view === 'org' ? (
        <OrgChart collection={collection} labelField={config.label_field} onOpen={onOpen} />
      ) : nodesError ? (
        <TreeError error={nodesError} />
      ) : isLoading ? (
        <div className='space-y-2 p-3'>
          {[72, 52, 88].map((w) => (
            <Skeleton key={w} className='h-4 rounded' style={{ width: `${w}%` }} />
          ))}
        </div>
      ) : display.length === 0 ? (
        <p className='py-10 text-center text-[13px] text-slate-400'>No records in this tree yet.</p>
      ) : (
        <div className='min-h-0 flex-1 overflow-auto'>
          {display.map((node) => {
            const key = String(node.id)
            const dragNode = dragId ? display.find((n) => String(n.id) === dragId) : null
            const validDrop =
              !!dragNode && dragId !== key && parentKey(dragNode) === parentKey(node)
            return (
              // biome-ignore lint/a11y/useSemanticElements: the row hosts nested action buttons
              <div
                key={key}
                role='button'
                tabIndex={0}
                data-cbv-tree-node={key}
                onClick={() => onOpen(node.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onOpen(node.id)
                  }
                }}
                draggable={reorderEnabled}
                onDragStart={(e) => {
                  if (!reorderEnabled) return
                  setDragId(key)
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', key)
                }}
                onDragOver={(e) => {
                  if (!validDrop) return
                  e.preventDefault()
                  const r = e.currentTarget.getBoundingClientRect()
                  const pos = e.clientY - r.top < r.height / 2 ? 'before' : 'after'
                  setDropTarget((p) => (p?.id === key && p.pos === pos ? p : { id: key, pos }))
                }}
                onDragLeave={() => setDropTarget((p) => (p?.id === key ? null : p))}
                onDrop={(e) => {
                  if (!validDrop) return
                  e.preventDefault()
                  const r = e.currentTarget.getBoundingClientRect()
                  handleDrop(key, e.clientY - r.top < r.height / 2 ? 'before' : 'after')
                }}
                onDragEnd={clearDrag}
                style={{ paddingLeft: node.depth * 20 + 8 }}
                className={cn(
                  'group relative flex h-8 cursor-pointer select-none items-center gap-1 border-b border-slate-100 text-[13px] hover:bg-muted dark:border-slate-800',
                  dragId === key && 'opacity-50'
                )}
              >
                {dropTarget?.id === key && (
                  <div
                    className={cn(
                      'pointer-events-none absolute inset-x-0 h-0.5 bg-nvr-cyan',
                      dropTarget.pos === 'before' ? 'top-0' : 'bottom-0'
                    )}
                  />
                )}
                {reorderEnabled && (
                  <GripVertical
                    aria-hidden
                    className='h-3.5 w-3.5 shrink-0 cursor-grab text-slate-300 opacity-0 group-hover:opacity-100'
                  />
                )}
                <ChevronRight className='h-3.5 w-3.5 shrink-0 text-slate-300' />
                <span className='flex-1 truncate pr-1 text-slate-700 dark:text-slate-200'>
                  {node.label}
                </span>
                <div className='flex items-center gap-0.5 pr-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100'>
                  {onAddChild && (
                    <button
                      type='button'
                      title='Add a child record'
                      aria-label={`Add a child under ${node.label}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        onAddChild(node.id)
                      }}
                      className='flex size-7 items-center justify-center rounded text-slate-400 hover:bg-muted hover:text-slate-700 dark:hover:text-slate-100'
                    >
                      <Plus className='h-3.5 w-3.5' />
                    </button>
                  )}
                  <button
                    type='button'
                    title='Move under another parent'
                    aria-label={`Move ${node.label}`}
                    data-cbv-tree-move-btn={key}
                    onClick={(e) => {
                      e.stopPropagation()
                      setMoveSearch('')
                      setMoving(node)
                    }}
                    className='flex size-7 items-center justify-center rounded text-slate-400 hover:bg-muted hover:text-slate-700 dark:hover:text-slate-100'
                  >
                    <ArrowUpDown className='h-3.5 w-3.5' />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Org chart ─────────────────────────────────────────────────────────────────

const NODE_W = 176
const NODE_H = 56
const H_GAP = 20
const V_GAP = 52
const PADDING = 32
const MIN_ZOOM = 0.5
const MAX_ZOOM = 1.5

interface Placed {
  node: NestedNode
  x: number
  y: number
  childCount: number
  collapsed: boolean
}
interface Edge {
  from: { x: number; y: number }
  to: { x: number; y: number }
}

function layoutTree(roots: NestedNode[], collapsedIds: Set<string>) {
  const placed: Placed[] = []
  const edges: Edge[] = []
  let maxDepth = 0
  const subtreeWidth = (n: NestedNode): number => {
    if (collapsedIds.has(String(n.id)) || n.children.length === 0) return NODE_W
    return Math.max(
      NODE_W,
      n.children.reduce((s, c, i) => s + subtreeWidth(c) + (i > 0 ? H_GAP : 0), 0)
    )
  }
  const place = (n: NestedNode, left: number, depth: number): number => {
    maxDepth = Math.max(maxDepth, depth)
    const width = subtreeWidth(n)
    const collapsed = collapsedIds.has(String(n.id))
    const x = left + width / 2 - NODE_W / 2
    const y = depth * (NODE_H + V_GAP)
    placed.push({ node: n, x, y, childCount: n.children.length, collapsed })
    if (!collapsed && n.children.length > 0) {
      const cw = n.children.reduce((s, c, i) => s + subtreeWidth(c) + (i > 0 ? H_GAP : 0), 0)
      let childLeft = left + (width - cw) / 2
      for (const c of n.children) {
        const w = subtreeWidth(c)
        edges.push({
          from: { x: x + NODE_W / 2, y: y + NODE_H },
          to: { x: childLeft + w / 2, y: (depth + 1) * (NODE_H + V_GAP) }
        })
        place(c, childLeft, depth + 1)
        childLeft += w + H_GAP
      }
    }
    return width
  }
  let cursor = PADDING
  for (const r of roots) cursor += place(r, cursor, 0) + H_GAP * 2
  const width = Math.max(cursor - H_GAP * 2 + PADDING, NODE_W + PADDING * 2)
  const height = (maxDepth + 1) * (NODE_H + V_GAP) - V_GAP + PADDING * 2
  for (const p of placed) p.y += PADDING
  for (const e of edges) {
    e.from.y += PADDING
    e.to.y += PADDING
  }
  return { placed, edges, width, height }
}

function edgePath(e: Edge): string {
  const midY = e.from.y + (e.to.y - e.from.y) / 2
  if (e.from.x === e.to.x) return `M ${e.from.x} ${e.from.y} L ${e.to.x} ${e.to.y}`
  return `M ${e.from.x} ${e.from.y} L ${e.from.x} ${midY} L ${e.to.x} ${midY} L ${e.to.x} ${e.to.y}`
}

function OrgChart({
  collection,
  labelField,
  onOpen
}: {
  collection: string
  labelField: string
  onOpen: (id: string | number) => void
}) {
  const client = useNivaroClient()
  const viewportRef = useRef<HTMLDivElement>(null)
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())
  const [zoom, setZoom] = useState(1)
  const {
    data: roots,
    isLoading,
    error
  } = useQuery({
    queryKey: ['tree-nested', collection],
    queryFn: () =>
      client
        .request<{ data: NestedNode[] }>(get(`/tree/${collection}/nested`))
        .then((r) => r.data ?? []),
    staleTime: 10_000
  })
  const { placed, edges, width, height } = useMemo(
    () => layoutTree(roots ?? [], collapsedIds),
    [roots, collapsedIds]
  )
  const toggle = useCallback((id: string | number) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev)
      const k = String(id)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }, [])
  const clamp = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

  if (isLoading)
    return (
      <div className='flex justify-center gap-6 p-8'>
        <Skeleton className='h-14 w-44 rounded-lg' />
        <Skeleton className='h-14 w-44 rounded-lg' />
      </div>
    )
  if (error) return <TreeError error={error} />
  if (!roots || roots.length === 0)
    return <p className='py-10 text-center text-[13px] text-slate-400'>Nothing to chart yet.</p>

  const zoomBtn =
    'flex size-7 items-center justify-center text-slate-500 hover:bg-muted disabled:opacity-40'
  return (
    <div className='relative flex min-h-0 flex-1 flex-col' data-cbv-tree-org>
      <div className='absolute right-3 top-3 z-10 flex items-center overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900'>
        <button
          type='button'
          aria-label='Zoom out'
          disabled={zoom <= MIN_ZOOM}
          onClick={() => setZoom((z) => clamp(Math.round((z - 0.1) * 10) / 10))}
          className={zoomBtn}
        >
          <Minus className='h-3.5 w-3.5' />
        </button>
        <span className='w-11 text-center text-[11px] tabular-nums text-slate-500'>
          {Math.round(zoom * 100)}%
        </span>
        <button
          type='button'
          aria-label='Zoom in'
          disabled={zoom >= MAX_ZOOM}
          onClick={() => setZoom((z) => clamp(Math.round((z + 0.1) * 10) / 10))}
          className={zoomBtn}
        >
          <Plus className='h-3.5 w-3.5' />
        </button>
        <button
          type='button'
          aria-label='Fit to view'
          onClick={() => {
            const vp = viewportRef.current
            if (!vp || !width) return
            setZoom(clamp(Math.min((vp.clientWidth - 16) / width, (vp.clientHeight - 16) / height)))
          }}
          className='flex h-7 items-center gap-1 border-l border-slate-200 px-2 text-[11px] text-slate-500 hover:bg-muted dark:border-slate-700'
        >
          <Maximize className='h-3 w-3' />
          Fit
        </button>
      </div>
      <div ref={viewportRef} className='flex-1 overflow-auto bg-slate-50/60 dark:bg-slate-950'>
        <div style={{ width: width * zoom, height: height * zoom }}>
          <div
            className='relative'
            style={{ width, height, transform: `scale(${zoom})`, transformOrigin: 'top left' }}
          >
            <svg width={width} height={height} className='absolute inset-0' aria-hidden='true'>
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
            {placed.map(({ node, x, y, childCount, collapsed }) => {
              const label = String(node[labelField] ?? node.id)
              return (
                // biome-ignore lint/a11y/useSemanticElements: card hosts a nested collapse button
                <div
                  key={String(node.id)}
                  role='button'
                  tabIndex={0}
                  onClick={() => onOpen(node.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onOpen(node.id)
                    }
                  }}
                  className='group absolute flex cursor-pointer flex-col justify-center rounded-lg border border-slate-200 bg-white px-3 shadow-sm hover:border-nvr-cyan dark:border-slate-700 dark:bg-slate-900'
                  style={{ left: x, top: y, width: NODE_W, height: NODE_H }}
                >
                  <span className='truncate text-[13px] font-medium text-slate-800 dark:text-slate-100'>
                    {label}
                  </span>
                  <span className='mt-0.5 flex items-center gap-1 text-[11px] text-slate-400'>
                    <span className='truncate font-mono'>#{String(node.id)}</span>
                    {childCount > 0 && (
                      <span className='ml-auto rounded-full bg-accent px-1.5 font-medium text-accent-foreground'>
                        {childCount}
                      </span>
                    )}
                  </span>
                  {childCount > 0 && (
                    <button
                      type='button'
                      aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        toggle(node.id)
                      }}
                      className='absolute -bottom-2.5 left-1/2 flex size-5 -translate-x-1/2 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-400 hover:text-nvr-cyan dark:border-slate-700 dark:bg-slate-900'
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

/** The tree read failed — usually a tree config naming a column the table no
 *  longer has. Say so instead of reading as an empty tree. */
function TreeError({ error }: { error: unknown }) {
  const msg = (error as { response?: { error?: string; message?: string } }).response
  const text = String(msg?.error ?? msg?.message ?? (error as Error)?.message ?? '')
  const column = /Invalid column name '([^']+)'/.exec(text)?.[1]
  return (
    <div
      className='m-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200'
      data-cbv-tree-error
    >
      {column
        ? `This collection's tree setup names a column it doesn't have ("${column}"). Fix the tree settings in the Table Editor.`
        : `The tree could not be read. Check the tree settings in the Table Editor.`}
    </div>
  )
}
