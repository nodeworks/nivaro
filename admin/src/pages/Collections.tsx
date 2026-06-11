import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronDown,
  ChevronRight,
  Database,
  EyeOff,
  FolderOpen,
  GripVertical,
  Search
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api, type Collection } from '@/lib/api'
import { formatNumber, titleCase } from '@/lib/utils'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem('nvr_col_collapsed_v1') ?? '{}')
  } catch {
    return {}
  }
}

function saveCollapsed(v: Record<string, boolean>) {
  localStorage.setItem('nvr_col_collapsed_v1', JSON.stringify(v))
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function CollectionAvatar({ color, name }: { color: string | null; name: string }) {
  return (
    <div
      className='flex h-6 w-6 shrink-0 items-center justify-center rounded text-[11px] font-bold text-white select-none'
      style={{ backgroundColor: color ?? '#94a3b8' }}
      aria-hidden='true'
    >
      {name.charAt(0).toUpperCase()}
    </div>
  )
}

function Chip({ label, icon }: { label: string; icon?: React.ReactNode }) {
  return (
    <span className='inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px] font-medium bg-slate-100 text-slate-500 dark:bg-white/10 dark:text-slate-400'>
      {icon}
      {label}
    </span>
  )
}

// The actual link row — shared between sortable and plain contexts
function CollectionRowInner({ col, indent }: { col: Collection; indent?: boolean }) {
  const displayName = col.display_name ?? titleCase(col.collection)
  return (
    <Link
      to={`/collections/${col.collection}`}
      className={`group flex w-full flex-1 items-center gap-2.5 py-1.5 transition-colors duration-150 hover:bg-[#00ceff]/[0.04] focus-visible:bg-[#00ceff]/[0.04] focus-visible:outline-none dark:hover:bg-[#00ceff]/[0.06] ${indent ? 'pl-2 pr-4' : 'px-4'}`}
    >
      <CollectionAvatar color={col.color} name={displayName} />
      <div className='min-w-0 flex-1'>
        <p className='truncate text-[13px] font-semibold tracking-[-0.003em] text-slate-800 group-hover:text-slate-900 dark:text-slate-200 dark:group-hover:text-slate-100'>
          {displayName}
        </p>
        <p className='truncate font-mono text-[11px] text-slate-400 dark:text-slate-500'>
          {col.collection}
        </p>
      </div>
      {col.note && (
        <p className='hidden w-52 shrink-0 truncate text-[12px] text-slate-400 dark:text-slate-500 xl:block'>
          {col.note}
        </p>
      )}
      {(col.hidden || col.singleton) && (
        <div className='flex shrink-0 items-center gap-1.5'>
          {col.hidden && <Chip label='hidden' icon={<EyeOff className='h-2.5 w-2.5' />} />}
          {col.singleton && <Chip label='singleton' />}
        </div>
      )}
      <ChevronRight className='h-3.5 w-3.5 shrink-0 text-slate-300 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-slate-400 dark:text-slate-600 dark:group-hover:text-slate-500' />
    </Link>
  )
}

// Sortable collection row — drag handle + inner link
function SortableCollectionRow({ col }: { col: Collection }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: col.collection
  })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group/row flex items-stretch border-b border-slate-100 last:border-0 dark:border-white/[0.05] ${isDragging ? 'z-10 opacity-40' : ''}`}
    >
      <button
        type='button'
        {...attributes}
        {...listeners}
        className='flex w-8 shrink-0 touch-none cursor-grab items-center justify-center text-slate-300 opacity-0 transition-opacity group-hover/row:opacity-100 hover:text-slate-500 focus-visible:opacity-100 dark:text-slate-600 dark:hover:text-slate-400'
        tabIndex={-1}
        aria-label='Drag to reorder'
      >
        <GripVertical className='h-3.5 w-3.5' />
      </button>
      <CollectionRowInner col={col} indent />
    </div>
  )
}

// Plain (non-sortable) collection row — used during search filtering
function PlainCollectionRow({ col }: { col: Collection }) {
  return (
    <div className='flex items-stretch border-b border-slate-100 last:border-0 dark:border-white/[0.05]'>
      <CollectionRowInner col={col} />
    </div>
  )
}

// ─── Sortable folder section ──────────────────────────────────────────────────

interface FolderSectionProps {
  group: string
  cols: Collection[]
  folderMap: Map<string, Collection>
  collapsed: boolean
  onToggleCollapse: () => void
  sensors: ReturnType<typeof useSensors>
  onColReorder: (group: string, oldIdx: number, newIdx: number) => void
}

function SortableFolderSection({
  group,
  cols,
  folderMap,
  collapsed,
  onToggleCollapse,
  sensors,
  onColReorder
}: FolderSectionProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `folder:${group}`
  })

  const folder = folderMap.get(group)
  const groupLabel = folder?.display_name ?? titleCase(group)
  const groupColor = folder?.color ?? '#94a3b8'
  const colIds = cols.map((c) => c.collection)

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-white/[0.08] dark:bg-white/[0.03] ${isDragging ? 'opacity-50 shadow-md' : ''}`}
    >
      {/* Folder header */}
      <div className='group/folder flex items-stretch'>
        <button
          type='button'
          {...attributes}
          {...listeners}
          className='flex w-8 shrink-0 touch-none cursor-grab items-center justify-center text-slate-300 opacity-0 transition-opacity group-hover/folder:opacity-100 hover:text-slate-500 focus-visible:opacity-100 dark:text-slate-600 dark:hover:text-slate-400'
          tabIndex={-1}
          aria-label='Drag to reorder folder'
        >
          <GripVertical className='h-3.5 w-3.5' />
        </button>
        <button
          type='button'
          onClick={onToggleCollapse}
          className='flex flex-1 items-center gap-2.5 bg-slate-50/80 py-1.5 pr-4 text-left transition-colors hover:bg-slate-100/60 dark:bg-white/[0.02] dark:hover:bg-white/[0.04]'
        >
          <div
            className='flex h-5 w-5 shrink-0 items-center justify-center rounded'
            style={{ backgroundColor: `${groupColor}22` }}
          >
            <FolderOpen className='h-3 w-3' style={{ color: groupColor }} />
          </div>
          <span className='flex-1 text-[12px] font-semibold text-slate-700 dark:text-slate-300'>
            {groupLabel}
          </span>
          <span className='rounded-full bg-slate-200/70 px-1.5 py-px text-[10px] font-semibold tabular-nums text-slate-500 dark:bg-white/10 dark:text-slate-400'>
            {cols.length}
          </span>
          {collapsed ? (
            <ChevronRight className='h-3.5 w-3.5 text-slate-400 dark:text-slate-500' />
          ) : (
            <ChevronDown className='h-3.5 w-3.5 text-slate-400 dark:text-slate-500' />
          )}
        </button>
      </div>

      {/* Folder children */}
      {!collapsed && (
        <div className='border-t border-slate-100 dark:border-white/[0.05]'>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={(e: DragEndEvent) => {
              const { active, over } = e
              if (!over || active.id === over.id) return
              const oldIdx = colIds.indexOf(String(active.id))
              const newIdx = colIds.indexOf(String(over.id))
              if (oldIdx !== -1 && newIdx !== -1) onColReorder(group, oldIdx, newIdx)
            }}
          >
            <SortableContext items={colIds} strategy={verticalListSortingStrategy}>
              {cols.map((col) => (
                <SortableCollectionRow key={col.collection} col={col} />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      )}
    </div>
  )
}

// ─── Loading / empty states ───────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className='space-y-4'>
      <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-white/[0.08]'>
        {[...Array(6)].map((_, i) => (
          <div
            key={i}
            className='flex items-center gap-2.5 border-b border-slate-100 px-4 py-1.5 last:border-0 dark:border-white/[0.05]'
          >
            <Skeleton className='h-8 w-8 rounded-md' />
            <div className='flex-1 space-y-1.5'>
              <Skeleton className='h-3.5 w-40' />
              <Skeleton className='h-3 w-28' />
            </div>
            <Skeleton className='h-3.5 w-3.5 rounded' />
          </div>
        ))}
      </div>
    </div>
  )
}

