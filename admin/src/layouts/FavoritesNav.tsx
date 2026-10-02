import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ChevronRight, FolderPlus, GripVertical, Star, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { iconForPath, isActiveRoute } from './nav-config'

/**
 * The reader's own shortcuts: pages they pin, in the order they choose, in
 * groups they name. Stored on the user's preferences (`nav_favorites` +
 * `nav_favorite_groups`) so the arrangement follows them between machines.
 *
 * Shape on disk: favorites are one ordered list, each carrying an optional
 * group name; `nav_favorite_groups` is the group ORDER and also keeps an empty
 * group alive while someone is still filling it. Pages with no group sit at
 * the top, above the first group.
 */

export type NavFavorite = { label: string; path: string; group: string | null }
export type FavoritesState = { items: NavFavorite[]; groups: string[] }

const COLLAPSED_KEY = 'nivaro-fav-collapsed'
const MAX_GROUP = 40
const MAX_GROUPS = 20
const MAX_FAVORITES = 60

function readPrefs(user: unknown): FavoritesState {
  const prefs = (user as { preferences?: Record<string, unknown> } | null)?.preferences ?? {}
  const rawGroups = Array.isArray(prefs.nav_favorite_groups) ? prefs.nav_favorite_groups : []
  const groups: string[] = []
  for (const g of rawGroups) {
    const name = typeof g === 'string' ? g.trim().slice(0, MAX_GROUP) : ''
    if (name && !groups.includes(name)) groups.push(name)
  }
  const rawItems = Array.isArray(prefs.nav_favorites) ? prefs.nav_favorites : []
  const items: NavFavorite[] = []
  for (const f of rawItems as Array<Record<string, unknown>>) {
    if (!f || typeof f.path !== 'string' || typeof f.label !== 'string') continue
    if (items.some((i) => i.path === f.path)) continue
    const group = typeof f.group === 'string' && groups.includes(f.group) ? f.group : null
    items.push({ label: f.label, path: f.path, group })
  }
  return { items, groups }
}

/** Ungrouped first, then each group's pages in group order — the one canonical order. */
function canonical(state: FavoritesState): FavoritesState {
  const items = [
    ...state.items.filter((i) => !i.group),
    ...state.groups.flatMap((g) => state.items.filter((i) => i.group === g))
  ]
  return { items, groups: state.groups }
}

const sameState = (a: FavoritesState, b: FavoritesState) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Favorites with optimistic saves. The panel and the pin button share one
 * instance (AppLayout owns it) so a drag never snaps back while the PATCH and
 * the /auth/me refetch are in flight.
 *
 * Organizing fires saves back to back (add a group, rename it, drag a page in).
 * Two rules keep that honest: PATCHes go out one at a time, in order, so the
 * server always ends on the newest arrangement; and the optimistic copy stays
 * on screen until the server's copy MATCHES it — an older /auth/me refetch
 * landing late can never repaint an earlier arrangement.
 */
export function useNavFavorites() {
  const { user, refetch } = useAuth()
  const fromServer = useMemo(() => canonical(readPrefs(user)), [user])
  const [pending, setPending] = useState<FavoritesState | null>(null)
  const seq = useRef(0)
  const chain = useRef<Promise<unknown>>(Promise.resolve())

  useEffect(() => {
    if (pending && sameState(pending, fromServer)) setPending(null)
  }, [pending, fromServer])

  const save = useCallback(
    (next: FavoritesState, message?: string) => {
      const mine = ++seq.current
      const clean = canonical(next)
      setPending(clean)
      const run = chain.current.then(async () => {
        try {
          await api.patch('/users/me/preferences', {
            nav_favorites: clean.items.map((i) => ({
              label: i.label,
              path: i.path,
              ...(i.group ? { group: i.group } : {})
            })),
            nav_favorite_groups: clean.groups
          })
          // Only the newest save refetches — earlier ones are already superseded.
          // Saves run strictly one after another (refetch included), so once
          // the newest refetch is back the server copy is the truth even if
          // it normalised something (a trimmed name) the optimistic copy kept.
          if (mine === seq.current) {
            await refetch()
            setPending((p) => (p === clean ? null : p))
          }
          if (message) toast.success(message)
        } catch {
          toast.error('Could not save favorites')
          // Drop the optimistic copy so the list shows what is really stored.
          if (mine === seq.current) setPending(null)
        }
      })
      chain.current = run
      return run
    },
    [refetch]
  )

  return { favorites: pending ?? fromServer, save }
}

