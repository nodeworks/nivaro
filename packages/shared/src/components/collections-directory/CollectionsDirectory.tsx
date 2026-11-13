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
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { useQueryClient } from '@tanstack/react-query'
import { Clock, Database, Link2, SearchX, Star } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ErrorNotice } from '../ErrorNotice'
import { Skeleton } from '../ui/skeleton'
import { CollectionAvatar, CollectionRow, defaultCollectionPath, HostLink } from './CollectionRow'
import { CollectionsToolbar } from './CollectionsToolbar'
import {
  DIRECTORY_KEYS,
  readLocal,
  recordCollectionOpen,
  useCollectionUsage,
  useDirectoryCollections,
  useNavFavoriteCollections,
  useOverviewStats,
  writeLocal
} from './directory-data'
import { PINNED_KEY, PinnedSection } from './PinnedSection'
import { buildPageModel, label, nearSpellings } from './page-model'
import { FolderHeader, Section, SortableRow } from './sections'
import { useSharedPins } from './shared-pins'
import type {
  DirectoryCollection as Collection,
  CollectionFavorites,
  CollectionStat,
  CollectionsDirectoryAdminTools,
  PageState
} from './types'

/**
 * The collections directory — every registered collection, findable. One page for every host:
 * the admin app's /collections and efp-new's /admin/data render this.
 *
 * Folders (a registry row other rows name as their `group`) hold the curated part; everything
 * else sits in "Not in a folder", A–Z. Hidden collections and link tables are folded away by
 * default. Views other than Folders are one flat sorted list. "Pinned" is the shared list an
 * administrator puts at the top for everyone (shared-pins.ts); "My favorites" are the person's
 * own stars (= the admin sidebar's favorites); Recent / Most used are this browser's own.
 * Administrators also get counts, last change, badges, the hover card and pin for everyone.
 * Editing tools (Arrange, Select → Move to folder, folder suggestions, schema tools, ✏ Edit,
 * the Data model menu) come only from the host's `admin` prop.
 */

export interface CollectionsDirectoryProps {
  /** The reader is an administrator (stats, admin views, hover card, pin for everyone). */
  isAdmin: boolean
  /** The page's name in the toolbar (default "Collections"). */
  title?: string
  /** Where a collection's records open in this app (default `/collections/<name>`). */
  collectionPath?: (collection: string) => string
  /** Leave collections out of the directory (efp-new: system tables). */
  include?: (c: Collection) => boolean
  /** The person's favorites; default = the shared store the admin sidebar uses. */
  favorites?: CollectionFavorites
  /** Host-only editing tools (the admin app). */
  admin?: CollectionsDirectoryAdminTools
}

const COLLAPSED_KEY = 'nivaro_col_collapsed'
const PREFS_KEY = 'nvr_collections_prefs'
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

// ─── Loading / empty states ───────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div
      className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-white/[0.08] dark:bg-white/[0.03]'
      role='status'
      aria-busy='true'
      aria-label='Loading collections'
    >
      {['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((k) => (
        <div
          key={k}
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
  pathFor,
  hiddenMatches,
  linkMatches,
  chipsOn,
  onShowHidden,
  onShowLinks,
  onClearChips,
  onCreate
}: {
  filter: string
  near: Collection[]
  pathFor: (collection: string) => string
  hiddenMatches: number
  linkMatches: number
  chipsOn: boolean
  onShowHidden: () => void
  onShowLinks: () => void
  onClearChips: () => void
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
              <HostLink
                to={pathFor(c.collection)}
                onClick={() => recordCollectionOpen(c.collection)}
                className='font-medium text-cyan-700 underline-offset-2 hover:underline dark:text-nvr-cyan'
              >
                {label(c)}
              </HostLink>
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
        {onCreate && (
          <button type='button' className={btn} onClick={onCreate}>
            Create a table
          </button>
        )}
      </div>
    </div>
  )
}

// ─── My favorites + recent strip ──────────────────────────────────────────────