function EmptySearch({ filter }: { filter: string }) {
  return (
    <div className='py-20 text-center'>
      <p className='text-[13px] text-slate-500 dark:text-slate-400'>
        No collections match{' '}
        <span className='font-semibold text-slate-700 dark:text-slate-300'>"{filter}"</span>
      </p>
    </div>
  )
}

function EmptyState() {
  return (
    <div className='flex flex-col items-center py-24 text-center'>
      <div className='mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 dark:border-white/[0.08] dark:bg-white/[0.03]'>
        <Database className='h-5 w-5 text-slate-400' />
      </div>
      <p className='text-[13px] font-semibold text-slate-700 dark:text-slate-300'>
        No collections registered yet
      </p>
      <p className='mt-1.5 text-[12px] text-slate-400 dark:text-slate-500'>
        Register collections in the Data Model to browse them here.
      </p>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function CollectionsPage() {
  const qc = useQueryClient()
  const searchRef = useRef<HTMLInputElement>(null)
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(readCollapsed)

  // Local collections state for optimistic drag-reorder
  const [local, setLocal] = useState<Collection[]>([])

  const { data, isLoading } = useQuery<Collection[]>({
    queryKey: ['collections'],
    queryFn: () => api.get('/collections').then((r) => r.data.data)
  })

  useEffect(() => {
    if (data) setLocal(data)
  }, [data])

  // ⌘K / Ctrl+K focuses search
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const reorderMut = useMutation({
    mutationFn: (items: { collection: string; sort: number }[]) =>
      api.patch('/collections/reorder', { items }),
    onError: () => {
      toast.error('Failed to save order')
      if (data) setLocal(data)
      qc.invalidateQueries({ queryKey: ['collections'] })
    }
  })

  // Drag sensors with 8px activation distance so taps still navigate
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  // ── Derived state ────────────────────────────────────────────────────────────

  const folderNames = new Set(local.map((col) => col.group).filter((g): g is string => g !== null))
  const folderMap = new Map(
    local.filter((col) => folderNames.has(col.collection)).map((col) => [col.collection, col])
  )
  const realCollections = local.filter((col) => !folderNames.has(col.collection))
  const realCount = realCollections.length

  // Named groups sorted by folder's sort value
  const groupedCols = realCollections.reduce<Record<string, Collection[]>>((acc, col) => {
    const g = col.group ?? '__root__'
    acc[g] ??= []
    acc[g].push(col)
    return acc
  }, {})

  const rootItems = groupedCols.__root__ ?? []

  const namedGroups = Object.entries(groupedCols)
    .filter(([g]) => g !== '__root__')
    .sort(([a], [b]) => {
      const sa = folderMap.get(a)?.sort ?? 9999
      const sb = folderMap.get(b)?.sort ?? 9999
      return sa !== sb ? sa - sb : a.localeCompare(b)
    })

  const folderIds = namedGroups.map(([g]) => `folder:${g}`)

  // ── Reorder helpers ──────────────────────────────────────────────────────────

  function persistSortUpdates(items: { collection: string; sort: number }[]) {
    reorderMut.mutate(items)
  }

  function handleColReorder(group: string, oldIdx: number, newIdx: number) {
    setLocal((prev) => {
      const isRoot = group === '__root__'
      const inGroup = prev.filter(
        (c) => !folderNames.has(c.collection) && (isRoot ? !c.group : c.group === group)
      )
      const reordered = arrayMove(inGroup, oldIdx, newIdx)
      const sortUpdates = reordered.map((c, i) => ({
        collection: c.collection,
        sort: (i + 1) * 10
      }))
      const sortMap = new Map(sortUpdates.map((u) => [u.collection, u.sort]))
      persistSortUpdates(sortUpdates)
      return prev.map((c) =>
        sortMap.has(c.collection) ? { ...c, sort: sortMap.get(c.collection)! } : c
      )
    })
  }

  function handleFolderDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const currentOrder = namedGroups.map(([g]) => g)
    const oldIdx = currentOrder.indexOf(String(active.id).replace('folder:', ''))
    const newIdx = currentOrder.indexOf(String(over.id).replace('folder:', ''))
    if (oldIdx === -1 || newIdx === -1) return
    const reordered = arrayMove(currentOrder, oldIdx, newIdx)
    const sortUpdates = reordered.map((g, i) => ({ collection: g, sort: (i + 1) * 10 }))
    const sortMap = new Map(sortUpdates.map((u) => [u.collection, u.sort]))
    setLocal((prev) =>
      prev.map((c) => (sortMap.has(c.collection) ? { ...c, sort: sortMap.get(c.collection)! } : c))
    )
    persistSortUpdates(sortUpdates)
  }

  function toggleCollapse(group: string) {
    setCollapsed((prev) => {
      const next = { ...prev, [group]: !prev[group] }
      saveCollapsed(next)
      return next
    })
  }

  // ── Filtered view (search active — no drag) ──────────────────────────────────

  const filtered = realCollections.filter((col) => {
    if (!filter) return true
    const q = filter.toLowerCase()
    return (
      col.collection.toLowerCase().includes(q) || (col.display_name ?? '').toLowerCase().includes(q)
    )
  })

  const filteredGrouped = filtered.reduce<Record<string, Collection[]>>((acc, col) => {
    const g = col.group ?? '__root__'
    acc[g] ??= []
    acc[g].push(col)
    return acc
  }, {})

  const filteredRootItems = filteredGrouped.__root__ ?? []
  const filteredNamedGroups = Object.entries(filteredGrouped).filter(([g]) => g !== '__root__')

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <>
      {/* Page header */}
      <div className='sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5 dark:border-white/[0.08] dark:bg-[#0f1923]'>
        <div className='flex items-center gap-3'>
          <h1 className='text-[18px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-slate-100'>
            Collections
          </h1>
          {data && (
            <span className='rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-slate-500 dark:bg-white/10 dark:text-slate-400'>
              {formatNumber(realCount)}
            </span>
          )}
          <div className='relative ml-auto'>
            <Search className='absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
            <Input
              ref={searchRef}
              className='h-8 w-56 border-slate-200 bg-slate-50 pl-8 text-[13px] placeholder:text-slate-400 focus-visible:ring-nvr-cyan dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-slate-200 dark:placeholder:text-slate-500'
              placeholder='Filter… (⌘K)'
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Content */}
      <div className='p-8'>
        {isLoading ? (
          <LoadingSkeleton />
        ) : filter ? (
          // ── Filtered (static) view ───────────────────────────────────────────
          filtered.length === 0 ? (
            <EmptySearch filter={filter} />
          ) : (
            <div className='space-y-4'>
              {filteredNamedGroups.length > 0 && (
                <div
                  className={
                    filteredNamedGroups.length === 1
                      ? 'space-y-4'
                      : 'grid grid-cols-1 items-start gap-4 lg:grid-cols-2'
                  }
                >
                  {filteredNamedGroups.map(([group, cols]) => (
                    <div
                      key={group}
                      className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-white/[0.08] dark:bg-white/[0.03]'
                    >
                      <div className='flex items-center gap-2.5 border-b border-slate-100 bg-slate-50/80 px-4 py-2.5 dark:border-white/[0.06] dark:bg-white/[0.02]'>
                        <div
                          className='flex h-5 w-5 items-center justify-center rounded'
                          style={{
                            backgroundColor: `${folderMap.get(group)?.color ?? '#94a3b8'}22`
                          }}
                        >
                          <FolderOpen
                            className='h-3 w-3'
                            style={{ color: folderMap.get(group)?.color ?? '#94a3b8' }}
                          />
                        </div>
                        <span className='text-[12px] font-semibold text-slate-700 dark:text-slate-300'>
                          {folderMap.get(group)?.display_name ?? titleCase(group)}
                        </span>
                        <span className='ml-auto rounded-full bg-slate-200/70 px-1.5 py-px text-[10px] font-semibold tabular-nums text-slate-500 dark:bg-white/10 dark:text-slate-400'>
                          {cols.length}
                        </span>
                      </div>
                      {cols.map((col) => (
                        <PlainCollectionRow key={col.collection} col={col} />
                      ))}
                    </div>
                  ))}
                </div>
              )}
              {filteredRootItems.length > 0 && (
                <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-white/[0.08] dark:bg-white/[0.03]'>
                  {filteredRootItems.map((col) => (
                    <PlainCollectionRow key={col.collection} col={col} />
                  ))}
                </div>
              )}
            </div>
          )
        ) : realCount === 0 ? (
          <EmptyState />
        ) : (
          // ── Sortable view ────────────────────────────────────────────────────
          <div className='space-y-4'>
            {/* Named folder groups */}
            {namedGroups.length > 0 && (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleFolderDragEnd}
              >
                <SortableContext items={folderIds} strategy={verticalListSortingStrategy}>
                  <div className='space-y-4'>
                    {namedGroups.map(([group, cols]) => (
                      <SortableFolderSection
                        key={group}
                        group={group}
                        cols={cols}
                        folderMap={folderMap}
                        collapsed={!!collapsed[group]}
                        onToggleCollapse={() => toggleCollapse(group)}
                        sensors={sensors}
                        onColReorder={handleColReorder}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}

            {/* Root (ungrouped) collections — always at bottom */}
            {rootItems.length > 0 && (
              <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-white/[0.08] dark:bg-white/[0.03]'>
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={(e: DragEndEvent) => {
                    const { active, over } = e
                    if (!over || active.id === over.id) return
                    const ids = rootItems.map((c) => c.collection)
                    const oldIdx = ids.indexOf(String(active.id))
                    const newIdx = ids.indexOf(String(over.id))
                    if (oldIdx !== -1 && newIdx !== -1) handleColReorder('__root__', oldIdx, newIdx)
                  }}
                >
                  <SortableContext
                    items={rootItems.map((c) => c.collection)}
                    strategy={verticalListSortingStrategy}
                  >
                    {rootItems.map((col) => (
                      <SortableCollectionRow key={col.collection} col={col} />
                    ))}
                  </SortableContext>
                </DndContext>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}