type FavoritesApi = ReturnType<typeof useNavFavorites>

/** Star in the panel header: pin or unpin the page you are on. */
export function FavoritePinButton({
  favorites,
  save,
  onOrganize
}: FavoritesApi & { onOrganize: () => void }) {
  const location = useLocation()
  const here = location.pathname + location.search
  const pinned = favorites.items.some((f) => f.path === here)
  const [busy, setBusy] = useState(false)

  if (here === '/') return null

  const toggle = async () => {
    setBusy(true)
    try {
      if (pinned) {
        await save(
          { ...favorites, items: favorites.items.filter((f) => f.path !== here) },
          'Removed from favorites'
        )
        return
      }
      if (favorites.items.length >= MAX_FAVORITES) {
        toast.error(`Favorites hold up to ${MAX_FAVORITES} pages — remove one first`)
        return
      }
      // Name it what the page calls itself; a route is a poor label. It can be
      // renamed afterwards from Organize.
      const heading = document.querySelector('main h1')?.textContent?.trim()
      const label = (heading || document.title.split('|')[0].trim() || here).slice(0, 60)
      await save({ ...favorites, items: [...favorites.items, { label, path: here, group: null }] })
      toast.success('Added to favorites', {
        action: { label: 'Organize', onClick: onOrganize }
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type='button'
      disabled={busy}
      onClick={() => void toggle()}
      aria-pressed={pinned}
      aria-label={pinned ? 'Remove this page from favorites' : 'Add this page to favorites'}
      title={pinned ? 'Remove this page from favorites' : 'Add this page to favorites'}
      className='flex h-6 w-6 items-center justify-center rounded text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-nvr-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 disabled:opacity-50'
    >
      <Star
        className={cn('h-3.5 w-3.5', pinned && 'fill-nvr-cyan text-nvr-cyan')}
        strokeWidth={2}
      />
    </button>
  )
}

/** One link row — shared by every panel list so all rows look and behave the same. */
export function PanelLink({
  icon: Icon,
  label,
  to,
  onNavigate
}: {
  icon: React.ElementType
  label: string
  to: string
  onNavigate?: () => void
}) {
  const { pathname, search } = useLocation()
  // A favorite may carry a query (a saved filter); it is "here" only when the
  // query matches too, otherwise every filtered favorite of one list lights up.
  const active = to.includes('?') ? pathname + search === to : isActiveRoute(to, pathname)
  const t = useT()
  return (
    <Link
      to={to}
      viewTransition
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-2.5 px-4 py-[7px] text-[13px] font-medium leading-tight transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/60',
        active
          ? 'bg-nvr-cyan/[0.12] text-nvr-cyan'
          : 'text-slate-400 hover:bg-white/[0.05] hover:text-slate-200'
      )}
    >
      <Icon className={cn('h-[15px] w-[15px] shrink-0', active && 'text-nvr-cyan')} />
      <span className='min-w-0 truncate'>{t(`nav.${label}`, label)}</span>
    </Link>
  )
}

function readCollapsed(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

/** The Favorites panel body: read view, or Organize mode. */
export function FavoritesPanel({
  favorites,
  save,
  organizing,
  setOrganizing
}: FavoritesApi & { organizing: boolean; setOrganizing: (v: boolean) => void }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed)
  const { pathname } = useLocation()

  const toggleGroup = (g: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(g)) next.delete(g)
      else next.add(g)
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
      } catch {
        // per-browser convenience only
      }
      return next
    })
  }

  if (organizing) {
    return (
      <OrganizeFavorites favorites={favorites} save={save} onDone={() => setOrganizing(false)} />
    )
  }

  if (favorites.items.length === 0) {
    return (
      <div className='px-4 py-2 text-[12px] leading-relaxed text-slate-400'>
        <p className='font-medium text-slate-300'>Keep the pages you use every day here.</p>
        <p className='mt-1.5'>
          Open a page and click
          <Star className='mx-1 inline h-3 w-3 -translate-y-px' strokeWidth={2} />
          next to the panel title. Name groups and reorder them with Organize.
        </p>
        {favorites.groups.length > 0 && (
          <button
            type='button'
            onClick={() => setOrganizing(true)}
            className='mt-3 text-[12px] font-medium text-nvr-cyan hover:underline'
          >
            Organize
          </button>
        )}
      </div>
    )
  }

  const ungrouped = favorites.items.filter((i) => !i.group)

  return (
    <div>
      <div className='space-y-0.5'>
        {ungrouped.map((f) => (
          <PanelLink key={f.path} icon={iconForPath(f.path) ?? Star} label={f.label} to={f.path} />
        ))}
      </div>
      {favorites.groups.map((g, gi) => {
        const items = favorites.items.filter((i) => i.group === g)
        const isOpen = !collapsed.has(g)
        // A closed group still says when the current page is inside it.
        const holdsHere =
          !isOpen && items.some((i) => isActiveRoute(i.path.split('?')[0], pathname))
        const bodyId = `fav-group-${gi}`
        return (
          <div key={g} className={cn(ungrouped.length > 0 || gi > 0 ? 'mt-3' : 'mt-0.5')}>
            <button
              type='button'
              onClick={() => toggleGroup(g)}
              aria-expanded={isOpen}
              aria-controls={bodyId}
              className='group/gh flex w-full items-center gap-1.5 px-4 pb-1 pt-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/60'
            >
              <ChevronRight
                className={cn(
                  'h-3 w-3 shrink-0 text-slate-500 transition-transform duration-150 motion-reduce:transition-none group-hover/gh:text-slate-300',
                  isOpen && 'rotate-90'
                )}
              />
              <span className='min-w-0 flex-1 truncate text-[11px] font-semibold text-slate-400 group-hover/gh:text-slate-200'>
                {g}
              </span>
              {holdsHere && (
                <span className='h-1.5 w-1.5 shrink-0 rounded-full bg-nvr-cyan' aria-hidden />
              )}
              {!isOpen && (
                <span className='shrink-0 text-[11px] tabular-nums text-slate-500'>
                  {items.length}
                </span>
              )}
            </button>
            {isOpen && (
              <div id={bodyId} className='space-y-0.5'>
                {items.length === 0 ? (
                  <p className='px-4 py-1 pl-[34px] text-[11px] italic text-slate-500'>
                    Empty group
                  </p>
                ) : (
                  items.map((f) => (
                    <PanelLink
                      key={f.path}
                      icon={iconForPath(f.path) ?? Star}
                      label={f.label}
                      to={f.path}
                    />
                  ))
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Organize mode ────────────────────────────────────────────────────────

type Entry =
  | { kind: 'item'; id: string; fav: NavFavorite }
  | { kind: 'group'; id: string; name: string }

const itemId = (path: string) => `i:${path}`
const groupId = (name: string) => `g:${name}`

function toEntries(state: FavoritesState): Entry[] {
  return [
    ...state.items
      .filter((i) => !i.group)
      .map((fav): Entry => ({ kind: 'item', id: itemId(fav.path), fav })),
    ...state.groups.flatMap((name): Entry[] => [
      { kind: 'group', id: groupId(name), name },
      ...state.items
        .filter((i) => i.group === name)
        .map((fav): Entry => ({ kind: 'item', id: itemId(fav.path), fav }))
    ])
  ]
}

/** A page belongs to the nearest group header above it; none above = ungrouped. */
function fromEntries(entries: Entry[]): FavoritesState {
  const groups: string[] = []
  const items: NavFavorite[] = []
  let current: string | null = null
  for (const e of entries) {
    if (e.kind === 'group') {
      current = e.name
      groups.push(e.name)
    } else {
      items.push({ ...e.fav, group: current })
    }
  }
  return { items, groups }
}

function OrganizeFavorites({
  favorites,
  save,
  onDone
}: {
  favorites: FavoritesState
  save: FavoritesApi['save']
  onDone: () => void
}) {
  const entries = useMemo(() => toEntries(favorites), [favorites])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [focusGroup, setFocusGroup] = useState<string | null>(null)
  const draggingGroup = activeId?.startsWith('g:') ?? false

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  // While a group moves, the list folds to group headings so it travels as a
  // block and cannot land in the middle of another group.
  const visible = draggingGroup ? entries.filter((e) => e.kind === 'group') : entries
  const ids = visible.map((e) => e.id)

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id))
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null)
    const { active, over } = e
    if (!over || active.id === over.id) return
    if (String(active.id).startsWith('g:')) {
      const from = favorites.groups.indexOf(String(active.id).slice(2))
      const to = favorites.groups.indexOf(String(over.id).slice(2))
      if (from < 0 || to < 0) return
      void save({ ...favorites, groups: arrayMove(favorites.groups, from, to) })
      return
    }
    const from = entries.findIndex((x) => x.id === active.id)
    const to = entries.findIndex((x) => x.id === over.id)
    if (from < 0 || to < 0) return
    void save(fromEntries(arrayMove(entries, from, to)))
  }

  const renameItem = (path: string, label: string) => {
    const clean = label.trim().slice(0, 60)
    const cur = favorites.items.find((i) => i.path === path)
    if (!clean || !cur || cur.label === clean) return
    void save({
      ...favorites,
      items: favorites.items.map((i) => (i.path === path ? { ...i, label: clean } : i))
    })
  }

  const renameGroup = (from: string, to: string) => {
    const clean = to.trim().slice(0, MAX_GROUP)
    if (!clean || clean === from) return
    if (favorites.groups.includes(clean)) {
      toast.error(`There is already a group called “${clean}”`)
      return
    }
    void save({
      groups: favorites.groups.map((g) => (g === from ? clean : g)),
      items: favorites.items.map((i) => (i.group === from ? { ...i, group: clean } : i))
    })
  }

  const removeItem = (path: string) =>
    void save({ ...favorites, items: favorites.items.filter((i) => i.path !== path) })

  // Removing a group keeps its pages — they move up to the ungrouped list.
  const removeGroup = (name: string) =>
    void save({
      groups: favorites.groups.filter((g) => g !== name),
      items: favorites.items.map((i) => (i.group === name ? { ...i, group: null } : i))
    })

  const addGroup = () => {
    if (favorites.groups.length >= MAX_GROUPS) {
      toast.error(`Up to ${MAX_GROUPS} groups`)
      return
    }
    let name = 'New group'
    for (let n = 2; favorites.groups.includes(name); n++) name = `New group ${n}`
    setFocusGroup(name)
    void save({ ...favorites, groups: [...favorites.groups, name] })
  }

  return (
    <div className='flex flex-col'>
      <p className='px-4 pb-2.5 pt-1 text-[11px] leading-snug text-slate-400'>
        Drag the handles to reorder. Drop a page under a group to file it there.
      </p>
      {favorites.groups.length > 0 && favorites.items.some((i) => !i.group) && !draggingGroup && (
        <p className='px-4 pb-1 text-[11px] font-medium text-slate-500'>Not in a group</p>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <ul className='relative space-y-px' aria-label='Favorites, in order'>
            {visible.map((e, idx) =>
              e.kind === 'group' ? (
                <SortableGroupRow
                  key={e.id}
                  id={e.id}
                  name={e.name}
                  first={idx === 0}
                  empty={!draggingGroup && visible[idx + 1]?.kind !== 'item'}
                  autoFocus={focusGroup === e.name}
                  onRename={(v) => {
                    setFocusGroup(null)
                    renameGroup(e.name, v)
                  }}
                  onRemove={() => removeGroup(e.name)}
                />
              ) : (
                <SortableItemRow
                  key={e.id}
                  id={e.id}
                  fav={e.fav}
                  onRename={(v) => renameItem(e.fav.path, v)}
                  onRemove={() => removeItem(e.fav.path)}
                />
              )
            )}
          </ul>
        </SortableContext>
      </DndContext>
      <div className='mt-3 flex items-center justify-between gap-2 px-4'>
        <button
          type='button'
          onClick={addGroup}
          className='flex items-center gap-1.5 rounded px-1 py-1 -ml-1 text-[12px] font-medium text-slate-300 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60'
        >
          <FolderPlus className='h-3.5 w-3.5' />
          New group
        </button>
        <button
          type='button'
          onClick={onDone}
          className='rounded bg-nvr-cyan px-2.5 py-1 text-[12px] font-semibold text-white transition-[filter] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70'
        >
          Done
        </button>
      </div>
    </div>
  )
}

/** Text field that commits on Enter / blur and reverts on Escape. */
function InlineName({
  value,
  ariaLabel,
  autoFocus,
  className,
  onCommit
}: {
  value: string
  ariaLabel: string
  autoFocus?: boolean
  className?: string
  onCommit: (v: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => setDraft(value), [value])
  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus()
      ref.current?.select()
    }
  }, [autoFocus])
  return (
    <input
      ref={ref}
      value={draft}
      aria-label={ariaLabel}
      maxLength={60}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => (draft.trim() ? onCommit(draft) : setDraft(value))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setDraft(value)
          requestAnimationFrame(() => ref.current?.blur())
        }
      }}
      className={cn(
        'min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 py-[3px] text-[13px] text-slate-200 outline-none transition-colors hover:border-white/10 focus:border-nvr-cyan/60 focus:bg-white/[0.06]',
        className
      )}
    />
  )
}

function useRowStyle(id: string) {
  const s = useSortable({ id })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(s.transform),
    transition: s.transition,
    zIndex: s.isDragging ? 2 : undefined
  }
  return { ...s, style }
}

function Handle({
  label,
  attributes,
  listeners,
  setActivatorNodeRef
}: {
  label: string
  attributes: ReturnType<typeof useSortable>['attributes']
  listeners: ReturnType<typeof useSortable>['listeners']
  setActivatorNodeRef: (el: HTMLElement | null) => void
}) {
  return (
    <button
      type='button'
      ref={setActivatorNodeRef}
      {...attributes}
      {...listeners}
      aria-label={label}
      className='flex h-6 w-4 shrink-0 cursor-grab touch-none items-center justify-center rounded text-slate-500 transition-colors hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 active:cursor-grabbing'
    >
      <GripVertical className='h-3.5 w-3.5' />
    </button>
  )
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type='button'
      onClick={onClick}
      aria-label={label}
      title={label}
      className='flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60'
    >
      <X className='h-3.5 w-3.5' />
    </button>
  )
}

