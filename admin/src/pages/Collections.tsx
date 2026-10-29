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
  Clock,
  Database,
  FolderOpen,
  GripVertical,
  Link2,
  SearchX,
  Star
} from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { CollectionDesigner } from '@/components/collection-designer'
import { SchemaProposalsPanel } from '@/components/schema-proposals-panel'
import { Skeleton } from '@/components/ui/skeleton'
import { api, type Collection } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/utils'
import { CollectionAvatar, CollectionRow } from './collections/CollectionRow'
import { CollectionsToolbar } from './collections/CollectionsToolbar'
import { FolderSuggestions } from './collections/FolderSuggestions'
import { type FolderSuggestion, suggestFolders } from './collections/folder-suggestions'
import { MoveToFolderDialog } from './collections/MoveToFolderDialog'
import {
  moveCollections,
  readLocal,
  recordCollectionOpen,
  useCollectionUsage,
  useOverviewStats,
  usePinnedCollections,
  writeLocal
} from './collections/overview-data'
import { buildPageModel, label, nearSpellings } from './collections/page-model'
import {
  CreateTableInline,
  DescribePanel,
  OtherTablesSections,
  type SchemaPanel,
  SchemaToolsMenu
} from './collections/SchemaTools'
import type { CollectionStat, FolderOption, PageState } from './collections/types'

/**
 * Collections (/collections) — every registered collection, findable.
 *
 * Folders (a registry row other rows name as their `group`) hold the curated
 * part; everything else sits in "Not in a folder", A–Z. Hidden collections and
 * link tables are folded away by default. Views other than Folders are one
 * flat sorted list. Pins are sidebar favorites; Recent / Most used are this
 * browser's own. Reordering only happens in Arrange mode. Admins also get
 * counts, last change, badges, the hover card and folder tools.
 */

const COLLAPSED_KEY = 'nivaro_col_collapsed'
const PREFS_KEY = 'nvr_collections_prefs'
const DISMISSED_KEY = 'nvr_collections_suggestions_dismissed'
const LOOSE_KEY = '__loose__'
const LINKS_KEY = '__links__'

type Prefs = Pick<PageState, 'view' | 'density' | 'showHidden' | 'showLinks'>
const DEFAULT_PREFS: Prefs = {
  view: 'folders',
  density: 'compact',
  showHidden: false,
  showLinks: false
}

const sectionId = (key: string) => `cl-section-${key.replace(/[^A-Za-z0-9_-]/g, '_')}`

// ─── Sortable wrappers (Arrange mode only) ────────────────────────────────────

function SortableRow({ id, children }: { id: string; children: (handle: ReactNode) => ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id
  })
  const handle = (
    <button
      type='button'
      {...attributes}
      {...listeners}
      aria-label='Drag to reorder'
      className='flex w-7 shrink-0 cursor-grab touch-none items-center justify-center text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300'
    >
      <GripVertical className='h-3.5 w-3.5' />
    </button>
  )
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('relative', isDragging && 'z-10 opacity-50')}
    >
      {children(handle)}
    </div>
  )
}

// ─── Folder section ───────────────────────────────────────────────────────────

function FolderHeader({
  folder,
  count,
  hiddenCount,
  collapsed,
  onToggle,
  dragHandle,
  icon
}: {
  folder: FolderOption
  count: number
  hiddenCount: number
  collapsed: boolean
  onToggle: () => void
  dragHandle?: ReactNode
  icon?: ReactNode
}) {
  const color = folder.color ?? '#94a3b8'
  return (
    <div
      // Sticks under the page toolbar while its folder scrolls past.
      className='sticky z-[5] flex items-stretch border-b border-slate-200 bg-slate-50 dark:border-white/[0.08] dark:bg-[#141f2a]'
      style={{ top: 'var(--cl-toolbar-h, 0px)' }}
    >
      {dragHandle}
      <button
        type='button'
        onClick={onToggle}
        aria-expanded={!collapsed}
        className={cn(
          'flex flex-1 items-center gap-2.5 py-1.5 pr-4 text-left transition-colors hover:bg-slate-100 dark:hover:bg-white/[0.04]',
          !dragHandle && 'pl-4'
        )}
      >
        <span
          className='flex h-5 w-5 shrink-0 items-center justify-center rounded'
          style={{ backgroundColor: `${color}22` }}
        >
          {icon ?? <FolderOpen className='h-3 w-3' style={{ color }} />}
        </span>
        <span className='flex-1 truncate text-[12px] font-semibold text-slate-700 dark:text-slate-200'>
          {folder.label}
        </span>
        <span className='text-[11px] tabular-nums text-slate-500 dark:text-slate-400'>
          {count}
          {hiddenCount > 0 && (
            <span data-tip='Hidden collections in this folder — turn on Show hidden to list them'>
              {' '}
              · {hiddenCount} hidden
            </span>
          )}
        </span>
        {collapsed ? (
          <ChevronRight className='h-3.5 w-3.5 text-slate-400 dark:text-slate-500' />
        ) : (
          <ChevronDown className='h-3.5 w-3.5 text-slate-400 dark:text-slate-500' />
        )}
      </button>
    </div>
  )
}

