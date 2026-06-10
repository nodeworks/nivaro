import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowUpDown,
  ChevronRight,
  GripVertical,
  List,
  Network,
  Pencil,
  Plus,
  Trash2
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useParams } from 'react-router'
import { toast } from 'sonner'
import { OrgChart } from '@/components/org-chart'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

export interface TreeViewNode {
  id: string | number
  depth: number
  label: string
  parent_id?: string | number | null
  [key: string]: unknown
}

interface TreeConfig {
  id: number
  collection: string
  parent_field: string
  label_field: string
  order_field: string | null
  maintain_path?: boolean
}

export interface TreeViewProps {
  nodes: TreeViewNode[]
  selectedId?: string | number | null
  onSelect?: (node: TreeViewNode) => void
  onAddChild?: (node: TreeViewNode) => void
  onMove?: (node: TreeViewNode) => void
  onEdit?: (node: TreeViewNode) => void
  onDelete?: (node: TreeViewNode) => void
  loading?: boolean
  emptyText?: string
  /** Collection slug — falls back to the :collection route param when omitted. */
  collection?: string
}

type TreeViewMode = 'list' | 'org'

const VIEW_STORAGE_PREFIX = 'nivaro_tree_view_'

function readStoredView(collection: string | undefined): TreeViewMode {
  if (!collection) return 'list'
  try {
    return localStorage.getItem(`${VIEW_STORAGE_PREFIX}${collection}`) === 'org' ? 'org' : 'list'
  } catch {
    return 'list'
  }
}

/** Normalized parent key — '' represents root so null/undefined compare equal. */
function parentKey(node: TreeViewNode): string {
  return node.parent_id == null ? '' : String(node.parent_id)
}

/**
 * Rebuilds the depth-first flat list after one sibling group (`pk`) has been
 * reordered. All other groups keep their existing relative order.
 */
function reflattenWithOrder(
  all: TreeViewNode[],
  pk: string,
  orderedSiblings: TreeViewNode[]
): TreeViewNode[] {
  const byParent = new Map<string, TreeViewNode[]>()
  for (const n of all) {
    const key = parentKey(n)
    const list = byParent.get(key)
    if (list) list.push(n)
    else byParent.set(key, [n])
  }
  byParent.set(pk, orderedSiblings)

  const ids = new Set(all.map((n) => String(n.id)))
  // Roots = no parent, or parent missing from the visible set (partial trees)
  const roots = all.filter((n) => n.parent_id == null || !ids.has(String(n.parent_id)))
  const rootList = pk === '' ? orderedSiblings : roots

  const out: TreeViewNode[] = []
  const visit = (node: TreeViewNode) => {
    out.push(node)
    for (const child of byParent.get(String(node.id)) ?? []) visit(child)
  }
  for (const root of rootList) visit(root)

  // Safety: if anything was unreachable (cycles/odd data), append it untouched
  if (out.length !== all.length) {
    const seen = new Set(out.map((n) => String(n.id)))
    for (const n of all) if (!seen.has(String(n.id))) out.push(n)
  }
  return out
}