function SortableItemRow({
  id,
  fav,
  onRename,
  onRemove
}: {
  id: string
  fav: NavFavorite
  onRename: (v: string) => void
  onRemove: () => void
}) {
  const { setNodeRef, style, isDragging, attributes, listeners, setActivatorNodeRef } =
    useRowStyle(id)
  const Icon = iconForPath(fav.path) ?? Star
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        'flex items-center gap-1 py-[2px] pl-1.5 pr-2',
        isDragging ? 'rounded bg-[#22385a] shadow-lg ring-1 ring-nvr-cyan/40' : ''
      )}
    >
      <Handle
        label={`Reorder ${fav.label}`}
        attributes={attributes}
        listeners={listeners}
        setActivatorNodeRef={setActivatorNodeRef}
      />
      <Icon className='ml-0.5 h-[15px] w-[15px] shrink-0 text-slate-500' />
      <InlineName value={fav.label} ariaLabel={`Name for ${fav.path}`} onCommit={onRename} />
      <RemoveButton label={`Remove ${fav.label} from favorites`} onClick={onRemove} />
    </li>
  )
}

function SortableGroupRow({
  id,
  name,
  first,
  empty,
  autoFocus,
  onRename,
  onRemove
}: {
  id: string
  name: string
  first: boolean
  empty: boolean
  autoFocus: boolean
  onRename: (v: string) => void
  onRemove: () => void
}) {
  const { setNodeRef, style, isDragging, attributes, listeners, setActivatorNodeRef } =
    useRowStyle(id)
  return (
    <li ref={setNodeRef} style={style} className={cn(!first && 'pt-2.5')}>
      <div
        className={cn(
          'flex items-center gap-1 border-t border-white/[0.08] pb-[2px] pl-1.5 pr-2 pt-2',
          first && 'border-t-0 pt-0',
          isDragging && 'rounded border-t-0 bg-[#22385a] shadow-lg ring-1 ring-nvr-cyan/40'
        )}
      >
        <Handle
          label={`Move group ${name}`}
          attributes={attributes}
          listeners={listeners}
          setActivatorNodeRef={setActivatorNodeRef}
        />
        <InlineName
          value={name}
          ariaLabel={`Group name: ${name}`}
          autoFocus={autoFocus}
          onCommit={onRename}
          className='text-[12px] font-semibold text-white'
        />
        <RemoveButton label={`Remove group ${name} (its pages stay)`} onClick={onRemove} />
      </div>
      {empty && (
        <p className='py-1 pl-[34px] pr-2 text-[11px] italic text-slate-500'>Drag pages here</p>
      )}
    </li>
  )
}