function Section({ id, children }: { id: string; children: ReactNode }) {
  return (
    <section
      id={id}
      className='rounded-lg border border-slate-200 bg-white dark:border-white/[0.08] dark:bg-white/[0.03]'
      style={{ scrollMarginTop: 'calc(var(--cl-toolbar-h, 0px) + 12px)' }}
    >
      {children}
    </section>
  )
}

// ─── Loading / empty states ───────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-white/[0.08] dark:bg-white/[0.03]'>
      {[...Array(8)].map((_, i) => (
        <div
          key={i}
          className='flex items-center gap-2.5 border-b border-slate-100 px-4 py-2 last:border-0 dark:border-white/[0.05]'
        >
          <Skeleton className='h-6 w-6 rounded' />
          <Skeleton className='h-3.5 w-48' />
          <Skeleton className='ml-auto h-3 w-16' />
        </div>
      ))}
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
      <p className='mt-1.5 text-[12px] text-slate-500 dark:text-slate-400'>
        Register collections in the Data Model to browse them here.
      </p>
    </div>
  )
}

/** Nothing matched: near spellings, matches that are folded away, and a way out. */
function EmptySearch({
  filter,
  near,
  hiddenMatches,
  linkMatches,
  chipsOn,
  onShowHidden,
  onShowLinks,
  onClearChips,
  isAdmin,
  onCreate
}: {
  filter: string
  near: Collection[]
  hiddenMatches: number
  linkMatches: number
  chipsOn: boolean
  onShowHidden: () => void
  onShowLinks: () => void
  onClearChips: () => void
  isAdmin: boolean
  onCreate?: () => void
}) {
  const btn =
    'rounded-md border border-slate-200 px-2.5 py-1 text-[12px] font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50 dark:border-white/[0.1] dark:text-slate-200 dark:hover:bg-white/[0.05]'
  return (
    <div className='flex flex-col items-center py-16 text-center' data-collections-empty-search>
      <SearchX className='mb-3 h-6 w-6 text-slate-400' />
      <p className='text-[13px] font-semibold text-slate-700 dark:text-slate-200'>
        {filter ? (
          <>
            No collection matches <span className='font-mono'>“{filter}”</span>
          </>
        ) : (
          'No collection matches these filters'
        )}
      </p>
      {near.length > 0 && (
        <p className='mt-3 text-[12px] text-slate-600 dark:text-slate-300'>
          Did you mean{' '}
          {near.map((c, i) => (
            <span key={c.collection}>
              {i > 0 && (i === near.length - 1 ? ' or ' : ', ')}
              <Link
                to={`/collections/${encodeURIComponent(c.collection)}`}
                onClick={() => recordCollectionOpen(c.collection)}
                className='font-medium text-nvr-cyan underline-offset-2 hover:underline'
              >
                {label(c)}
              </Link>
            </span>
          ))}
          ?
        </p>
      )}
      <div className='mt-4 flex flex-wrap justify-center gap-2'>
        {hiddenMatches > 0 && (
          <button type='button' className={btn} onClick={onShowHidden}>
            {hiddenMatches} hidden{' '}
            {hiddenMatches === 1 ? 'collection matches' : 'collections match'} — show hidden
          </button>
        )}
        {linkMatches > 0 && (
          <button type='button' className={btn} onClick={onShowLinks}>
            {linkMatches} link {linkMatches === 1 ? 'table matches' : 'tables match'} — show link
            tables
          </button>
        )}
        {chipsOn && (
          <button type='button' className={btn} onClick={onClearChips}>
            Clear filters
          </button>
        )}
        {isAdmin && onCreate && (
          <button type='button' className={btn} onClick={onCreate}>
            Create a table
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Pinned + recent strip ────────────────────────────────────────────────────

function QuickStrip({ title, icon, cols }: { title: string; icon: ReactNode; cols: Collection[] }) {
  if (!cols.length) return null
  return (
    <div className='flex min-w-0 flex-wrap items-center gap-1.5'>
      <span className='mr-1 inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 dark:text-slate-400'>
        {icon}
        {title}
      </span>
      {cols.map((c) => (
        <Link
          key={c.collection}
          to={`/collections/${encodeURIComponent(c.collection)}`}
          onClick={() => recordCollectionOpen(c.collection)}
          className='inline-flex max-w-[220px] items-center gap-1.5 rounded-md border border-slate-200 bg-white py-0.5 pl-1 pr-2 text-[12px] font-medium text-slate-700 transition-colors hover:border-nvr-cyan/50 hover:bg-nvr-cyan/[0.05] dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-slate-200 dark:hover:bg-nvr-cyan/[0.08]'
        >
          <CollectionAvatar color={c.color} name={label(c)} icon={c.icon} />
          <span className='truncate'>{label(c)}</span>
        </Link>
      ))}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function CollectionsPage() {
  const qc = useQueryClient()
  const { user } = useAuth()
  const isAdmin = (user as { is_admin?: boolean } | null)?.is_admin ?? false
  const filterRef = useRef<HTMLInputElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)

  const [filter, setFilter] = useState('')
  const [prefs, setPrefs] = useState<Prefs>(() => ({
    ...DEFAULT_PREFS,
    ...readLocal<Partial<Prefs>>(PREFS_KEY, {})
  }))
  const [chips, setChips] = useState<PageState['chips']>([])
  const [arranging, setArranging] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [moveOpen, setMoveOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => ({
    [LINKS_KEY]: true,
    __unregistered__: true,
    __system__: true,
    ...readLocal<Record<string, boolean>>(COLLAPSED_KEY, {})
  }))
  const [dismissed, setDismissed] = useState<string[]>(() => readLocal<string[]>(DISMISSED_KEY, []))
  // Data-model tools folded in from the old Data Model list page (?proposals=1 opens proposals).
  const [panel, setPanel] = useState<SchemaPanel>(() =>
    new URLSearchParams(window.location.search).get('proposals') === '1' ? 'proposals' : null
  )
  const [designerOpen, setDesignerOpen] = useState(false)

  const state: PageState = {
    ...prefs,
    // Admin-only views fall back to Folders for everyone else.
    view:
      !isAdmin && (prefs.view === 'records' || prefs.view === 'recent') ? 'folders' : prefs.view,
    chips,
    arranging,
    selecting
  }

  const { data, isLoading } = useQuery<Collection[]>({
    queryKey: ['collections'],
    queryFn: () => api.get('/collections').then((r) => r.data.data)
  })
  const [local, setLocal] = useState<Collection[]>([])
  useEffect(() => {
    if (data) setLocal(data)
  }, [data])

  const { data: stats } = useOverviewStats(isAdmin)
  const usage = useCollectionUsage()
  const { pinned, toggle: togglePin } = usePinnedCollections()

  const model = useMemo(
    () => buildPageModel(local, stats, state, filter, usage),
    // biome-ignore lint/correctness/useExhaustiveDependencies: state fields are listed one by one
    [local, stats, filter, usage, state.view, state.chips, state.showHidden, state.showLinks]
  )
  const byName = useMemo(() => new Map(model.real.map((c) => [c.collection, c])), [model.real])

  // The toolbar's height feeds the sticky folder headers and the jump targets.
  useEffect(() => {
    const el = toolbarRef.current
    const page = pageRef.current
    if (!el || !page) return
    const set = () => page.style.setProperty('--cl-toolbar-h', `${el.offsetHeight}px`)
    set()
    const ro = new ResizeObserver(set)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const onChange = (next: PageState) => {
    const p: Prefs = {
      view: next.view,
      density: next.density,
      showHidden: next.showHidden,
      showLinks: next.showLinks
    }
    setPrefs(p)
    writeLocal(PREFS_KEY, p)
    setChips(next.chips)
    setArranging(next.arranging)
    setSelecting(next.selecting)
    if (!next.selecting) setSelected(new Set())
  }

  const toggleCollapse = (key: string) =>
    setCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      writeLocal(COLLAPSED_KEY, next)
      return next
    })

  // ── Moves ──────────────────────────────────────────────────────────────────
  const afterMove = () => {
    void qc.invalidateQueries({ queryKey: ['collections'] })
    void qc.invalidateQueries({ queryKey: ['collections-overview-stats'] })
  }
  const moveOne = async (col: Collection, group: string | null) => {
    try {
      await moveCollections([col.collection], group)
      const to = group ? (model.folders.find((f) => f.key === group)?.label ?? group) : 'no folder'
      toast.success(`Moved ${label(col)} to ${to}`)
      afterMove()
    } catch {
      toast.error(`Could not move ${label(col)}`)
    }
  }

  // ── Suggested folders (#13) ──────────────────────────────────────────────────
  const suggestions = useMemo(() => {
    if (!isAdmin || state.view !== 'folders' || filter || chips.length || arranging) return []
    const loose = model.real.filter((c) => !c.group && !c.hidden)
    return suggestFolders(loose, model.folders, model.real).filter(
      (s) => !dismissed.includes(suggestionKey(s))
    )
  }, [isAdmin, state.view, filter, chips.length, arranging, model, dismissed])

  // ── Arrange mode reorders (dnd only while arranging) ────────────────────────
  const reorderMut = useMutation({
    mutationFn: (items: { collection: string; sort: number }[]) =>
      api.patch('/collections/reorder', { items }),
    onError: () => {
      toast.error('Could not save the new order')
      if (data) setLocal(data)
      void qc.invalidateQueries({ queryKey: ['collections'] })
    }
  })
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const applySorts = (updates: { collection: string; sort: number }[]) => {
    const map = new Map(updates.map((u) => [u.collection, u.sort]))
    setLocal((prev) =>
      prev.map((c) => (map.has(c.collection) ? { ...c, sort: map.get(c.collection)! } : c))
    )
    reorderMut.mutate(updates)
  }
  const reorderIn = (ids: string[], e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from === -1 || to === -1) return
    applySorts(
      arrayMove(ids, from, to).map((collection, i) => ({ collection, sort: (i + 1) * 10 }))
    )
  }

  // ── Rendering helpers ────────────────────────────────────────────────────────
  const renderRow = (col: Collection, dragHandle?: ReactNode) => (
    <CollectionRow
      col={col}
      stat={stats?.[col.collection] as CollectionStat | undefined}
      density={state.density}
      pinned={pinned.has(col.collection)}
      onTogglePin={() => void togglePin(col.collection, label(col))}
      folders={model.folders}
      onMove={(group) => void moveOne(col, group)}
      selecting={selecting}
      selected={selected.has(col.collection)}
      onSelect={() =>
        setSelected((prev) => {
          const next = new Set(prev)
          if (next.has(col.collection)) next.delete(col.collection)
          else next.add(col.collection)
          return next
        })
      }
      dragHandle={dragHandle}
      highlight={filter}
      isAdmin={isAdmin}
    />
  )
  const rowList = (cols: Collection[], sortable: boolean) => {
    if (!sortable)
      return (
        <div className='divide-y divide-slate-100 dark:divide-white/[0.05]'>
          {cols.map((c) => (
            <div key={c.collection}>{renderRow(c)}</div>
          ))}
        </div>
      )
    const ids = cols.map((c) => c.collection)
    return (
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={(e) => reorderIn(ids, e)}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <div className='divide-y divide-slate-100 dark:divide-white/[0.05]'>
            {cols.map((c) => (
              <SortableRow key={c.collection} id={c.collection}>
                {(handle) => renderRow(c, handle)}
              </SortableRow>
            ))}
          </div>
        </SortableContext>
      </DndContext>
    )
  }

  const narrowing = !!filter.trim() || chips.length > 0
  const isOpen = (key: string) => narrowing || !collapsed[key]
  const folderView = state.view === 'folders'
  const showQuick = folderView && !narrowing && !arranging && !selecting
  const pinnedCols = [...pinned].map((n) => byName.get(n)).filter((c): c is Collection => !!c)
  const recentCols = usage.recent
    .filter((n) => !pinned.has(n))
    .map((n) => byName.get(n))
    .filter((c): c is Collection => !!c)
    .slice(0, 6)

  const jumpTargets = folderView
    ? [
        ...model.sections.map((s) => ({
          key: s.folder.key,
          label: s.folder.label,
          count: s.cols.length
        })),
        ...(model.loose.length
          ? [{ key: LOOSE_KEY, label: 'Not in a folder', count: model.loose.length }]
          : []),
        ...(model.linkTables.length
          ? [{ key: LINKS_KEY, label: 'Link tables', count: model.linkTables.length }]
          : [])
      ]
    : []

  return (
    <div ref={pageRef} className='flex min-h-0 flex-1 flex-col'>
      <div ref={toolbarRef} className='sticky top-0 z-10'>
        <CollectionsToolbar
          state={state}
          onChange={onChange}
          filter={filter}
          onFilterChange={setFilter}
          filterRef={filterRef}
          counts={model.counts}
          isAdmin={isAdmin}
          selectedCount={selected.size}
          onMoveSelected={() => setMoveOpen(true)}
          onClearSelection={() => setSelected(new Set())}
          adminActions={
            isAdmin ? (
              <SchemaToolsMenu onPanel={setPanel} onDesign={() => setDesignerOpen(true)} />
            ) : null
          }
        />
      </div>

      <div className='flex gap-6 px-4 py-6 sm:px-8'>
        <div className='min-w-0 flex-1 space-y-4'>
          {isAdmin && panel === 'create' && <CreateTableInline onClose={() => setPanel(null)} />}
          {isAdmin && panel === 'describe' && <DescribePanel onClose={() => setPanel(null)} />}
          {isAdmin && panel === 'proposals' && (
            <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-white/[0.08] dark:bg-white/[0.03]'>
              <SchemaProposalsPanel onClose={() => setPanel(null)} />
            </div>
          )}
          {isLoading ? (
            <LoadingSkeleton />
          ) : model.real.length === 0 ? (
            <EmptyState />
          ) : model.shownCount === 0 && model.linkTables.length === 0 ? (
            <EmptySearch
              filter={filter.trim()}
              near={filter.trim() ? nearSpellings(filter, model.real) : []}
              hiddenMatches={model.foldedMatches.hidden.length}
              linkMatches={model.foldedMatches.links.length}
              chipsOn={chips.length > 0}
              onShowHidden={() => onChange({ ...state, showHidden: true })}
              onShowLinks={() => onChange({ ...state, showLinks: true })}
              onClearChips={() => setChips([])}
              isAdmin={isAdmin}
              onCreate={() => setPanel('create')}
            />
          ) : (
            <>
              {showQuick && (pinnedCols.length > 0 || recentCols.length > 0) && (
                <div className='space-y-2' data-collections-quick>
                  <QuickStrip
                    title='Pinned'
                    icon={<Star className='h-3 w-3 fill-current' />}
                    cols={pinnedCols}
                  />
                  <QuickStrip
                    title='Recent'
                    icon={<Clock className='h-3 w-3' />}
                    cols={recentCols}
                  />
                </div>
              )}

              {suggestions.length > 0 && (
                <FolderSuggestions
                  suggestions={suggestions}
                  onAccept={async (s) => {
                    await moveCollections(s.collections, s.folder.key)
                    toast.success(`Moved ${s.collections.length} to ${s.folder.label}`)
                    afterMove()
                  }}
                  onDismiss={(s) => {
                    const next = [...dismissed, suggestionKey(s)]
                    setDismissed(next)
                    writeLocal(DISMISSED_KEY, next)
                  }}
                />
              )}

              {folderView ? (
                <>
                  {arranging ? (
                    <DndContext
                      sensors={sensors}
                      collisionDetection={closestCenter}
                      onDragEnd={(e) =>
                        reorderIn(
                          model.sections.map((s) => s.folder.key),
                          e
                        )
                      }
                    >
                      <SortableContext
                        items={model.sections.map((s) => s.folder.key)}
                        strategy={verticalListSortingStrategy}
                      >
                        <div className='space-y-4'>
                          {model.sections.map((s) => (
                            <SortableRow key={s.folder.key} id={s.folder.key}>
                              {(handle) => (
                                <Section id={sectionId(s.folder.key)}>
                                  <FolderHeader
                                    folder={s.folder}
                                    count={s.cols.length}
                                    hiddenCount={s.hiddenCount}
                                    collapsed={!isOpen(s.folder.key)}
                                    onToggle={() => toggleCollapse(s.folder.key)}
                                    dragHandle={handle}
                                  />
                                  {isOpen(s.folder.key) && rowList(s.cols, true)}
                                </Section>
                              )}
                            </SortableRow>
                          ))}
                        </div>
                      </SortableContext>
                    </DndContext>
                  ) : (
                    model.sections.map((s) => (
                      <Section key={s.folder.key} id={sectionId(s.folder.key)}>
                        <FolderHeader
                          folder={s.folder}
                          count={s.cols.length}
                          hiddenCount={s.hiddenCount}
                          collapsed={!isOpen(s.folder.key)}
                          onToggle={() => toggleCollapse(s.folder.key)}
                        />
                        {isOpen(s.folder.key) && rowList(s.cols, false)}
                      </Section>
                    ))
                  )}

                  {model.loose.length > 0 && (
                    <Section id={sectionId(LOOSE_KEY)}>
                      <FolderHeader
                        folder={{ key: LOOSE_KEY, label: 'Not in a folder', color: '#94a3b8' }}
                        count={model.loose.length}
                        hiddenCount={0}
                        collapsed={!isOpen(LOOSE_KEY)}
                        onToggle={() => toggleCollapse(LOOSE_KEY)}
                      />
                      {isOpen(LOOSE_KEY) && rowList(model.loose, false)}
                    </Section>
                  )}
                </>
              ) : (
                <Section id={sectionId('flat')}>{rowList(model.flat, false)}</Section>
              )}

              {model.linkTables.length > 0 && (
                <Section id={sectionId(LINKS_KEY)}>
                  <FolderHeader
                    folder={{ key: LINKS_KEY, label: 'Link tables', color: '#64748b' }}
                    icon={<Link2 className='h-3 w-3 text-slate-500 dark:text-slate-400' />}
                    count={model.linkTables.length}
                    hiddenCount={0}
                    collapsed={!isOpen(LINKS_KEY)}
                    onToggle={() => toggleCollapse(LINKS_KEY)}
                  />
                  {isOpen(LINKS_KEY) && (
                    <>
                      <p className='border-b border-slate-100 px-4 py-1.5 text-[11.5px] text-slate-500 dark:border-white/[0.05] dark:text-slate-400'>
                        Tables that only connect two collections (many-to-many). Turn on “Show link
                        tables” to list them in their folders.
                      </p>
                      {rowList(model.linkTables, false)}
                    </>
                  )}
                </Section>
              )}

              {isAdmin && (
                <OtherTablesSections
                  filter={filter}
                  collapsed={collapsed}
                  onToggle={toggleCollapse}
                  renderSection={(s) => (
                    <Section key={s.key} id={sectionId(s.key)}>
                      <FolderHeader
                        folder={{ key: s.key, label: s.label, color: '#94a3b8' }}
                        icon={s.icon}
                        count={s.count}
                        hiddenCount={0}
                        collapsed={!s.open}
                        onToggle={s.onToggle}
                      />
                      {s.open && s.body}
                    </Section>
                  )}
                />
              )}
            </>
          )}
        </div>

        {/* Jump to folder (#24) — wide screens only */}
        {jumpTargets.length > 2 && (
          <nav aria-label='Jump to folder' className='hidden w-44 shrink-0 xl:block'>
            <div
              className='sticky space-y-0.5'
              style={{ top: 'calc(var(--cl-toolbar-h, 0px) + 24px)' }}
            >
              <p className='px-2 pb-1 text-[11px] font-medium text-slate-500 dark:text-slate-400'>
                Jump to
              </p>
              {jumpTargets.map((t) => (
                <button
                  key={t.key}
                  type='button'
                  onClick={() =>
                    document.getElementById(sectionId(t.key))?.scrollIntoView({
                      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
                        ? 'auto'
                        : 'smooth',
                      block: 'start'
                    })
                  }
                  className='flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-white/[0.05] dark:hover:text-slate-100'
                >
                  <span className='min-w-0 flex-1 truncate'>{t.label}</span>
                  <span className='text-[11px] tabular-nums text-slate-500 dark:text-slate-400'>
                    {t.count}
                  </span>
                </button>
              ))}
            </div>
          </nav>
        )}
      </div>

      {isAdmin && <CollectionDesigner open={designerOpen} onClose={() => setDesignerOpen(false)} />}
      <MoveToFolderDialog
        open={moveOpen}
        onOpenChange={setMoveOpen}
        names={[...selected]}
        folders={model.folders}
        onMoved={() => {
          setSelected(new Set())
          afterMove()
        }}
      />
    </div>
  )
}

function suggestionKey(s: FolderSuggestion): string {
  return `${s.folder.key}:${[...s.collections].sort().join(',')}`
}