function QuickStrip({
  title,
  icon,
  cols,
  empty,
  pathFor,
  ...rest
}: {
  title: string
  icon: ReactNode
  cols: Collection[]
  /** Shown beside the title when there is nothing to list; without it the strip is left out. */
  empty?: ReactNode
  pathFor: (collection: string) => string
  [data: `data-${string}`]: string | boolean | undefined
}) {
  if (!cols.length && !empty) return null
  return (
    <div className='flex min-w-0 flex-wrap items-center gap-1.5' {...rest}>
      <span className='mr-1 inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 dark:text-slate-400'>
        {icon}
        {title}
      </span>
      {cols.map((c) => (
        <HostLink
          key={c.collection}
          to={pathFor(c.collection)}
          onClick={() => recordCollectionOpen(c.collection)}
          className='inline-flex max-w-[220px] items-center gap-1.5 rounded-md border border-slate-200 bg-white py-0.5 pl-1 pr-2 text-[12px] font-medium text-slate-700 transition-colors hover:border-nvr-cyan/50 hover:bg-nvr-cyan/[0.05] dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-slate-200 dark:hover:bg-nvr-cyan/[0.08]'
        >
          <CollectionAvatar color={c.color} name={label(c)} icon={c.icon} />
          <span className='truncate'>{label(c)}</span>
        </HostLink>
      ))}
      {!cols.length && empty}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function CollectionsDirectory({
  isAdmin,
  title,
  collectionPath = defaultCollectionPath,
  include,
  favorites: hostFavorites,
  admin
}: CollectionsDirectoryProps) {
  const qc = useQueryClient()
  const filterRef = useRef<HTMLInputElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  // Host tools are administrator tools whatever the host passes.
  const tools = isAdmin ? admin : undefined
  const canArrange = !!tools?.reorder
  const canSelect = !!(tools?.moveCollections && tools.renderMoveDialog)

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

  const state: PageState = {
    ...prefs,
    // Admin-only views fall back to Folders for everyone else.
    view:
      !isAdmin && (prefs.view === 'records' || prefs.view === 'recent') ? 'folders' : prefs.view,
    chips,
    arranging: canArrange && arranging,
    selecting: canSelect && selecting
  }

  const { data, isLoading, isError, error, refetch } = useDirectoryCollections()
  // A host's `include` is usually an inline function: read it through a ref so a new
  // identity each render never re-filters (and re-renders) in a loop.
  const includeRef = useRef(include)
  includeRef.current = include
  const included = (rows: Collection[]) => {
    const keep = includeRef.current
    return keep ? rows.filter(keep) : rows
  }
  const [local, setLocal] = useState<Collection[]>([])
  // biome-ignore lint/correctness/useExhaustiveDependencies: `included` reads a ref
  useEffect(() => {
    if (data) setLocal(included(data))
  }, [data])

  const { data: stats } = useOverviewStats(isAdmin)
  const usage = useCollectionUsage()
  const ownFavorites = useNavFavoriteCollections(!hostFavorites)
  const { favorite, toggle: toggleFavorite } = hostFavorites ?? ownFavorites
  const sharedPins = useSharedPins()
  const pinnedSet = useMemo(() => new Set(sharedPins.pins), [sharedPins.pins])

  // biome-ignore lint/correctness/useExhaustiveDependencies: state fields are listed one by one
  const model = useMemo(
    () => buildPageModel(local, stats, state, filter, usage),
    [local, stats, filter, usage, state.view, state.chips, state.showHidden, state.showLinks]
  )
  const byName = useMemo(() => new Map(model.real.map((c) => [c.collection, c])), [model.real])

  // The toolbar's height feeds the sticky folder headers and the jump targets.
  useEffect(() => {
    const el = toolbarRef.current
    const page = pageRef.current
    if (!el || !page) return
    // Only a sticky toolbar takes room above the folder headers.
    const set = () =>
      page.style.setProperty(
        '--cl-toolbar-h',
        `${getComputedStyle(el).position === 'sticky' ? el.offsetHeight : 0}px`
      )
    set()
    window.addEventListener('resize', set)
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(set)
    ro?.observe(el)
    return () => {
      window.removeEventListener('resize', set)
      ro?.disconnect()
    }
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

  // ── Moves (host tools) ─────────────────────────────────────────────────────
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: DIRECTORY_KEYS.collections })
    void qc.invalidateQueries({ queryKey: DIRECTORY_KEYS.stats })
  }
  const moveCollections = tools?.moveCollections
  const moveOne = moveCollections
    ? async (col: Collection, group: string | null) => {
        try {
          await moveCollections([col.collection], group)
          const to = group
            ? (model.folders.find((f) => f.key === group)?.label ?? group)
            : 'no folder'
          toast.success(`Moved ${label(col)} to ${to}`)
          refresh()
        } catch {
          toast.error(`Could not move ${label(col)}`)
        }
      }
    : undefined

  // ── Arrange mode reorders (dnd only while arranging) ────────────────────────
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const applySorts = (updates: { collection: string; sort: number }[]) => {
    const reorder = tools?.reorder
    if (!reorder) return
    const map = new Map(updates.map((u) => [u.collection, u.sort]))
    setLocal((prev) =>
      prev.map((c) => {
        const sort = map.get(c.collection)
        return sort === undefined ? c : { ...c, sort }
      })
    )
    reorder(updates).catch(() => {
      toast.error('Could not save the new order')
      if (data) setLocal(included(data))
      void qc.invalidateQueries({ queryKey: DIRECTORY_KEYS.collections })
    })
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
  const renderRow = (
    col: Collection,
    dragHandle?: ReactNode,
    moves?: { onMoveUp?: () => void; onMoveDown?: () => void; inPinned?: boolean }
  ) => (
    <CollectionRow
      col={col}
      stat={stats?.[col.collection] as CollectionStat | undefined}
      density={state.density}
      favorite={favorite.has(col.collection)}
      onToggleFavorite={() => void toggleFavorite(col.collection, label(col))}
      pinnedForAll={pinnedSet.has(col.collection)}
      onTogglePinned={
        isAdmin
          ? () =>
              void (pinnedSet.has(col.collection)
                ? sharedPins.unpin(col.collection, label(col))
                : sharedPins.pin(col.collection, label(col)))
          : undefined
      }
      onMoveUp={moves?.onMoveUp}
      onMoveDown={moves?.onMoveDown}
      quietPin={moves?.inPinned}
      folders={model.folders}
      onMove={moveOne ? (group) => void moveOne(col, group) : undefined}
      recordsPath={collectionPath(col.collection)}
      editPath={tools?.editPath?.(col.collection)}
      menuExtra={
        tools?.rowMenu
          ? { heading: tools.rowMenu.heading, items: tools.rowMenu.items(col.collection) }
          : undefined
      }
      selecting={state.selecting}
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
              <SortableRow key={c.collection} id={c.collection} label={label(c)}>
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
  // Pinned + My favorites are "go to" shortcuts: while searching or filtering they step
  // aside — every match is already in the results below, with its pin and star.
  const showPinned = !narrowing && !state.arranging && !state.selecting
  const showQuick = folderView && showPinned
  const pinnedCols = sharedPins.pins.map((n) => byName.get(n)).filter((c): c is Collection => !!c)
  const favoriteCols = [...favorite].map((n) => byName.get(n)).filter((c): c is Collection => !!c)
  const recentCols = usage.recent
    .filter((n) => !favorite.has(n) && !pinnedSet.has(n))
    .map((n) => byName.get(n))
    .filter((c): c is Collection => !!c)
    .slice(0, 6)
  const showSuggestions =
    !!tools?.renderSuggestions && folderView && !filter && !chips.length && !state.arranging

  const jumpTargets = folderView
    ? [
        ...(showPinned && pinnedCols.length > 0
          ? [{ key: PINNED_KEY, label: 'Pinned', count: pinnedCols.length }]
          : []),
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
    // Grows with its content (shrink-0): the sticky toolbar only sticks inside this
    // box, so a viewport-tall box let it scroll away and left the folder headers
    // stuck below an empty gap.
    <div ref={pageRef} className='flex min-h-full shrink-0 flex-col' data-collections-directory>
      {/* Sticky from md up; on a phone it would hold a third of the screen. */}
      <div
        ref={toolbarRef}
        data-cdr=''
        className='z-10 md:[&[data-cdr]]:sticky md:[&[data-cdr]]:top-0'
      >
        <CollectionsToolbar
          state={state}
          onChange={onChange}
          filter={filter}
          onFilterChange={setFilter}
          filterRef={filterRef}
          counts={model.counts}
          isAdmin={isAdmin}
          title={title}
          canArrange={canArrange}
          canSelect={canSelect}
          selectedCount={selected.size}
          onMoveSelected={() => setMoveOpen(true)}
          onClearSelection={() => setSelected(new Set())}
          adminActions={tools?.toolbarActions ?? null}
        />
      </div>

      <div data-cdr='' className='flex gap-6 px-4 py-6 sm:[&[data-cdr]]:px-8'>
        <div className='min-w-0 flex-1 space-y-4'>
          {tools?.panels}
          {isLoading ? (
            <LoadingSkeleton />
          ) : isError && local.length === 0 ? (
            <ErrorNotice error={error} what='the collections' onRetry={() => void refetch()} />
          ) : model.real.length === 0 ? (
            <EmptyState />
          ) : model.shownCount === 0 && model.linkTables.length === 0 ? (
            <EmptySearch
              filter={filter.trim()}
              near={filter.trim() ? nearSpellings(filter, model.real) : []}
              pathFor={collectionPath}
              hiddenMatches={model.foldedMatches.hidden.length}
              linkMatches={model.foldedMatches.links.length}
              chipsOn={chips.length > 0}
              onShowHidden={() => onChange({ ...state, showHidden: true })}
              onShowLinks={() => onChange({ ...state, showLinks: true })}
              onClearChips={() => setChips([])}
              onCreate={tools?.onCreate}
            />
          ) : (
            <>
              {showPinned && (
                <PinnedSection
                  sectionId={sectionId(PINNED_KEY)}
                  cols={pinnedCols}
                  isAdmin={isAdmin}
                  status={sharedPins.status}
                  error={sharedPins.error}
                  onRetry={() => void sharedPins.refetch()}
                  onReorder={(names) => void sharedPins.reorder(names)}
                  collapsed={!!collapsed[PINNED_KEY]}
                  onToggle={() => toggleCollapse(PINNED_KEY)}
                  renderRow={(c, opts) =>
                    renderRow(c, opts.handle, {
                      onMoveUp: opts.onMoveUp,
                      onMoveDown: opts.onMoveDown,
                      inPinned: true
                    })
                  }
                />
              )}

              {showQuick && (
                <div className='space-y-2' data-collections-quick>
                  <QuickStrip
                    data-collections-favorites
                    title='My favorites'
                    icon={<Star className='h-3 w-3 fill-current' />}
                    cols={favoriteCols}
                    pathFor={collectionPath}
                    empty={
                      <span className='text-[12px] text-slate-500 dark:text-slate-400'>
                        {hostFavorites
                          ? 'Star a collection to keep it here and in your sidebar.'
                          : 'Star a collection to keep it here.'}
                      </span>
                    }
                  />
                  <QuickStrip
                    data-collections-recent
                    title='Recent'
                    icon={<Clock className='h-3 w-3' />}
                    cols={recentCols}
                    pathFor={collectionPath}
                  />
                </div>
              )}

              {showSuggestions &&
                tools?.renderSuggestions?.({
                  real: model.real,
                  folders: model.folders,
                  refresh
                })}

              {folderView ? (
                <>
                  {state.arranging ? (
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
                            <SortableRow
                              key={s.folder.key}
                              id={s.folder.key}
                              label={s.folder.label}
                            >
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

              {tools?.renderExtraSections?.({
                filter,
                collapsed,
                onToggle: toggleCollapse,
                renderSection: (s) => (
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
                )
              })}
            </>
          )}
        </div>

        {/* Jump to folder — wide screens only */}
        {jumpTargets.length > 2 && (
          <nav
            aria-label='Jump to folder'
            data-cdr=''
            className='hidden w-44 shrink-0 xl:[&[data-cdr]]:block'
          >
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

      {canSelect &&
        tools?.renderMoveDialog?.({
          open: moveOpen,
          onOpenChange: setMoveOpen,
          names: [...selected],
          folders: model.folders,
          onMoved: () => {
            setSelected(new Set())
            refresh()
          }
        })}
    </div>
  )
}