export function TreeView({
  nodes,
  selectedId,
  onSelect,
  onAddChild,
  onMove,
  onEdit,
  onDelete,
  loading = false,
  emptyText = 'No items',
  collection: collectionProp
}: TreeViewProps) {
  const params = useParams<{ collection?: string }>()
  const collection = collectionProp ?? params.collection
  const queryClient = useQueryClient()

  const [view, setView] = useState<TreeViewMode>(() => readStoredView(collection))
  useEffect(() => {
    setView(readStoredView(collection))
  }, [collection])

  const changeView = (next: TreeViewMode) => {
    setView(next)
    if (collection) {
      try {
        localStorage.setItem(`${VIEW_STORAGE_PREFIX}${collection}`, next)
      } catch {
        /* storage unavailable — view just won't persist */
      }
    }
  }

  const { data: config } = useQuery({
    queryKey: ['tree-config', collection],
    queryFn: () =>
      api
        .get<{ data: TreeConfig | null }>(`/tree-configs/by-collection/${collection}`)
        .then((r) => r.data.data),
    enabled: !!collection,
    staleTime: 30_000
  })

  // ── Sibling drag-to-reorder (only when an order_field is configured) ──────
  const reorderEnabled = !!collection && !!config?.order_field

  const [optimisticNodes, setOptimisticNodes] = useState<TreeViewNode[] | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: fresh server data supersedes the optimistic order
  useEffect(() => {
    setOptimisticNodes(null)
  }, [nodes])

  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; pos: 'before' | 'after' } | null>(null)

  const displayNodes = optimisticNodes ?? nodes

  const reorderMutation = useMutation({
    mutationFn: ({
      anchorId,
      order
    }: {
      anchorId: string
      order: Array<{ id: string | number; sort: number }>
    }) => api.patch(`/tree/${collection}/${anchorId}/reorder`, { order }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tree-nodes', collection] })
      queryClient.invalidateQueries({ queryKey: ['tree-nested', collection] })
      toast.success('Order updated')
    },
    onError: (err: unknown) => {
      setOptimisticNodes(null)
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Failed to reorder')
    }
  })

  const clearDrag = () => {
    setDragId(null)
    setDropTarget(null)
  }

  const handleDrop = (targetId: string, pos: 'before' | 'after') => {
    if (!dragId || dragId === targetId) {
      clearDrag()
      return
    }
    const all = displayNodes
    const dragNode = all.find((n) => String(n.id) === dragId)
    const targetNode = all.find((n) => String(n.id) === targetId)
    if (!dragNode || !targetNode || parentKey(dragNode) !== parentKey(targetNode)) {
      clearDrag()
      return
    }
    const pk = parentKey(dragNode)
    const ordered = all.filter((n) => parentKey(n) === pk && String(n.id) !== dragId)
    const targetIdx = ordered.findIndex((n) => String(n.id) === targetId)
    if (targetIdx === -1) {
      clearDrag()
      return
    }
    ordered.splice(pos === 'before' ? targetIdx : targetIdx + 1, 0, dragNode)

    setOptimisticNodes(reflattenWithOrder(all, pk, ordered))
    reorderMutation.mutate({
      anchorId: dragId,
      order: ordered.map((n, i) => ({ id: n.id, sort: i + 1 }))
    })
    clearDrag()
  }

  // ── Toolbar (view toggle) — shown only when we know which collection ──────
  const toolbar = collection ? (
    <div className='flex shrink-0 items-center justify-end border-b border-slate-100 bg-white px-3 py-1.5 dark:border-border dark:bg-background'>
      <div className='flex overflow-hidden rounded-md border border-slate-200 dark:border-border'>
        <button
          type='button'
          title='List view'
          onClick={() => changeView('list')}
          className={cn(
            'flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium transition-colors',
            view === 'list'
              ? 'bg-nvr-cyan/10 text-nvr-navy dark:bg-nvr-cyan/15 dark:text-nvr-cyan'
              : 'bg-white text-slate-500 hover:bg-slate-50 dark:bg-background dark:text-slate-400 dark:hover:bg-accent/50'
          )}
        >
          <List className='h-3 w-3' />
          List
        </button>
        <button
          type='button'
          title='Org chart view'
          onClick={() => changeView('org')}
          className={cn(
            'flex items-center gap-1 border-l border-slate-200 px-2 py-0.5 text-[11px] font-medium transition-colors dark:border-border',
            view === 'org'
              ? 'bg-nvr-cyan/10 text-nvr-navy dark:bg-nvr-cyan/15 dark:text-nvr-cyan'
              : 'bg-white text-slate-500 hover:bg-slate-50 dark:bg-background dark:text-slate-400 dark:hover:bg-accent/50'
          )}
        >
          <Network className='h-3 w-3' />
          Org chart
        </button>
      </div>
    </div>
  ) : null

  // ── Org chart view ─────────────────────────────────────────────────────────
  if (collection && config && view === 'org') {
    return (
      <div className='flex h-full min-h-[400px] flex-col'>
        {toolbar}
        <OrgChart collection={collection} config={config} />
      </div>
    )
  }

  // ── List view ──────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div>
        {toolbar}
        <div className='overflow-auto'>
          {[72, 52, 88].map((w) => (
            <div
              key={w}
              className='flex items-center h-8 px-2 gap-2 border-b border-slate-100 dark:border-border'
            >
              <Skeleton className='h-3.5 w-3.5 shrink-0 rounded' />
              <Skeleton className={`h-3 rounded`} style={{ width: `${w}%` }} />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (displayNodes.length === 0) {
    return (
      <div>
        {toolbar}
        <div className='overflow-auto flex items-center justify-center py-10 text-[13px] text-slate-400 dark:text-muted-foreground'>
          {emptyText}
        </div>
      </div>
    )
  }

  return (
    <div>
      {toolbar}
      <div className='overflow-auto'>
        {displayNodes.map((node) => {
          const nodeKey = String(node.id)
          const isSelected =
            selectedId !== null && selectedId !== undefined && nodeKey === String(selectedId)
          const indent = node.depth * 20
          const isDragging = dragId === nodeKey
          const isDropBefore = dropTarget?.id === nodeKey && dropTarget.pos === 'before'
          const isDropAfter = dropTarget?.id === nodeKey && dropTarget.pos === 'after'
          const dragNode = dragId ? displayNodes.find((n) => String(n.id) === dragId) : null
          const isValidDropTarget =
            !!dragNode && !isDragging && parentKey(dragNode) === parentKey(node)

          return (
            // biome-ignore lint/a11y/useSemanticElements: row hosts nested action buttons, so it cannot be a <button>
            <div
              key={nodeKey}
              role='button'
              tabIndex={0}
              onClick={() => onSelect?.(node)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelect?.(node)
                }
              }}
              draggable={reorderEnabled}
              onDragStart={(e) => {
                if (!reorderEnabled) return
                setDragId(nodeKey)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', nodeKey)
              }}
              onDragOver={(e) => {
                if (!isValidDropTarget) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                const rect = e.currentTarget.getBoundingClientRect()
                const pos = e.clientY - rect.top < rect.height / 2 ? 'before' : 'after'
                setDropTarget((prev) =>
                  prev?.id === nodeKey && prev.pos === pos ? prev : { id: nodeKey, pos }
                )
              }}
              onDragLeave={() => {
                setDropTarget((prev) => (prev?.id === nodeKey ? null : prev))
              }}
              onDrop={(e) => {
                if (!isValidDropTarget) return
                e.preventDefault()
                const rect = e.currentTarget.getBoundingClientRect()
                const pos = e.clientY - rect.top < rect.height / 2 ? 'before' : 'after'
                handleDrop(nodeKey, pos)
              }}
              onDragEnd={clearDrag}
              className={[
                'group relative flex items-center h-8 gap-1 border-b border-slate-100 dark:border-border',
                'cursor-pointer select-none text-[13px]',
                'hover:bg-slate-50 dark:hover:bg-accent/50',
                isSelected ? 'bg-nvr-cyan/10 dark:bg-nvr-cyan/15' : 'bg-white dark:bg-background',
                isDragging ? 'opacity-50' : ''
              ].join(' ')}
              style={{ paddingLeft: `${indent + 8}px` }}
            >
              {/* drop position indicators */}
              {isDropBefore && (
                <div className='pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-nvr-cyan' />
              )}
              {isDropAfter && (
                <div className='pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-nvr-cyan' />
              )}

              {/* drag grip — only when sibling reordering is available */}
              {reorderEnabled && (
                <GripVertical
                  className='h-3.5 w-3.5 shrink-0 cursor-grab text-slate-300 opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing dark:text-muted-foreground'
                  aria-hidden='true'
                />
              )}

              {/* chevron placeholder for visual alignment */}
              <ChevronRight className='h-3.5 w-3.5 shrink-0 text-slate-300 dark:text-muted-foreground' />

              {/* label */}
              <span
                className={[
                  'flex-1 truncate pr-1',
                  isSelected
                    ? 'text-nvr-navy dark:text-nvr-cyan font-medium'
                    : 'text-slate-700 dark:text-foreground'
                ].join(' ')}
              >
                {node.label}
              </span>

              {/* hover actions */}
              <div className='flex items-center gap-0.5 pr-2 opacity-0 group-hover:opacity-100 transition-opacity'>
                {onEdit && (
                  <button
                    type='button'
                    title='Edit'
                    onClick={(e) => {
                      e.stopPropagation()
                      onEdit(node)
                    }}
                    className='size-7 flex items-center justify-center rounded text-[12px] text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:hover:text-foreground dark:hover:bg-accent'
                  >
                    <Pencil className='h-3.5 w-3.5' />
                  </button>
                )}
                {onAddChild && (
                  <button
                    type='button'
                    title='Add child'
                    onClick={(e) => {
                      e.stopPropagation()
                      onAddChild(node)
                    }}
                    className='size-7 flex items-center justify-center rounded text-[12px] text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:hover:text-foreground dark:hover:bg-accent'
                  >
                    <Plus className='h-3.5 w-3.5' />
                  </button>
                )}
                {onMove && (
                  <button
                    type='button'
                    title='Move'
                    onClick={(e) => {
                      e.stopPropagation()
                      onMove(node)
                    }}
                    className='size-7 flex items-center justify-center rounded text-[12px] text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:hover:text-foreground dark:hover:bg-accent'
                  >
                    <ArrowUpDown className='h-3.5 w-3.5' />
                  </button>
                )}
                {onDelete && (
                  <button
                    type='button'
                    title='Delete'
                    onClick={(e) => {
                      e.stopPropagation()
                      onDelete(node)
                    }}
                    className='size-7 flex items-center justify-center rounded text-[12px] text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40'
                  >
                    <Trash2 className='h-3.5 w-3.5' />
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
