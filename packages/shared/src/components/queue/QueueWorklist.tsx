import { TickerNumber } from '../TickerNumber'
import { EmptyState } from '../EmptyState'
import { useElapsedLoading } from '../../hooks/useElapsedLoading'
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Eye, Inbox,
  AlertTriangle,
  ChevronDown,
  Filter,
  Flame,
  GripVertical,
  PanelLeftClose,
  Pin,
  Play,
  Plus,
  RefreshCw,
  Rows2,
  Rows3,
  Rows4,
  Save,
  SlidersHorizontal,
  Star,
  X
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import {
  type DrilldownTarget,
  useItemEditAuth,
  useItemNavigation,
  useNavigation,
  useNivaroClient,
  useOverlayState
} from '../../context'
import { useDebounced } from '../../hooks/useDebounced'
import { del, get, patch, post, put } from '../../lib/commands'
import { evaluateExpression } from '../../lib/expression'
import { RowActionsMenu } from '../CollectionBrowserView'
import { type ColumnFormatConfig, formatMultiValue } from '../../lib/format-value'
import { buildGroups } from '../../lib/queue-grouping'
import { rowHighlightClass, rowHighlightTextClass } from '../../lib/row-highlight'
import { RowHighlightLegend } from '../RowHighlightLegend'
import { titleCase, cn, formatDate, formatDateTime, formatNumber, humanHours } from '../../lib/utils'
import { useNewItemLayouts } from '../../lib/use-new-item-layouts'
import { effectiveScopeSeedIds, matchScopeDimension, useMyScopes } from '../../lib/use-my-scopes'
import {
  type Column,
  DataTable,
  FilterControl,
  type FilterDef,
  filterDefLabel,
  filterValueDisplay
} from '../DataTable'
import { ImportFromFileButton } from '../import/ImportFromFileButton'
import { RecordDrilldownSheet } from '../RecordDrilldownSheet'
import { Badge } from '../ui/badge'
import { Checkbox } from '../ui/checkbox'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '../ui/command'
import { Label } from '../ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Skeleton } from '../ui/skeleton'
import { OwnerAvatars } from './OwnerAvatars'
import { QueueBulkBar } from './QueueBulkBar'
import { QueueItemSheet } from './QueueItemSheet'
import { QueueKanbanBoard } from './QueueKanbanBoard'
import { QueueWorkloadView } from './QueueWorkloadView'

/** Root drill entry may pin a grouped layout; nested levels never do. */
type DrillEntry = DrilldownTarget & { rootLayoutSlug?: string | null }

// ─── Props ──────────────────────────────────────────────────────────────────

export interface QueueRealtimeAdapter {
  /** Subscribe to update events for these collections; call onUpdate per event; return unsubscribe. */
  subscribe: (collections: string[], onUpdate: () => void) => () => void
}

export interface QueueWorklistProps {
  queueId: string
  realtime?: QueueRealtimeAdapter
  renderError?: (status: number) => React.ReactNode
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface QueueOwner {
  id: string
  name: string
}

export interface QueueItemRow {
  collection: string
  item_id: string
  label: string
  state: string | null
  state_color: string | null
  owners: QueueOwner[]
  sla_status: 'ok' | 'warning' | 'breached' | null
  at_risk: boolean
  at_risk_color?: string | null
  predicted_risk?: boolean
  predicted_note?: string | null
  aging_hours: number | null
  claimed_by: QueueOwner | null
  extra?: Record<string, unknown>
  extra_ids?: Record<string, string[]>
  labels?: string[]
  url: string
}

interface QueueStats {
  total: number
  by_state: Record<string, number>
  unowned: number
  sla_warning: number
  sla_breached: number
  at_risk: number
  aging?: { d1: number; d3: number; d7: number; over: number }
}

interface QueueSource {
  id: number
  type: 'collection' | 'tasks' | 'approvals' | 'owned_by_me'
  collection: string | null
  drilldown?: Record<
    string,
    { enabled?: boolean; layout_id?: number | null; width?: number | string | null }
  >
  column_formats?: Record<string, ColumnFormatConfig>
}

interface ExtraFieldMeta {
  path: string
  kind: 'relation' | 'plain'
  relation_type?: 'm2o' | 'm2m' | 'o2m'
  target_collection?: string
  display_field?: string
  aggregate?: string
}

interface QueueMeta {
  id: string
  name: string
  description: string | null
  owner?: string | null
  materialized: boolean
  claims_enabled: boolean
  column_aliases?: Record<string, string>
  sources?: QueueSource[]
  available_extra_fields?: string[]
  extra_field_meta?: ExtraFieldMeta[]
  display_config?: {
    views: Array<'table' | 'kanban' | 'workload'>
    default_view: 'table' | 'kanban' | 'workload'
    default_scope: 'mine' | 'unowned' | 'all'
    work_next: boolean
    bulk_actions: boolean
    row_click: 'preview' | 'layout' | 'full'
    item_layout: string | null
    sheet_width: number | string | null
    default_columns?: string[] | null
    default_pins?: Record<string, 'left' | 'right'> | null
    priority_weights?: {
      sla_warning: number
      sla_breached: number
      at_risk: number
      age_hour_cap: number
    } | null
    formula_columns?: Array<{
      key: string
      label: string
      formula: string
      format?: 'currency' | 'number' | null
    }> | null
  }
}

type Scope = 'mine' | 'unowned' | 'all' | 'claimed'

interface QueueView {
  id: number
  name: string
  user: string
  is_shared: boolean
  is_default?: boolean
  state: {
    scope?: Scope
    filters?: Record<string, string>
    sort?: string
    group_by?: string | null
    view?: 'table' | 'kanban' | 'workload'
    /** Ordered visible columns; null/absent = follow the queue's default columns. */
    columns?: string[] | null
    /** Per-column pin sides; null/absent = default (first column pinned left). */
    pins?: Record<string, 'left' | 'right'> | null
  } | null
}

const SCOPE_TABS: { value: Scope; label: string }[] = [
  { value: 'mine', label: 'My Items' },
  { value: 'unowned', label: 'No Owners' },
  { value: 'claimed', label: 'Claimed by me' },
  { value: 'all', label: 'All Items' }
]

function formatAging(hours: number | null): string {
  return humanHours(hours)
}

function SlaPill({ status }: { status: QueueItemRow['sla_status'] }) {
  if (!status) return <span className='text-slate-300'>—</span>
  const cls =
    status === 'breached'
      ? 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400'
      : status === 'warning'
        ? 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400'
        : 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400'
  return <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', cls)}>{status}</span>
}

function Sparkline({ points, inline = false }: { points: number[]; inline?: boolean }) {
  if (points.length < 2) return null
  const w = inline ? 40 : 64
  const h = inline ? 14 : 18
  const max = Math.max(...points)
  const min = Math.min(...points)
  const range = max - min || 1
  const step = w / (points.length - 1)
  const path = points
    .map(
      (v, i) =>
        `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - 2 - ((v - min) / range) * (h - 4)).toFixed(1)}`
    )
    .join(' ')
  return (
    <svg
      width={w}
      height={h}
      className={inline ? 'opacity-40' : 'mt-1.5 opacity-40'}
      aria-hidden='true'
    >
      <path d={path} fill='none' stroke='currentColor' strokeWidth='1.5' />
    </svg>
  )
}

function StatTile({
  label,
  count,
  filteredCount,
  active,
  isLoading,
  tone,
  trend,
  delta,
  deltaBadIsUp,
  onClick
}: {
  label: string
  count: number
  /** Count over the active column filters — renders as "277 / 504" when set. */
  filteredCount?: number | null
  active: boolean
  isLoading?: boolean
  tone?: 'amber' | 'red'
  trend?: number[]
  delta?: number | null
  /** When true a rising delta renders red and a falling one green (breached/at-risk style). */
  deltaBadIsUp?: boolean
  onClick: () => void
}) {
  // Compact segment: "504 Total" on one line — number leads, label trails,
  // delta + sparkline inline. Zero-count segments dim so live signals carry
  // the visual weight.
  return (
    <button
      type='button'
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 bg-white px-3 py-2 text-left transition-colors hover:bg-slate-50 dark:bg-card dark:hover:bg-card/80',
        active && 'bg-nvr-cyan/5 ring-1 ring-inset ring-nvr-cyan dark:bg-nvr-cyan/10',
        !active && !isLoading && count === 0 && 'opacity-50'
      )}
    >
      {isLoading ? (
        <Skeleton className='h-5 w-16 rounded' />
      ) : (
        <>
          <span className='flex items-baseline gap-1 text-[15px] font-semibold leading-none tabular-nums text-slate-900 dark:text-foreground'>
            {filteredCount != null ? (
              <>
                <span className='text-nvr-navy dark:text-nvr-cyan'>
                  <TickerNumber value={filteredCount} format={formatNumber} />
                </span>
                <span className='text-[11px] font-medium text-slate-400'>
                  / <TickerNumber value={count} format={formatNumber} />
                </span>
              </>
            ) : (
              <TickerNumber value={count} format={formatNumber} />
            )}
          </span>
          <span
            className={cn(
              'text-[11px] font-medium leading-none',
              tone === 'red'
                ? 'text-red-500 dark:text-red-400'
                : tone === 'amber'
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-slate-400 dark:text-muted-foreground'
            )}
          >
            {label}
          </span>
          {delta != null && delta !== 0 && (
            <span
              className={cn(
                'text-[10px] font-medium leading-none',
                deltaBadIsUp ? (delta > 0 ? 'text-red-500' : 'text-emerald-600') : 'text-slate-400'
              )}
            >
              {delta > 0 ? '↑' : '↓'}
              {formatNumber(Math.abs(delta))}
            </span>
          )}
          {trend && count > 0 && <Sparkline points={trend} inline />}
        </>
      )}
    </button>
  )
}

function StateChip({
  label,
  count,
  filteredCount,
  color,
  active,
  onClick
}: {
  label: string
  count: number
  filteredCount?: number | null
  color: string | null
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors',
        active
          ? 'border-nvr-cyan bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
          : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50 dark:border-border dark:bg-card dark:text-slate-300'
      )}
    >
      <span
        className='h-2 w-2 shrink-0 rounded-full'
        style={{ backgroundColor: color ?? '#94a3b8' }}
      />
      {label}
      <span className='font-semibold tabular-nums text-slate-900 dark:text-foreground'>
        {filteredCount != null ? (
          <>
            <span className='text-nvr-navy dark:text-nvr-cyan'>{formatNumber(filteredCount)}</span>
            <span className='font-normal text-slate-400'> / {formatNumber(count)}</span>
          </>
        ) : (
          formatNumber(count)
        )}
      </span>
    </button>
  )
}

function formatColumnHeader(path: string): string {
  return path
    .split('.')
    .map((seg) => seg.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()))
    .join(' → ')
}

function SortableColumnToggle({
  id,
  label,
  checked,
  onCheckedChange
}: {
  id: string
  label: string
  checked: boolean
  onCheckedChange: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1
  }
  const inputId = `col-toggle-${id}`
  return (
    <div ref={setNodeRef} style={style} className='flex items-center gap-2 text-[12px]'>
      <span
        {...attributes}
        {...listeners}
        className='cursor-grab text-slate-300 hover:text-slate-500 dark:text-muted-foreground'
      >
        <GripVertical className='h-3.5 w-3.5' />
      </span>
      <Checkbox id={inputId} checked={checked} onCheckedChange={onCheckedChange} />
      <Label htmlFor={inputId} className='cursor-pointer text-[12px] font-normal'>
        {label}
      </Label>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function QueueWorklist({ queueId, realtime, renderError }: QueueWorklistProps) {
  const qc = useQueryClient()
  const client = useNivaroClient()
  const { userId } = useItemEditAuth()
  const itemNav = useItemNavigation()
  const { navigate } = useNavigation()
  const [scope, setScope] = useState<Scope>('all')
  const [page, setPage] = useState(1)
  // Row density — shares the per-browser preference the collection browser uses.
  const [density, setDensity] = useState<'compact' | 'comfortable'>(() => {
    try {
      return localStorage.getItem('nvr_table_density') === 'comfortable' ? 'comfortable' : 'compact'
    } catch {
      return 'compact'
    }
  })
  const [view, setView] = useState<'table' | 'kanban' | 'workload'>('table')
  const [sort, setSort] = useState('')
  const [filterValues, setFilterValues] = useState<Record<string, string | string[]>>({})

  // Single serializable value so Phase 3 saved views can persist it without rework.
  const [groupBy, setGroupBy] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [swimlaneBy, setSwimlaneBy] = useState<'collection' | 'owners' | null>(null)
  // Per-column pinning (CBV parity) — null = default (first column pinned left).
  // Session state, snapshotted into saved views as `pins`.
  const [columnPins, setColumnPins] = useState<Record<string, 'left' | 'right'> | null>(null)
  // Socket-driven updates no longer refetch under the user — they accumulate here
  // and surface as a "N updates · Refresh" pill the user triggers explicitly.
  const [pendingUpdates, setPendingUpdates] = useState(0)
  const limit = 25

  const { data: queue, error: queueError } = useQuery<QueueMeta>({
    queryKey: ['queue-meta', queueId],
    queryFn: () =>
      client.request<{ data: QueueMeta }>(get(`/queues/${queueId}`)).then((r) => r.data),
    enabled: !!queueId
  })

  // Seed relation extra-column filters from the user's scope defaults /
  // restrictions — same behavior CollectionBrowserView has: a Zone-restricted
  // user opens the queue already narrowed to their zone. Runs once, never
  // overrides values a saved view or the user already set. Queue filters
  // compare resolved DISPLAY values, so seed ids translate through the
  // column's own display field.
  const { scopes: myScopes, ready: myScopesReady } = useMyScopes()
  const scopeSeededRef = useRef(false)
  // The items query is GATED until scope seeding settles — the first fetch
  // must already carry the seeded restricted filters (CBV precedent), never
  // an unfiltered flash of everything.
  const [scopeGateOpen, setScopeGateOpen] = useState(false)
  // Restricted dimensions also NARROW the option lists (main filter rail AND
  // the column filter row share these defs) — a Zone-restricted user must not
  // even see other zones as choices. Keyed by extra path → allowed display values.
  const [allowedValuesByPath, setAllowedValuesByPath] = useState<Record<string, string[]>>({})
  // The seeded scope filters survive view switches: 'Default' resets back to
  // these, never to a truly empty filter set (that would drop the user's
  // default/restricted dimensions).
  const seededFiltersRef = useRef<Record<string, string[]>>({})
  useEffect(() => {
    if (scopeSeededRef.current || !myScopesReady || !queue) return
    scopeSeededRef.current = true
    const metas = (queue.extra_field_meta ?? []).filter(
      (m) => m.kind === 'relation' && m.target_collection && m.display_field
    )
    if (metas.length === 0 || !myScopes) {
      setScopeGateOpen(true)
      return
    }
    void (async () => {
      const patch: Record<string, string[]> = {}
      const allowed: Record<string, string[]> = {}
      const displayValuesFor = async (m: (typeof metas)[number], ids: Array<string | number>) => {
        const res = await client.request<{ data: Array<Record<string, unknown>> }>(
          get(`/items/${m.target_collection}`, {
            filter: JSON.stringify({ id: { _in: ids } }),
            fields: `id,${m.display_field}`,
            limit: '200'
          })
        )
        return [...new Set(
          (res.data ?? []).map((r) => String(r[m.display_field as string] ?? '')).filter(Boolean)
        )]
      }
      for (const m of metas) {
        const dim = matchScopeDimension(myScopes, { collection: m.target_collection })
        if (!dim) continue
        const key = `extra.${m.path}`
        try {
          // Narrowing: the RESTRICTED set (not defaults) bounds what's pickable
          const restrictedIds = myScopes.restricted[dim.name] ?? []
          if (restrictedIds.length > 0) {
            const vals = await displayValuesFor(m, restrictedIds)
            if (vals.length > 0) allowed[key.slice('extra.'.length)] = vals
          }
          // Seeding: defaults ∩ restriction pre-fill the filter once
          const ids = effectiveScopeSeedIds(myScopes, dim.name)
          if (ids.length === 0) continue
          const existing = filterValues[key]
          if (existing && (Array.isArray(existing) ? existing.length > 0 : existing !== '')) continue
          const vals = ids.length ? await displayValuesFor(m, ids) : []
          if (vals.length > 0) patch[key] = vals
        } catch {
          /* scope seeding is best-effort — an unreadable target just skips */
        }
      }
      if (Object.keys(allowed).length > 0) setAllowedValuesByPath(allowed)
      if (Object.keys(patch).length > 0) {
        seededFiltersRef.current = patch
        setFilterValues((prev) => ({ ...prev, ...patch }))
      }
      setScopeGateOpen(true)
    })()
  }, [myScopesReady, myScopes, queue])

  // Import-from-file entry point targets the first collection-type source —
  // same rule the item_layout builder list uses (admin/src/pages/Queues.tsx).
  const importCollection = queue?.sources?.find((s) => s.type === 'collection')?.collection ?? null

  // Collections this queue draws from, so someone can add work to it without
  // leaving for the collection browser. Curation, not security — the same
  // posture as the browser's own New button: the items service still enforces
  // create permission on save.
  const creatableCollections = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const src of queue?.sources ?? []) {
      if (src.type !== 'collection' || !src.collection) continue
      if (seen.has(src.collection)) continue
      seen.add(src.collection)
      out.push(src.collection)
    }
    return out
  }, [queue?.sources])
  // Layout choices for the single-collection New button (slug-opt-in) —
  // plain button when the collection has no alternative layouts.
  const newItemLayouts = useNewItemLayouts(
    creatableCollections.length === 1 ? creatableCollections[0] : null
  )

  // Every queue defaults to priority order — the table's default order IS the
  // triage order. Materialized queues serve priority sorts from a narrow scan
  // of the cache (computeSla in JS), not the old full live resolve.
  const claimsEnabled = queue?.claims_enabled !== false
  const displayConfig = queue?.display_config
  const allowedViews = displayConfig?.views ?? ['table', 'kanban', 'workload']
  const workNextEnabled = displayConfig?.work_next !== false
  const bulkActionsEnabled = displayConfig?.bulk_actions !== false
  const aliasFor = (key: string, fallback: string): string =>
    queue?.column_aliases?.[key]?.trim() || fallback

  const defaultSortApplied = useRef(false)
  useEffect(() => {
    if (!queue || defaultSortApplied.current) return
    defaultSortApplied.current = true
    setSort('-priority')
  }, [queue])

  // Apply the queue's configured default view + scope once, when meta loads.
  // Until then the page holds chrome + the items query, so the configured
  // defaults never flash-in over the hard-coded initial state (and the items
  // query never fires once with the wrong scope only to refire).
  const [displayReady, setDisplayReady] = useState(false)
  // The load gate that applies the viewer's default saved view (or the queue's
  // general default) is defined below, after `views`/`applyView` are declared.

  // If the current view was removed from the queue's allowed views, snap back.
  useEffect(() => {
    if (queue?.display_config && !allowedViews.includes(view)) setView(allowedViews[0])
  }, [queue, view, allowedViews])

  // Live-refresh: subscribe to update events for this queue's collection-type
  // sources via the host-injected realtime adapter (socket.io on the admin
  // side); accumulate pending updates rather than auto-refetching, surfaced as
  // a "N updates · Refresh" pill the user triggers explicitly.
  useEffect(() => {
    if (!realtime || !queue?.sources) return
    const collections = [
      ...new Set(
        queue.sources
          .filter((s) => s.type === 'collection' && s.collection)
          .map((s) => s.collection as string)
      )
    ]
    if (collections.length === 0) return
    return realtime.subscribe(collections, () => setPendingUpdates((n) => n + 1))
  }, [realtime, queue?.sources])

  // Inputs stay bound to filterValues (instant UI); the items query keys off
  // this trailing copy so text filters don't fire a request per keystroke.
  const debouncedFilterValues = useDebounced(filterValues, 350)

  const apiFilters = (() => {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(debouncedFilterValues)) {
      if (!value) continue
      if (Array.isArray(value)) {
        if (value.length > 0) out[key] = value
        continue
      }
      if (key === 'aging_hours') {
        const [min, max] = value.split(':')
        const range: { min?: number; max?: number } = {}
        if (min) range.min = Number(min)
        if (max) range.max = Number(max)
        if (range.min !== undefined || range.max !== undefined) out[key] = range
        continue
      }
      out[key] = value
    }
    return out
  })()

  function toggleTileFilter(key: string, value: string) {
    setFilterValues((prev) => ({ ...prev, [key]: prev[key] === value ? '' : value }))
    setPage(1)
  }

  // Multiselect-aware toggle for the state chips — membership in the array.
  function toggleStateChip(state: string) {
    setFilterValues((prev) => {
      const current = prev.state
      const list = Array.isArray(current) ? current : current ? [current] : []
      const next = list.includes(state) ? list.filter((v) => v !== state) : [...list, state]
      return { ...prev, state: next }
    })
    setPage(1)
  }

  const stateFilterList = Array.isArray(filterValues.state)
    ? filterValues.state
    : filterValues.state
      ? [filterValues.state]
      : []

  const isFilterEmpty = (v: string | string[] | undefined) =>
    !v || (Array.isArray(v) && v.length === 0)

  function clearAllTileFilters() {
    setFilterValues({ ...seededFiltersRef.current })
    setScope('all')
    setPage(1)
  }

  // Column filters live in a collapsible left rail (the inline per-column row
  // stopped scaling past ~8 columns). Open state persists per queue.
  const [filtersOpen, setFiltersOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(`nivaro_queue_filters_open:${queueId}`) === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(`nivaro_queue_filters_open:${queueId}`, filtersOpen ? '1' : '0')
    } catch {
      /* private mode */
    }
  }, [filtersOpen, queueId])
  const activeFilterCount = Object.values(filterValues).filter((v) => !isFilterEmpty(v)).length

  // Saved-view arrival subscriptions (#379): my instant subs on this queue.
  const { data: myQueueSubs = [] } = useQuery<
    Array<{ id: number; queue_id: string | null; queue_view_id: number | null }>
  >({
    queryKey: ['queue-view-subs', queueId],
    queryFn: () =>
      client
        .request<{
          data: Array<{ id: number; queue_id: string | null; queue_view_id: number | null }>
        }>(get('/notification-subscriptions'))
        .then((r) => (r.data ?? []).filter((sub) => sub.queue_id === queueId))
        .catch(() => []),
    staleTime: 30_000
  })
  const viewSubFor = (viewId: number) => myQueueSubs.find((sub) => sub.queue_view_id === viewId)
  const toggleViewSub = (viewId: number) => {
    const existing = viewSubFor(viewId)
    const req = existing
      ? client.request(del(`/notification-subscriptions/${existing.id}`))
      : client.request(
          post('/notification-subscriptions', {
            queue_id: queueId,
            queue_view_id: viewId,
            digest_frequency: 'instant'
          })
        )
    void req
      .then(() => {
        toast.success(existing ? 'Unsubscribed' : 'Subscribed — new arrivals in this view notify you')
        void qc.invalidateQueries({ queryKey: ['queue-view-subs', queueId] })
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Failed'))
  }

  // Drillable aggregates (#394): which aggregate cell is open.
  const [aggDrill, setAggDrill] = useState<{
    row: QueueItemRow
    path: string
    value: string
  } | null>(null)

  // Custom actions (#125): per-collection registered actions surfaced in the
  // row menu; guards re-checked server-side at execute.
  const actionCollections = [
    ...new Set(
      (queue?.sources ?? [])
        .filter((sr) => sr.type === 'collection' && sr.collection)
        .map((sr) => sr.collection as string)
    )
  ]
  const { data: customActionsByCollection = {} } = useQuery<
    Record<string, Array<{ id: number; label: string }>>
  >({
    queryKey: ['queue-custom-actions', queueId, actionCollections.join(',')],
    queryFn: async () => {
      const out: Record<string, Array<{ id: number; label: string }>> = {}
      for (const c of actionCollections.slice(0, 6)) {
        try {
          const res = await client.request<{ data: Array<{ id: number; label: string }> }>(
            get('/custom-actions', { collection: c })
          )
          out[c] = res.data ?? []
        } catch {
          out[c] = []
        }
      }
      return out
    },
    enabled: actionCollections.length > 0,
    staleTime: 60_000
  })
  const customActionsFor = (collection: string) => customActionsByCollection[collection] ?? []
  const runCustomAction = (a: { id: number; label: string }, row: QueueItemRow) => {
    void client
      .request(post(`/custom-actions/${a.id}/execute`, { item: row.item_id }))
      .then(() => {
        toast.success(`${a.label} ran`)
        void qc.invalidateQueries({ queryKey: ['queue-items', queueId] })
      })
      .catch((err: unknown) => {
        const resp = (err as { response?: { error?: string } }).response
        toast.error(resp?.error ?? (err instanceof Error ? err.message : `${a.label} failed`))
      })
  }

  // Record-viewer counts (#272): per-node presence — polled every 30s for the
  // visible rows; chips render only at 2+ viewers (you are usually one).
  const [viewerCounts, setViewerCounts] = useState<Record<string, number>>({})

  // Triage labels (#109): the queue's distinct label vocabulary.
  const { data: triageLabels = [] } = useQuery<string[]>({
    queryKey: ['queue-triage-labels', queueId],
    queryFn: () =>
      client
        .request<{ data: string[] }>(get(`/queues/${queueId}/triage-labels`))
        .then((r) => r.data ?? [])
        .catch(() => []),
    staleTime: 30_000
  })
  const toggleTriageLabel = (row: QueueItemRow, label: string) => {
    void client
      .request(
        post(`/queues/${queueId}/triage-labels/toggle`, {
          collection: row.collection,
          item_id: row.item_id,
          label
        })
      )
      .then(() => {
        void qc.invalidateQueries({ queryKey: ['queue-items', queueId] })
        void qc.invalidateQueries({ queryKey: ['queue-triage-labels', queueId] })
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Label failed'))
  }

  const { data, isLoading, isFetching, isPlaceholderData } = useQuery<{
    data: QueueItemRow[]
    stats: QueueStats
    filtered_stats: QueueStats | null
    available_values: {
      collection: string[]
      state: string[]
      owners?: Array<{ id: string; name: string }>
    }
    truncated: boolean
    total: number
  }>({
    queryKey: [
      'queue-items',
      queueId,
      scope,
      sort,
      debouncedFilterValues,
      view === 'table' && !groupBy ? page : 'all',
      groupBy
    ],
    queryFn: () =>
      client.request(
        get(`/queues/${queueId}/items`, {
          scope,
          sort,
          filters: JSON.stringify(apiFilters),
          // Grouping renders the full matching set (kanban's existing path) —
          // groups are derived client-side, so pagination pauses while grouped.
          ...(view === 'table' && !groupBy ? { page, limit } : {})
        })
      ),
    // Wait for display_config AND scope seeding so the first fetch uses the
    // configured defaults and already carries the viewer's restricted filters.
    enabled: !!queueId && displayReady && scopeGateOpen,
    // Keep the previous page rendered while a sort/filter/page change refetches —
    // swapping to skeletons collapsed the table height and jittered the page.
    placeholderData: (prev) => prev
  })

  const showLoading = (isLoading && !data) || !displayReady || (!scopeGateOpen && !data)
  // True while a sort/filter/page change is in flight over kept-previous data —
  // the table dims slightly instead of unmounting (no layout shift).
  const isRefetching = (isFetching && !isLoading) || (isPlaceholderData && isFetching)

  // Poll record-viewer counts for the current page (#272). Per-node data —
  // treated as a hint, never as truth.
  const viewerRowsKey = (data?.data ?? [])
    .slice(0, 100)
    .map((r) => `${r.collection}:${r.item_id}`)
    .join(',')
  useEffect(() => {
    if (!viewerRowsKey) return
    let alive = true
    const pairs = viewerRowsKey.split(',').map((k) => {
      const i = k.indexOf(':')
      return { collection: k.slice(0, i), item_id: k.slice(i + 1) }
    })
    const load = () => {
      client
        .request<{ data: Record<string, number> }>(post('/presence/record-viewers', { pairs }))
        .then((r) => {
          if (alive) setViewerCounts(r.data ?? {})
        })
        .catch(() => {})
    }
    load()
    const t = setInterval(load, 30_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [viewerRowsKey, client])
  // Long-request honesty (#370)
  const loadElapsed = useElapsedLoading(isFetching)

  async function performTransition(item: QueueItemRow, targetState: string) {
    const instanceRes = await client.request<{
      data: {
        states: Array<{ id: string; key: string }>
        available_transitions: Array<{ id: string; to_state: string }>
      } | null
    }>(get(`/pipelines/instance/${item.collection}/${item.item_id}`))
    const instanceData = instanceRes.data
    if (!instanceData || instanceData.states.length === 0) {
      throw new Error('This item has no workflow instance')
    }

    const targetStateRow = instanceData.states.find((s) => s.key === targetState)
    if (!targetStateRow) throw new Error('Target state not found')

    const transition = instanceData.available_transitions.find(
      (t) => t.to_state === targetStateRow.id
    )
    if (!transition) throw new Error('No transition available to move this item here')

    await client.request(
      post(`/pipelines/instance/${item.collection}/${item.item_id}/transition`, {
        transition_id: transition.id
      })
    )
  }

  const transitionMut = useMutation({
    mutationFn: async ({ item, targetState }: { item: QueueItemRow; targetState: string }) => {
      await performTransition(item, targetState)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['queue-items', queueId, scope] })
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Failed to move item')
      qc.invalidateQueries({ queryKey: ['queue-items', queueId, scope] })
    }
  })

  const claimMut = useMutation({
    mutationFn: (item: QueueItemRow) =>
      client.request(
        post(`/queues/${queueId}/claim`, {
          source_collection: item.collection,
          item_id: item.item_id
        })
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['queue-items', queueId, scope] }),
    onError: () => toast.error('Failed to claim item')
  })

  const releaseMut = useMutation({
    mutationFn: (item: QueueItemRow) =>
      client.request(
        post(`/queues/${queueId}/release`, {
          source_collection: item.collection,
          item_id: item.item_id
        })
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['queue-items', queueId, scope] }),
    onError: () => toast.error('Failed to release item')
  })

  const { data: columnPrefs } = useQuery<{
    data: { visible_columns: string[] | null; default_view_id: number | null }
  }>({
    queryKey: ['queue-column-prefs', queueId],
    queryFn: () => client.request(get(`/queues/${queueId}/column-prefs`)),
    enabled: !!queueId
  })

  // Ephemeral column customization (visibility + order). Deliberately NOT
  // persisted per viewer: columns come from the queue's configured
  // default_columns, or from a saved view's snapshot — local tweaks last for
  // the session until saved into a view (same lifecycle as filters/sort).
  const [visibleColumns, setVisibleColumns] = useState<string[] | null>(null)

  // The viewer's default saved view id (null = general default). Synced from
  // server prefs, updated optimistically on toggle.
  const [defaultViewId, setDefaultViewId] = useState<number | null>(null)

  useEffect(() => {
    if (!columnPrefs) return
    setDefaultViewId(columnPrefs.data.default_view_id)
  }, [columnPrefs])

  const items = data?.data ?? []
  const stats = data?.stats
  const filteredStats = data?.filtered_stats ?? null

  // Any completed refetch clears the pending-updates pill — the data on screen
  // is current again, however the refetch was triggered.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on data identity
  useEffect(() => {
    setPendingUpdates(0)
  }, [data])

  function refreshPendingUpdates() {
    qc.invalidateQueries({ queryKey: ['queue-items', queueId] })
    qc.invalidateQueries({ queryKey: ['queue-workload', queueId] })
    setPendingUpdates(0)
  }

  // ── Trends (daily snapshots → sparklines + deltas on the global tiles) ──
  interface TrendRow {
    snapshot_date: string
    total: number
    unowned: number
    sla_warning: number
    sla_breached: number
    at_risk: number
  }

  const { data: trends } = useQuery<{ data: TrendRow[] }>({
    queryKey: ['queue-trends', queueId],
    queryFn: () => client.request(get(`/queues/${queueId}/trends`, { days: 14 })),
    enabled: !!queueId,
    staleTime: 5 * 60 * 1000
  })

  const { data: mineTrends } = useQuery<{ data: TrendRow[] }>({
    queryKey: ['queue-trends', queueId, 'mine'],
    queryFn: () => client.request(get(`/queues/${queueId}/trends`, { days: 14, scope: 'mine' })),
    enabled: !!queueId && scope === 'mine',
    staleTime: 5 * 60 * 1000
  })

  function trendFor(metric: 'total' | 'unowned' | 'sla_warning' | 'sla_breached' | 'at_risk'): {
    trend?: number[]
    delta?: number | null
  } {
    // Queue-wide snapshots back the All Items scope; the viewer's own series
    // (nivaro_queue_owner_snapshots) backs My Items. unowned/claimed scopes
    // have no per-scope history — no trend shown there.
    const source = scope === 'all' ? trends?.data : scope === 'mine' ? mineTrends?.data : undefined
    const rows = source ?? []
    if (rows.length === 0) return {}
    const series = rows.map((r) => r[metric])
    const last = rows[rows.length - 1]
    return { trend: series, delta: (stats?.[metric] ?? 0) - last[metric] }
  }

  // Burn-down forecast (#7): inflow vs completion from the daily snapshot
  // series — "at current pace this backlog clears in N days". Pace = average
  // net change per day over the window; a first/last-only slope would let one
  // spike day speak for the whole fortnight.
  const burnDown = useMemo(() => {
    const source = scope === 'all' ? trends?.data : scope === 'mine' ? mineTrends?.data : undefined
    const rows = source ?? []
    if (rows.length < 3 || !stats) return null
    const series = rows.map((r) => (scope === 'mine' ? ((r as unknown as { owned?: number }).owned ?? r.total) : r.total))
    const deltas = series.slice(1).map((v, i) => v - series[i])
    const pace = deltas.reduce((a, b) => a + b, 0) / deltas.length
    const current = stats.total
    if (Math.abs(pace) < 0.05) return { dir: 'flat' as const, pace, days: null }
    if (pace < 0) {
      return { dir: 'down' as const, pace, days: Math.max(1, Math.ceil(current / -pace)) }
    }
    return { dir: 'up' as const, pace, days: null }
  }, [trends?.data, mineTrends?.data, scope, stats])

  // ── Friendly labels: workflow state keys → state labels, collection names →
  // registry display names. Fallback: title-cased key.
  const sourceCollections = useMemo(
    () => [
      ...new Set(
        (queue?.sources ?? [])
          .filter((s) => s.type === 'collection' && s.collection)
          .map((s) => s.collection as string)
      )
    ],
    [queue?.sources]
  )

  // NOTE: shares the ['collections'] cache key with Queues.tsx and other pages —
  // the cached shape must stay the raw array (r.data.data), never the envelope.
  const { data: collectionsReg } = useQuery<
    Array<{ collection: string; display_name: string | null; plural: string | null }>
  >({
    queryKey: ['collections'],
    queryFn: () =>
      client
        .request<{
          data: Array<{ collection: string; display_name: string | null; plural: string | null }>
        }>(get('/collections'))
        .then((r) => r.data),
    staleTime: 5 * 60 * 1000
  })

  const stateQueries = useQueries({
    queries: sourceCollections.map((col) => ({
      queryKey: ['queue-collection-states', col],
      queryFn: () =>
        client
          .request<{ data: Array<{ key: string; label: string; color: string | null }> }>(
            get(`/queues/collection-states/${col}`)
          )
          .then((r) => r.data),
      staleTime: 5 * 60 * 1000
    }))
  })

  const friendly = (v: string) => v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on fetched data identity
  const stateMetaByKey = useMemo(() => {
    // The states endpoint returns rows ordered by workflow sort — array index
    // IS the pipeline position, used to order the state chip strip.
    const map: Record<string, { label: string; color: string | null; sort: number }> = {}
    for (const q of stateQueries) {
      ;(q.data ?? []).forEach((st, i) => {
        map[st.key] = { label: st.label, color: st.color, sort: i }
      })
    }
    return map
  }, [stateQueries.map((q) => q.data)])

  // Chips follow the workflow's state order (early states first); states the
  // meta lookup doesn't know — and the 'none' bucket — sink to the end.
  const stateEntries = stats
    ? Object.entries(stats.by_state).sort(
        (a, b) =>
          (stateMetaByKey[a[0]]?.sort ?? Number.MAX_SAFE_INTEGER) -
          (stateMetaByKey[b[0]]?.sort ?? Number.MAX_SAFE_INTEGER)
      )
    : []

  const stateLabelByKey = useMemo(() => {
    const map: Record<string, string> = {}
    for (const [k, v] of Object.entries(stateMetaByKey)) map[k] = v.label
    return map
  }, [stateMetaByKey])

  const stateLabel = (key: string | null | undefined): string => {
    if (!key) return '—'
    if (key === 'none') return 'No State'
    return stateLabelByKey[key] ?? friendly(key)
  }

  const collectionLabel = (name: string): string => {
    const row = (collectionsReg ?? []).find((c) => c.collection === name)
    return row?.display_name || row?.plural || friendly(name)
  }

  const groups = useMemo(() => (groupBy ? buildGroups(items, groupBy) : null), [items, groupBy])

  // Spec: groups collapse by default when the grouped set exceeds 200 rows.
  // Re-derived only when the grouping attribute changes — a socket-driven
  // refetch must not blow away the user's manual expand state, so groups/items
  // stay out of the deps on purpose.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on attribute change, not data refetch
  useEffect(() => {
    if (!groupBy || !groups) return
    setCollapsedGroups(items.length > 200 ? new Set(groups.map((g) => g.key)) : new Set())
  }, [groupBy])

  function toggleGroup(key: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Rows visible in the table, flattened in render order — grouped mode walks
  // expanded groups only. Drives keyboard navigation and Work Next.
  const visibleRows = useMemo(() => {
    if (!groups) return items
    return groups.filter((g) => !collapsedGroups.has(g.key)).flatMap((g) => g.rows)
  }, [groups, items, collapsedGroups])

  const rowId = (row: QueueItemRow) => `${row.collection}:${row.item_id}`

  // ── Triage: side sheet, keyboard nav, Work Next ──
  const [sheetItem, setSheetItem] = useState<QueueItemRow | null>(null)
  const [workNext, setWorkNext] = useState(false)
  const [highlightedId, setHighlightedId] = useState<string | null>(null)

  // Item edit-page opener with the queue's configured layout pinned. Goes
  // through useItemNavigation so an embedding host's itemUrl/openItem
  // overrides apply (the admin default is the /collections/:col/:id shape).
  const openItemPage = (row: QueueItemRow) =>
    itemNav.open({
      collection: row.collection,
      itemId: row.item_id,
      layoutSlug: displayConfig?.item_layout ?? null
    })

  // Row context menu (#43, queues): right-click a table row for its actions.
  const [rowCtxMenu, setRowCtxMenu] = useState<{ x: number; y: number; row: QueueItemRow } | null>(
    null
  )
  useEffect(() => {
    if (!rowCtxMenu) return
    const close = () => setRowCtxMenu(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [rowCtxMenu])

  // Open an item per the queue's row_click mode: 'full' navigates to the
  // (layout-pinned) item page; 'layout' opens the item's layout in a sidebar;
  // 'preview' opens the triage side sheet.
  const openItem = (row: QueueItemRow) => {
    setHighlightedId(rowId(row))
    const mode = displayConfig?.row_click ?? 'preview'
    if (mode === 'full') {
      openItemPage(row)
      return
    }
    if (mode === 'layout') {
      setDrilldown({
        collection: row.collection,
        itemId: row.item_id,
        rootLayoutSlug: displayConfig?.item_layout ?? null,
        width: displayConfig?.sheet_width,
        title: row.label
      })
      return
    }
    setSheetItem(row)
  }

  // Keep the open sheet's item fresh across refetches (claim/transition update it).
  // biome-ignore lint/correctness/useExhaustiveDependencies: sync only when data changes
  useEffect(() => {
    if (!sheetItem) return
    const fresh = items.find((r) => rowId(r) === rowId(sheetItem))
    if (fresh && fresh !== sheetItem) setSheetItem(fresh)
  }, [items])

  const workNextEligible = (row: QueueItemRow) => !row.claimed_by || row.claimed_by.id === userId

  function startWorkNext(after?: QueueItemRow) {
    const startIdx = after ? visibleRows.findIndex((r) => rowId(r) === rowId(after)) + 1 : 0
    const next = visibleRows.slice(startIdx).find(workNextEligible)
    if (!next) {
      setWorkNext(false)
      setSheetItem(null)
      toast.info('Nothing left to work on — queue clear!')
      return
    }
    setHighlightedId(rowId(next))
    if (claimsEnabled && !next.claimed_by) claimMut.mutate(next)
    // 'full' mode: claim then navigate to the item page (no sheet loop).
    if (displayConfig?.row_click === 'full') {
      openItemPage(next)
      return
    }
    setWorkNext(true)
    setSheetItem(next)
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps intentionally limited to the values that should rebind the listener; rowId/openItem/itemUrlWithLayout are plain functions recreated each render and always current in the closure
  useEffect(() => {
    if (view !== 'table') return
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return
      }
      const idx = highlightedId ? visibleRows.findIndex((r) => rowId(r) === highlightedId) : -1
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        const next = visibleRows[Math.min(idx + 1, visibleRows.length - 1)]
        if (next) setHighlightedId(rowId(next))
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        const prev = visibleRows[Math.max(idx - 1, 0)]
        if (prev) setHighlightedId(rowId(prev))
      } else if (e.key === 'Enter' && idx >= 0 && !sheetItem) {
        e.preventDefault()
        openItem(visibleRows[idx])
      } else if (e.key === 'c' && idx >= 0 && claimsEnabled) {
        e.preventDefault()
        const row = visibleRows[idx]
        row.claimed_by?.id === userId ? releaseMut.mutate(row) : claimMut.mutate(row)
      } else if (e.key === 'o' && idx >= 0) {
        e.preventDefault()
        openItemPage(visibleRows[idx])
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [view, visibleRows, highlightedId, sheetItem, userId, claimMut, releaseMut, claimsEnabled])

  // ── Saved views ──
  const { data: views } = useQuery<{ data: QueueView[] }>({
    queryKey: ['queue-views', queueId],
    queryFn: () => client.request(get(`/queues/${queueId}/views`)),
    enabled: !!queueId
  })
  const [activeViewId, setActiveViewId] = useState<number | null>(null)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveShared, setSaveShared] = useState(false)
  const [saveAsDefault, setSaveAsDefault] = useState(false)

  function applyView(v: QueueView) {
    const s = v.state ?? {}
    setScope(s.scope ?? 'all')
    setFilterValues({ ...seededFiltersRef.current, ...(s.filters ?? {}) })
    setSort(s.sort ?? '')
    setGroupBy(s.group_by ?? null)
    // Full snapshot: a view without saved columns resets to the queue default.
    setVisibleColumns(s.columns ?? null)
    setColumnPins(s.pins ?? null)
    if (s.view) setView(allowedViews.includes(s.view) ? s.view : allowedViews[0])
    setPage(1)
    setActiveViewId(v.id)
  }

  // Revert to the base everyone-default: the queue-wide default view when one
  // exists, else the queue's display_config baseline (CBV 'Default' parity).
  function resetToDefault() {
    const queueDefault = views?.data.find((v) => v.is_default)
    if (queueDefault) {
      applyView(queueDefault)
      return
    }
    setScope(queue?.display_config?.default_scope ?? 'all')
    setFilterValues({ ...seededFiltersRef.current })
    setSort('')
    setGroupBy(null)
    setVisibleColumns(null)
    setColumnPins(null)
    if (queue?.display_config?.default_view) setView(queue.display_config.default_view)
    setPage(1)
    setActiveViewId(null)
  }

  // Load gate: wait for display_config AND the viewer's prefs + saved views, then
  // apply the viewer's default saved view (if set and still present), else the
  // queue's general default scope/view. Firing once with the right state avoids a
  // flash + a double items fetch. Placed here so `views`/`applyView` are in scope.
  // biome-ignore lint/correctness/useExhaustiveDependencies: applyView reads state once at ready-time; deps intentionally minimal
  useEffect(() => {
    if (displayReady || !queue?.display_config) return
    if (columnPrefs === undefined || views === undefined) return
    const defId = columnPrefs.data.default_view_id
    const defView = defId != null ? views.data.find((v) => v.id === defId) : undefined
    const queueDefault = views.data.find((v) => v.is_default)
    if (defView) {
      applyView(defView)
    } else if (queueDefault) {
      // Queue-wide default (CBV is_default parity) — the base every viewer
      // gets until they pick their own default.
      applyView(queueDefault)
    } else {
      setView(queue.display_config.default_view)
      setScope(queue.display_config.default_scope)
    }
    setDisplayReady(true)
  }, [queue, columnPrefs, views, displayReady])

  const { isAdmin } = useItemEditAuth()
  const canManageQueueDefault = isAdmin || (queue?.owner != null && queue.owner === userId)
  const setQueueDefaultMut = useMutation({
    mutationFn: ({ viewId, on }: { viewId: number; on: boolean }) =>
      client.request(patch(`/queues/views/${viewId}`, { is_default: on })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['queue-views', queueId] })
      toast.success('Queue default view updated')
    },
    onError: () => toast.error('Could not update the queue default view')
  })

  const saveViewMut = useMutation({
    mutationFn: () =>
      client.request<{ data: { id: number } }>(
        post(`/queues/${queueId}/views`, {
          name: saveName.trim(),
          is_shared: saveShared || saveAsDefault,
          is_default: saveAsDefault,
          state: {
            scope,
            filters: filterValues,
            sort,
            group_by: groupBy,
            view,
            columns: visibleColumns,
            pins: columnPins
          }
        })
      ),
    onSuccess: (res) => {
      setSaveOpen(false)
      setSaveName('')
      setSaveShared(false)
      setSaveAsDefault(false)
      setActiveViewId(res.data.id)
      qc.invalidateQueries({ queryKey: ['queue-views', queueId] })
      toast.success('View saved')
    },
    onError: () => toast.error('Failed to save view')
  })

  // Overwrite an existing saved view with the current scope/filters/sort/etc.
  const updateViewMut = useMutation({
    mutationFn: (v: QueueView) =>
      client.request(
        patch(`/queues/views/${v.id}`, {
          state: {
            scope,
            filters: filterValues,
            sort,
            group_by: groupBy,
            view,
            columns: visibleColumns,
            pins: columnPins
          }
        })
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['queue-views', queueId] })
      toast.success('View updated')
    },
    onError: () => toast.error('Failed to update view')
  })

  const deleteViewMut = useMutation({
    mutationFn: (viewId: number) => client.request(del(`/queues/views/${viewId}`)),
    onSuccess: (_res, viewId) => {
      qc.invalidateQueries({ queryKey: ['queue-views', queueId] })
      setActiveViewId(null)
      if (defaultViewId === viewId) setDefaultViewId(null)
    },
    onError: () => toast.error('Failed to delete view')
  })

  // Set (or clear, viewId=null) the viewer's default saved view for this queue.
  const setDefaultViewMut = useMutation({
    mutationFn: (viewId: number | null) =>
      client.request(put(`/queues/${queueId}/default-view`, { view_id: viewId })),
    onMutate: (viewId) => setDefaultViewId(viewId),
    onSuccess: (_res, viewId) => {
      qc.invalidateQueries({ queryKey: ['queue-column-prefs', queueId] })
      toast.success(
        viewId === null ? 'Reverted to the general default' : 'Set as your default view'
      )
    },
    onError: () => {
      qc.invalidateQueries({ queryKey: ['queue-column-prefs', queueId] })
      toast.error('Failed to update default view')
    }
  })

  // ── Bulk actions ──
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [bulkBusy, setBulkBusy] = useState(false)

  async function runBulk(label: string, fn: (row: QueueItemRow) => Promise<unknown>) {
    const rows = items.filter((r) => selectedIds.includes(rowId(r)))
    setBulkBusy(true)
    const results = await Promise.allSettled(rows.map(fn))
    const ok = results.filter((r) => r.status === 'fulfilled').length
    const fail = results.length - ok
    setBulkBusy(false)
    setSelectedIds([])
    qc.invalidateQueries({ queryKey: ['queue-items', queueId] })
    if (fail) toast.warning(`${label}: ${ok} succeeded, ${fail} failed`)
    else toast.success(`${label}: ${ok} succeeded`)
  }

  const formatConfigFor = (path: string): ColumnFormatConfig | null => {
    for (const src of queue?.sources ?? []) {
      const cfg = src.column_formats?.[path]
      if (cfg) return cfg
    }
    return null
  }

  const groupKeyLabel = (key: string): string => {
    if (groupBy === 'state') return key === 'No state' ? key : stateLabel(key)
    if (groupBy === 'collection') return collectionLabel(key)
    if (groupBy?.startsWith('extra.') && key !== '—') {
      const fmt = formatConfigFor(groupBy.slice('extra.'.length))
      if (fmt) return formatMultiValue(key, fmt)
    }
    return key
  }

  const rowGroups = groups?.map((g) => ({
    key: g.key,
    rows: g.rows,
    header: (
      <>
        <span>{groupKeyLabel(g.key)}</span>
        <span className='font-normal text-slate-400'>({formatNumber(g.rows.length)})</span>
        {g.breached > 0 && (
          <span className='rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-600 dark:bg-red-500/10 dark:text-red-400'>
            {g.breached} breached
          </span>
        )}
        {g.atRisk > 0 && (
          <span className='rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-600 dark:bg-amber-500/10 dark:text-amber-400'>
            {g.atRisk} at risk
          </span>
        )}
      </>
    )
  }))

  // Single-collection queues waste a column repeating the same badge on every
  // row — only offer/show Collection when the queue actually mixes collections.
  const multiCollection = (data?.available_values.collection?.length ?? 0) > 1

  const baseColumns: Column<QueueItemRow>[] = [
    ...(multiCollection
      ? [
          {
            key: 'collection',
            header: aliasFor('collection', 'Collection'),
            sortable: true,
            render: (row) => <Badge variant='outline'>{collectionLabel(row.collection)}</Badge>
          } satisfies Column<QueueItemRow>
        ]
      : []),
    {
      key: 'label',
      header: aliasFor('label', 'Item'),
      sortable: true,
      render: (row) => (
        // Underlined because clicking opens the item. The row is clickable as
        // a whole, but nothing on it said so — an underline is the one
        // convention people already read as "this goes somewhere".
        <span className='flex items-center gap-1.5'>
          <span
            className='block max-w-[160px] truncate font-medium underline decoration-slate-300 decoration-dotted underline-offset-2 group-hover/row:decoration-nvr-cyan dark:decoration-slate-600'
            title={row.label}
          >
            {row.label}
          </span>
          {(row.labels ?? []).slice(0, 3).map((l) => (
            <span
              key={l}
              className='shrink-0 rounded-full bg-violet-100 px-1.5 py-px text-[9.5px] font-medium text-violet-700 dark:bg-violet-500/15 dark:text-violet-300'
              data-tip={`Triage label: ${l}`}
            >
              {l}
            </span>
          ))}
          {viewerCounts[`${row.collection}:${row.item_id}`] > 1 && (
            <span
              className='inline-flex shrink-0 items-center gap-0.5 rounded-full bg-slate-100 px-1.5 py-px text-[9.5px] text-slate-500 dark:bg-muted dark:text-muted-foreground'
              data-tip='People with this record open right now'
            >
              <Eye className='h-2.5 w-2.5' />
              {viewerCounts[`${row.collection}:${row.item_id}`]}
            </span>
          )}
        </span>
      )
    },
    {
      key: 'state',
      header: aliasFor('state', 'State'),
      sortable: true,
      render: (row) =>
        row.state ? (
          <span
            className='inline-block max-w-[190px] truncate whitespace-nowrap rounded px-1.5 py-0.5 align-middle text-[11px] font-medium'
            style={{
              backgroundColor: row.state_color ? `${row.state_color}1a` : undefined,
              color: row.state_color ?? undefined
            }}
            title={stateLabel(row.state)}
          >
            {stateLabel(row.state)}
          </span>
        ) : (
          <span className='text-slate-300'>—</span>
        )
    },
    {
      key: 'owners',
      header: aliasFor('owners', 'Owners'),
      sortable: true,
      render: (row) => <OwnerAvatars owners={row.owners} />
    },
    {
      key: 'aging_hours',
      header: aliasFor('aging_hours', 'Aging'),
      sortable: true,
      render: (row) => formatAging(row.aging_hours)
    },
    {
      key: 'sla_status',
      header: aliasFor('sla_status', 'SLA'),
      sortable: true,
      render: (row) => <SlaPill status={row.sla_status} />
    },
    {
      key: 'at_risk',
      header: aliasFor('at_risk', 'Risk'),
      sortable: true,
      render: (row) =>
        row.at_risk ? (
          <span className={rowHighlightTextClass(row.at_risk_color ?? 'red')}>⚑ At risk</span>
        ) : row.predicted_risk ? (
          <span className='text-amber-500' title={row.predicted_note ?? undefined}>
            ⚑ Predicted
          </span>
        ) : null
    }
  ]

  const claimColumn: Column<QueueItemRow> = {
    key: 'claim',
    header: '',
    render: (row) =>
      row.claimed_by ? (
        <button
          type='button'
          onClick={(e) => {
            e.stopPropagation()
            releaseMut.mutate(row)
          }}
          className='text-[11px] text-slate-400 underline hover:text-slate-600'
        >
          Release
        </button>
      ) : (
        <button
          type='button'
          onClick={(e) => {
            e.stopPropagation()
            claimMut.mutate(row)
          }}
          className='text-[11px] font-medium text-nvr-navy underline dark:text-nvr-cyan'
        >
          Claim
        </button>
      )
  }

  const extraFieldKeys = queue?.available_extra_fields ?? []

  // Drill-down target: clicking a relation extra-field value opens a detail
  // sheet for the related record. Config is per source column (enabled +
  // pinned detail layout); relation paths default to enabled.
  // The drill stack lives in the host's overlay history when one is provided,
  // so the browser's Back button steps down a level instead of abandoning the
  // worklist behind the sheet. Without a host adapter this is plain state and
  // behaves exactly as it did.
  const drill = useOverlayState<DrillEntry[]>('drill.queue')
  const drillStack = drill.value
  const setDrilldown = (entry: DrillEntry) => drill.push([entry])

  const drilldownConfigFor = (
    path: string
  ): { enabled: boolean; layout_id: number | null; width: number | string | null } => {
    for (const src of queue?.sources ?? []) {
      const cfg = src.drilldown?.[path]
      if (cfg)
        return {
          enabled: cfg.enabled !== false,
          layout_id: cfg.layout_id ?? null,
          width: cfg.width ?? null
        }
    }
    return { enabled: true, layout_id: null, width: null }
  }

  const mergedColumnFormats = useMemo(() => {
    const out: Record<string, ColumnFormatConfig> = {}
    for (const src of queue?.sources ?? []) {
      for (const [path, cfg] of Object.entries(src.column_formats ?? {})) {
        if (!(path in out)) out[path] = cfg
      }
    }
    return out
  }, [queue?.sources])

  // Compact cell text: emails show the local part, unformatted ISO datetimes
  // render as short dates — the full value always lives in the hover title.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:/
  function compactCell(display: string): { text: string; title: string } {
    if (EMAIL_RE.test(display)) return { text: display.split('@')[0], title: display }
    if (ISO_DATETIME_RE.test(display)) {
      const d = new Date(display)
      if (!Number.isNaN(d.getTime())) {
        return {
          text: formatDate(d, { month: '2-digit', day: '2-digit', year: '2-digit' }),
          title: formatDateTime(d)
        }
      }
    }
    return { text: display, title: display }
  }

  const extraColumns: Column<QueueItemRow>[] = extraFieldKeys.map((field) => ({
    key: `extra.${field}`,
    header: aliasFor(`extra.${field}`, formatColumnHeader(field)),
    sortable: true,
    render: (row) => {
      const value = row.extra?.[field]
      if (value == null || value === '') return <span className='text-slate-300'>—</span>
      const fmt = formatConfigFor(field)
      const display = fmt ? formatMultiValue(String(value), fmt) : String(value)
      const { text, title } = compactCell(display)
      const meta = (queue?.extra_field_meta ?? []).find((m) => m.path === field)
      const targetIds = row.extra_ids?.[field] ?? []
      const cfg = drilldownConfigFor(field)
      if (
        meta?.kind === 'relation' &&
        meta.target_collection &&
        targetIds.length > 0 &&
        cfg.enabled &&
        !meta.aggregate
      ) {
        return (
          <button
            type='button'
            onClick={(e) => {
              e.stopPropagation()
              setDrilldown({
                collection: meta.target_collection as string,
                itemId: targetIds[0],
                layoutId: cfg.layout_id,
                width: cfg.width,
                title: display
              })
            }}
            title={title}
            className='block max-w-[200px] truncate text-left text-[12px] text-slate-700 underline decoration-slate-300 decoration-dotted underline-offset-2 hover:text-nvr-navy hover:decoration-nvr-cyan dark:text-slate-200 dark:hover:text-nvr-cyan'
          >
            {text}
          </button>
        )
      }
      if (meta?.kind === 'relation' && meta.aggregate) {
        return (
          <button
            type='button'
            onClick={(e) => {
              e.stopPropagation()
              setAggDrill({ row, path: field, value: display })
            }}
            title='Show the rows behind this number'
            className='block max-w-[200px] truncate text-left text-[12px] tabular-nums underline decoration-slate-300 decoration-dotted underline-offset-2 hover:text-nvr-navy hover:decoration-nvr-cyan dark:hover:text-nvr-cyan'
          >
            {text}
          </button>
        )
      }
      return (
        <span className='block max-w-[200px] truncate text-[12px]' title={title}>
          {text}
        </span>
      )
    }
  }))

  const TOGGLEABLE_KEYS = [
    ...(multiCollection ? ['collection'] : []),
    'state',
    'owners',
    'aging_hours',
    'sla_status',
    'at_risk',
    ...extraFieldKeys.map((f) => `extra.${f}`)
  ]

  const DEFAULT_VISIBLE_COLUMNS = [
    ...(multiCollection ? ['collection'] : []),
    'state',
    'owners',
    'aging_hours',
    'sla_status',
    'at_risk',
    ...extraFieldKeys.slice(0, 2).map((f) => `extra.${f}`)
  ]

  // Column resolution: the viewer's saved prefs win; a queue-level
  // display_config.default_columns (builder-defined visibility AND order)
  // seeds viewers who never customized; else the computed default.
  const queueDefaultColumns = displayConfig?.default_columns ?? null
  const effectiveColumns = visibleColumns ?? queueDefaultColumns

  const effectiveVisible = new Set(effectiveColumns ?? DEFAULT_VISIBLE_COLUMNS)

  // Render order of the middle (toggleable) columns follows visible_columns'
  // actual array order (the viewer's saved drag-reorder), falling back to
  // TOGGLEABLE_KEYS' order for any column not yet toggled on — so the
  // Customize Columns popover shows a stable, sensible position for a column
  // before it's ever been visible.
  const orderedToggleableKeys = [
    ...(effectiveColumns ?? []).filter((k) => TOGGLEABLE_KEYS.includes(k)),
    ...TOGGLEABLE_KEYS.filter((k) => !(effectiveColumns ?? []).includes(k))
  ]

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIdx = orderedToggleableKeys.indexOf(String(active.id))
    const newIdx = orderedToggleableKeys.indexOf(String(over.id))
    if (oldIdx === -1 || newIdx === -1) return
    setVisibleColumns(
      arrayMove(orderedToggleableKeys, oldIdx, newIdx).filter((k) => effectiveVisible.has(k))
    )
  }

  const labelColumn = baseColumns.find((c) => c.key === 'label') as Column<QueueItemRow>
  // Formula columns (#133): display-only computed columns over base + extra
  // fields — {{aging_hours}}, {{extra.amount}} etc. Null on parse/type miss.
  const formulaColumns: Column<QueueItemRow>[] = (displayConfig?.formula_columns ?? []).map(
    (fc) => ({
      key: `formula.${fc.key}`,
      header: fc.label,
      render: (row) => {
        const scope: Record<string, unknown> = {
          ...row,
          ...(row.extra
            ? Object.fromEntries(Object.entries(row.extra).map(([k, v]) => [`extra.${k}`, v]))
            : {})
        }
        const v = evaluateExpression(fc.formula, (path) => {
          const raw = scope[path] ?? (row.extra ? row.extra[path] : undefined)
          const n = Number(raw)
          return Number.isFinite(n) ? n : ((raw as never) ?? null)
        })
        if (v == null || typeof v === 'boolean') return <span className='text-slate-300'>—</span>
        const n = Number(v)
        if (!Number.isFinite(n)) return <span>{String(v)}</span>
        return (
          <span className='tabular-nums'>
            {fc.format === 'currency'
              ? n.toLocaleString(undefined, { style: 'currency', currency: 'USD' })
              : n.toLocaleString()}
          </span>
        )
      }
    })
  )
  const allToggleable = [...baseColumns, ...extraColumns, ...formulaColumns]

  // CBV-parity per-row Actions menu (open / peek / transitions / copy / delete).
  // Hidden for 'tasks' sentinel rows — their item_id is a task PK, not a record.
  const actionsColumn: Column<QueueItemRow> = {
    key: '__actions__',
    header: '',
    render: (row) =>
      row.collection === 'tasks' ? null : (
        <span onClick={(e) => e.stopPropagation()}>
          <RowActionsMenu
            collection={row.collection}
            id={row.item_id}
            hasPipeline={row.state != null}
            onOpen={() => openItemPage(row)}
            onPeek={() => setSheetItem(row)}
            urlFor={itemNav.urlFor}
            onDeleted={() => {
              void client
                .request(del(`/items/${row.collection}/${row.item_id}`))
                .then(() => {
                  toast.success('Moved to trash')
                  void qc.invalidateQueries({ queryKey: ['queue-items', queueId] })
                })
                .catch((err: unknown) =>
                  toast.error(err instanceof Error ? err.message : 'Delete failed')
                )
            }}
            onAfterTransition={() =>
              void qc.invalidateQueries({ queryKey: ['queue-items', queueId] })
            }
          />
        </span>
      )
  }

  const columns: Column<QueueItemRow>[] = [
    labelColumn,
    ...orderedToggleableKeys
      .filter((k) => effectiveVisible.has(k))
      .map((k) => allToggleable.find((c) => c.key === k))
      .filter((c): c is Column<QueueItemRow> => c !== undefined),
    ...(claimsEnabled ? [claimColumn] : []),
    actionsColumn
  ]

  // Effective pin map — user pins (saved view / session) win, then the queue's
  // builder-set display_config.default_pins, then the historic default of the
  // first data column (Item) pinned left. Pins for columns no longer visible
  // are dropped so stale saved-view pins can't wedge offsets.
  const effectivePins = useMemo<Record<string, 'left' | 'right'>>(() => {
    const configPins = displayConfig?.default_pins as
      | Record<string, 'left' | 'right'>
      | null
      | undefined
    const base =
      columnPins ??
      (configPins && Object.keys(configPins).length > 0
        ? configPins
        : { [columns[0]?.key ?? 'label']: 'left' as const })
    const valid = new Set(columns.map((c) => c.key))
    return Object.fromEntries(Object.entries(base).filter(([k]) => valid.has(k))) as Record<
      string,
      'left' | 'right'
    >
    // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the visible column keys, not column identity
  }, [columnPins, displayConfig?.default_pins, columns.map((c) => c.key).join('|')])

  const groupOptions: { value: string; label: string }[] = [
    { value: 'state', label: 'State' },
    { value: 'collection', label: 'Collection' },
    { value: 'sla_status', label: 'SLA status' },
    { value: 'at_risk', label: 'At risk' },
    { value: 'owners', label: 'Owner' },
    { value: 'aging', label: 'Aging' },
    ...extraFieldKeys
      .filter((f) => effectiveVisible.has(`extra.${f}`))
      .map((f) => ({ value: `extra.${f}`, label: aliasFor(`extra.${f}`, formatColumnHeader(f)) }))
  ]

  // Server-backed autocomplete for relation extra-fields: searches the FINAL
  // hop's target collection (e.g. project_types.name) so huge datasets stay
  // usable. The selected display value feeds the existing contains-match filter.
  const makeRelationLoader =
    (meta: ExtraFieldMeta) =>
    async (search: string): Promise<{ label: string; value: string }[]> => {
      if (!meta.target_collection || !meta.display_field) return []
      const params: Record<string, string | number> = {
        limit: 25,
        sort: meta.display_field
      }
      if (search.trim()) {
        params.filter = JSON.stringify({ [meta.display_field]: { _contains: search.trim() } })
      }
      const res = await client.request<{ data: Record<string, unknown>[] }>(
        get(`/items/${meta.target_collection}`, params)
      )
      const rows = res.data ?? []
      // Option VALUES stay raw (the server contains-match compares raw display
      // values); only the label formats, so date/number columns offer readable
      // options instead of raw ISO strings.
      const fmt = formatConfigFor(meta.path)
      const allowedSet = allowedValuesByPath[meta.path]
        ? new Set(allowedValuesByPath[meta.path])
        : null
      const seen = new Set<string>()
      const out: { label: string; value: string }[] = []
      for (const row of rows) {
        const v = row[meta.display_field]
        if (v == null || v === '') continue
        const str = String(v)
        if (seen.has(str)) continue
        if (allowedSet && !allowedSet.has(str)) continue
        seen.add(str)
        out.push({ label: fmt ? formatMultiValue(str, fmt) : str, value: str })
      }
      return out
    }

  const extraFieldMetaByPath = new Map((queue?.extra_field_meta ?? []).map((m) => [m.path, m]))

  // Applied-filter chip text: format extra-column values through the column's
  // display format (dates/numbers) instead of echoing the raw stored value.
  const displayFilterValue = (def: FilterDef, value: string | string[]): string => {
    if (def.key.startsWith('extra.')) {
      const fmt = formatConfigFor(def.key.slice('extra.'.length))
      if (fmt) {
        const vals = (Array.isArray(value) ? value : [value]).filter((v) => v !== '')
        const names = vals.map((v) => formatMultiValue(String(v), fmt))
        return names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2}` : '')
      }
    }
    return filterValueDisplay(def, value)
  }

  const filterDefs: FilterDef[] = [
    {
      key: 'collection',
      placeholder: aliasFor('collection', 'Collection'),
      type: 'combobox' as const,
      multi: true,
      options: (data?.available_values.collection ?? []).map((c) => ({
        label: collectionLabel(c),
        value: c
      }))
    },
    {
      key: 'state',
      placeholder: aliasFor('state', 'State'),
      type: 'combobox' as const,
      multi: true,
      options: (data?.available_values.state ?? []).map((s) => ({
        label: stateLabel(s),
        value: s
      }))
    },
    {
      key: 'sla_status',
      placeholder: 'SLA',
      type: 'select' as const,
      options: [
        { label: 'OK', value: 'ok' },
        { label: 'Warning', value: 'warning' },
        { label: 'Breached', value: 'breached' }
      ]
    },
    {
      key: 'at_risk',
      placeholder: 'At risk',
      type: 'select' as const,
      options: [
        { label: 'Yes', value: 'yes' },
        { label: 'No', value: 'no' }
      ]
    },
    { key: 'aging_hours', placeholder: 'Aging (hours)', type: 'range' as const },
    ...(triageLabels.length > 0
      ? [
          {
            key: 'labels',
            placeholder: 'Triage label',
            type: 'combobox' as const,
            multi: true,
            options: triageLabels.map((l) => ({ label: l, value: l }))
          }
        ]
      : []),
    {
      key: 'label',
      placeholder: aliasFor('label', 'Item'),
      type: 'combobox' as const,
      multi: true,
      loadOptions: async (search: string) => {
        const res = await client.request<{ data: string[] }>(
          get(`/queues/${queueId}/label-suggest`, search.trim() ? { q: search.trim() } : {})
        )
        return (res.data ?? []).map((l) => ({ label: l, value: l }))
      }
    },
    {
      key: 'owners',
      placeholder: aliasFor('owners', 'Owners'),
      type: 'combobox' as const,
      multi: true,
      options: (data?.available_values.owners ?? []).map((o) => ({
        label: o.name,
        value: o.id
      }))
    },
    ...extraFieldKeys.map((f) => {
      const meta = extraFieldMetaByPath.get(f)
      if (meta?.kind === 'relation') {
        return {
          key: `extra.${f}`,
          placeholder: aliasFor(`extra.${f}`, formatColumnHeader(f)),
          type: 'combobox' as const,
          multi: true,
          restricted: Boolean(allowedValuesByPath[f]?.length),
          loadOptions: makeRelationLoader(meta)
        }
      }
      return {
        key: `extra.${f}`,
        placeholder: `Search ${aliasFor(`extra.${f}`, formatColumnHeader(f))}…`,
        type: 'text' as const
      }
    })
  ].filter((def) => effectiveVisible.has(def.key) || def.key === 'label' || def.key === 'owners')

  function handleToggleColumn(key: string) {
    const current = new Set(effectiveVisible)
    if (current.has(key)) current.delete(key)
    else current.add(key)
    setVisibleColumns([...current])
  }

  if (queueError) {
    return renderError?.((queueError as { status?: number })?.status ?? 500) ?? null
  }

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      {/* Pinned band: banner, legend, stat tiles, scope/view toolbar. The view
          below gets the REMAINING viewport height with its own scrollbar —
          same containment contract as CollectionBrowserView, so the stats
          never scroll away and the scrollbar is always in reach. */}
      <div className='shrink-0 px-6 pt-6'>
        {data?.truncated && (
          <div className='mb-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[12px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300'>
            <AlertTriangle className='h-4 w-4 shrink-0' />
            <span>
              This view hit the row safety limit — the table below may not include every matching
              item, but the totals above are exact. Narrow the filters (or clear the priority sort
              on a large queue) to browse everything.
            </span>
          </div>
        )}
        {/* One insight band: compact stat segments + state chips share a wrapping
      row — half the height of the old five-tile grid + separate chip row. */}
        <RowHighlightLegend
          collections={[
            ...new Set(
              (queue?.sources ?? [])
                .filter((s) => s.type === 'collection' && s.collection)
                .map((s) => s.collection as string)
            )
          ]}
          className='mb-2'
        />
        <div className='mb-3 flex flex-wrap items-center gap-x-4 gap-y-2'>
          <div className='flex divide-x divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-border dark:border-border dark:bg-card'>
            <StatTile
              label='Total'
              count={stats?.total ?? 0}
              filteredCount={filteredStats ? filteredStats.total : null}
              active={Object.values(filterValues).every(isFilterEmpty) && scope === 'all'}
              isLoading={showLoading}
              {...trendFor('total')}
              onClick={clearAllTileFilters}
            />
            <StatTile
              label='Warning'
              count={stats?.sla_warning ?? 0}
              filteredCount={filteredStats ? filteredStats.sla_warning : null}
              tone='amber'
              active={filterValues.sla_status === 'warning'}
              isLoading={showLoading}
              deltaBadIsUp
              {...trendFor('sla_warning')}
              onClick={() => toggleTileFilter('sla_status', 'warning')}
            />
            <StatTile
              label='Breached'
              count={stats?.sla_breached ?? 0}
              filteredCount={filteredStats ? filteredStats.sla_breached : null}
              tone='red'
              active={filterValues.sla_status === 'breached'}
              isLoading={showLoading}
              deltaBadIsUp
              {...trendFor('sla_breached')}
              onClick={() => toggleTileFilter('sla_status', 'breached')}
            />
            <StatTile
              label='At Risk'
              count={stats?.at_risk ?? 0}
              filteredCount={filteredStats ? filteredStats.at_risk : null}
              tone='red'
              active={filterValues.at_risk === 'yes'}
              isLoading={showLoading}
              deltaBadIsUp
              {...trendFor('at_risk')}
              onClick={() => toggleTileFilter('at_risk', 'yes')}
            />
            <StatTile
              label='Unowned'
              count={stats?.unowned ?? 0}
              filteredCount={filteredStats ? filteredStats.unowned : null}
              active={scope === 'unowned'}
              isLoading={showLoading}
              deltaBadIsUp
              {...trendFor('unowned')}
              onClick={() => {
                setScope(scope === 'unowned' ? 'all' : 'unowned')
                setPage(1)
              }}
            />
          </div>
          {stats?.aging && stats.total > 0 && (
            <div className='flex items-center gap-1 text-[11px]' data-tip='Time in current state'>
              {(
                [
                  ['0-1d', '0:24', stats.aging.d1],
                  ['1-3d', '24:72', stats.aging.d3],
                  ['3-7d', '72:168', stats.aging.d7],
                  ['7d+', '168:', stats.aging.over]
                ] as Array<[string, string, number]>
              ).map(([label, range, count]) => (
                <button
                  key={label}
                  type='button'
                  onClick={() => {
                    setFilterValues((prev) => ({
                      ...prev,
                      aging_hours: prev.aging_hours === range ? '' : range
                    }))
                    setPage(1)
                  }}
                  className={cn(
                    'rounded-md border px-2 py-1 tabular-nums transition-colors',
                    filterValues.aging_hours === range
                      ? 'border-nvr-cyan bg-nvr-cyan/10 font-medium text-[#0e7490] dark:text-[#67e8f9]'
                      : 'border-slate-200 text-slate-500 hover:bg-muted dark:border-border dark:text-muted-foreground',
                    count === 0 && 'opacity-45'
                  )}
                >
                  {label} · {count}
                </button>
              ))}
            </div>
          )}
          {burnDown && (
            <span
              data-queue-burndown
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium ${
                burnDown.dir === 'down'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400'
                  : burnDown.dir === 'up'
                    ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400'
                    : 'border-slate-200 bg-slate-50 text-slate-500 dark:border-border dark:bg-muted dark:text-muted-foreground'
              }`}
              data-tip='Average net change per day over the last 14 days of snapshots'
            >
              {burnDown.dir === 'down' ? (
                <>
                  ▼ {Math.abs(burnDown.pace).toFixed(1)}/day — clears in ~{burnDown.days} day
                  {burnDown.days === 1 ? '' : 's'} at this pace
                </>
              ) : burnDown.dir === 'up' ? (
                <>▲ Growing {burnDown.pace.toFixed(1)}/day</>
              ) : (
                <>→ Holding steady</>
              )}
            </span>
          )}

          {stateEntries.length > 0 && (
            <div className='flex min-w-0 flex-wrap items-center gap-1.5'>
              {stateEntries.map(([state, count]) => (
                <StateChip
                  key={state}
                  label={stateLabel(state)}
                  count={count}
                  filteredCount={filteredStats ? (filteredStats.by_state[state] ?? 0) : null}
                  color={stateMetaByKey[state]?.color ?? null}
                  active={stateFilterList.includes(state)}
                  onClick={() => toggleStateChip(state)}
                />
              ))}
            </div>
          )}
        </div>

        <div className='mb-4 flex flex-wrap items-center gap-2'>
          {/* Scope control waits for display_config so the configured default
        scope is active on first paint instead of flashing in. */}
          {!displayReady ? (
            <div className='h-[30px] w-64 animate-pulse rounded-md bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />
          ) : (
            <div className='flex overflow-hidden rounded-md border border-slate-200 dark:border-border'>
              {SCOPE_TABS.filter((tab) => claimsEnabled || tab.value !== 'claimed').map(
                (tab, i) => (
                  <button
                    key={tab.value}
                    type='button'
                    onClick={() => {
                      setScope(tab.value)
                      setPage(1)
                    }}
                    className={cn(
                      'px-3 py-1.5 text-[12px] font-medium transition-colors',
                      i > 0 && 'border-l border-slate-200 dark:border-border',
                      scope === tab.value
                        ? 'bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                        : 'bg-white text-slate-500 hover:text-slate-700 dark:bg-card dark:hover:text-foreground'
                    )}
                  >
                    {tab.label}
                  </button>
                )
              )}
            </div>
          )}
          {/* Filters toggle sits by the scope control — the rail it opens is on
        the left, so the control lives where its effect appears. */}
          {view === 'table' && (
            <button
              type='button'
              onClick={() => setFiltersOpen((o) => !o)}
              aria-expanded={filtersOpen}
              className={cn(
                'flex items-center gap-1 rounded-md px-3 py-1.5 text-[12px] font-medium',
                filtersOpen || activeFilterCount > 0
                  ? 'bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                  : 'text-slate-500 hover:text-slate-700 dark:hover:text-foreground'
              )}
            >
              <Filter className='h-3.5 w-3.5' />
              Filters
              {activeFilterCount > 0 && (
                <span className='rounded-full bg-nvr-cyan px-1.5 text-[10px] font-semibold leading-4 text-white'>
                  {activeFilterCount}
                </span>
              )}
            </button>
          )}
          {/* Hold the switcher until display_config applies — otherwise all
        three views flash before hidden ones disappear. */}
          {!displayReady ? (
            <div className='h-[30px] w-40 animate-pulse rounded-md bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />
          ) : (
            <div className='flex overflow-hidden rounded-md border border-slate-200 dark:border-border'>
              {(
                [
                  { value: 'table', label: 'Table' },
                  { value: 'kanban', label: 'Kanban' },
                  { value: 'workload', label: 'Workload' }
                ] as const
              )
                .filter((v) => allowedViews.includes(v.value))
                .map((v, i) => (
                  <button
                    key={v.value}
                    type='button'
                    onClick={() => setView(v.value)}
                    className={cn(
                      'px-3 py-1.5 text-[12px] font-medium transition-colors',
                      i > 0 && 'border-l border-slate-200 dark:border-border',
                      view === v.value
                        ? 'bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                        : 'bg-white text-slate-500 hover:text-slate-700 dark:bg-card dark:hover:text-foreground'
                    )}
                  >
                    {v.label}
                  </button>
                ))}
            </div>
          )}
          {view === 'table' && (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type='button'
                  className={cn(
                    'flex items-center gap-1 rounded-md px-3 py-1.5 text-[12px] font-medium',
                    groupBy
                      ? 'bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                      : 'text-slate-500 hover:text-slate-700 dark:hover:text-foreground'
                  )}
                >
                  <Rows3 className='h-3.5 w-3.5' />
                  {groupBy
                    ? `Group: ${groupOptions.find((o) => o.value === groupBy)?.label ?? groupBy}`
                    : 'Group'}
                </button>
              </PopoverTrigger>
              <PopoverContent className='w-[200px] p-0' align='start'>
                <Command>
                  <CommandInput placeholder='Group by…' className='h-8 text-[12px]' />
                  <CommandList>
                    <CommandEmpty>No attribute found.</CommandEmpty>
                    <CommandItem value='__none__' onSelect={() => setGroupBy(null)}>
                      None
                    </CommandItem>
                    {groupOptions.map((opt) => (
                      <CommandItem
                        key={opt.value}
                        value={opt.label}
                        onSelect={() => setGroupBy(opt.value)}
                      >
                        {opt.label}
                      </CommandItem>
                    ))}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          )}
          {view === 'table' && (
            <button
              type='button'
              onClick={() => {
                setSort(sort === '-priority' ? '' : '-priority')
                setPage(1)
              }}
              className={cn(
                'flex items-center gap-1 rounded-md px-3 py-1.5 text-[12px] font-medium',
                sort === '-priority'
                  ? 'bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                  : 'text-slate-500 hover:text-slate-700 dark:hover:text-foreground'
              )}
            >
              <Flame className='h-3.5 w-3.5' />
              Priority
            </button>
          )}
          {view === 'table' && groupBy && groups && (
            <button
              type='button'
              onClick={() =>
                setCollapsedGroups(
                  collapsedGroups.size > 0 ? new Set() : new Set(groups.map((g) => g.key))
                )
              }
              className='rounded-md px-2 py-1.5 text-[12px] text-slate-500 hover:text-slate-700 dark:hover:text-foreground'
            >
              {collapsedGroups.size > 0 ? 'Expand all' : 'Collapse all'}
            </button>
          )}
          {view === 'kanban' && (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type='button'
                  className={cn(
                    'flex items-center gap-1 rounded-md px-3 py-1.5 text-[12px] font-medium',
                    swimlaneBy
                      ? 'bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                      : 'text-slate-500 hover:text-slate-700 dark:hover:text-foreground'
                  )}
                >
                  <Rows3 className='h-3.5 w-3.5' />
                  {swimlaneBy
                    ? `Lanes: ${swimlaneBy === 'collection' ? 'Collection' : 'Owner'}`
                    : 'Lanes'}
                </button>
              </PopoverTrigger>
              <PopoverContent className='w-[180px] p-0' align='start'>
                <Command>
                  <CommandList>
                    <CommandItem value='none' onSelect={() => setSwimlaneBy(null)}>
                      None
                    </CommandItem>
                    <CommandItem value='collection' onSelect={() => setSwimlaneBy('collection')}>
                      Collection
                    </CommandItem>
                    <CommandItem value='owner' onSelect={() => setSwimlaneBy('owners')}>
                      Owner
                    </CommandItem>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          )}
          {pendingUpdates > 0 && (
            <button
              type='button'
              onClick={refreshPendingUpdates}
              className='flex items-center gap-1 rounded-full bg-nvr-cyan/10 px-3 py-1 text-[12px] font-medium text-nvr-navy hover:bg-nvr-cyan/20 dark:text-nvr-cyan'
            >
              <RefreshCw className='h-3 w-3' />
              {pendingUpdates} update{pendingUpdates === 1 ? '' : 's'} · Refresh
            </button>
          )}
          <div className='ml-auto flex flex-wrap items-center gap-1.5'>
            {!(views?.data ?? []).some((v) => v.is_default) && (
              <button
                type='button'
                onClick={resetToDefault}
                title='Revert to the queue default (filters, columns and sort cleared)'
                className={cn(
                  'rounded-full border px-2.5 py-1 text-[11px] font-medium',
                  activeViewId == null
                    ? 'border-nvr-cyan bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-border dark:bg-card dark:text-slate-300'
                )}
              >
                Default
              </button>
            )}
            {(views?.data ?? []).map((v) => (
              <span
                key={v.id}
                className={cn(
                  'group flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium',
                  activeViewId === v.id
                    ? 'border-nvr-cyan bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-border dark:bg-card dark:text-slate-300'
                )}
              >
                <button
                  type='button'
                  title={
                    defaultViewId === v.id
                      ? 'Your default view — click to revert to the general default'
                      : 'Set as your default view'
                  }
                  onClick={() => setDefaultViewMut.mutate(defaultViewId === v.id ? null : v.id)}
                  className={cn(
                    'shrink-0',
                    defaultViewId === v.id
                      ? 'text-amber-400'
                      : 'text-slate-300 hover:text-amber-400 dark:text-slate-600'
                  )}
                >
                  <Star
                    className={cn('h-3 w-3', defaultViewId === v.id && 'fill-current')}
                    aria-label={defaultViewId === v.id ? 'Default view' : 'Set as default'}
                  />
                </button>
                <button type='button' onClick={() => applyView(v)}>
                  {v.name}
                  {v.is_default ? (
                    <span className='ml-1 text-nvr-navy/60 dark:text-nvr-cyan/70'>· default</span>
                  ) : (
                    v.is_shared && <span className='ml-1 text-slate-400'>· shared</span>
                  )}
                </button>
                {canManageQueueDefault && (
                  <button
                    type='button'
                    onClick={() => setQueueDefaultMut.mutate({ viewId: v.id, on: !v.is_default })}
                    title={
                      v.is_default
                        ? 'Queue default — click to unset'
                        : 'Set as the default view for everyone on this queue'
                    }
                    className={cn(
                      'shrink-0',
                      v.is_default
                        ? 'text-nvr-cyan'
                        : 'hidden text-slate-300 hover:text-nvr-cyan group-hover:inline dark:text-slate-600'
                    )}
                    aria-label={v.is_default ? 'Unset queue default' : 'Set queue default'}
                  >
                    <Pin className={cn('h-3 w-3', v.is_default && 'fill-current')} />
                  </button>
                )}
                {(v.user === userId || isAdmin) && activeViewId === v.id && (
                  <button
                    type='button'
                    onClick={() => updateViewMut.mutate(v)}
                    disabled={updateViewMut.isPending}
                    title='Update this view with the current filters, scope and sort'
                    className='shrink-0 text-slate-400 hover:text-nvr-navy disabled:opacity-50 dark:hover:text-nvr-cyan'
                    aria-label={`Update view ${v.name}`}
                  >
                    <Save className='h-3 w-3' />
                  </button>
                )}
                {activeViewId === v.id && (
                  <button
                    type='button'
                    onClick={() => toggleViewSub(v.id)}
                    title={
                      viewSubFor(v.id)
                        ? 'Subscribed to new arrivals in this view — click to unsubscribe'
                        : 'Notify me when items enter this view (checked every 5 min)'
                    }
                    className={cn(
                      'shrink-0',
                      viewSubFor(v.id)
                        ? 'text-nvr-cyan'
                        : 'hidden text-slate-300 hover:text-nvr-cyan group-hover:inline dark:text-slate-600'
                    )}
                    aria-label={`Subscribe to view ${v.name}`}
                  >
                    <Bell className={cn('h-3 w-3', viewSubFor(v.id) && 'fill-current')} />
                  </button>
                )}
                {v.user === userId && (
                  <button
                    type='button'
                    onClick={() => deleteViewMut.mutate(v.id)}
                    className='hidden text-slate-400 hover:text-red-500 group-hover:inline'
                    aria-label={`Delete view ${v.name}`}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
            <Popover open={saveOpen} onOpenChange={setSaveOpen}>
              <PopoverTrigger asChild>
                <button
                  type='button'
                  className='rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-[11px] font-medium text-slate-500 hover:border-nvr-cyan hover:text-nvr-navy dark:border-border dark:text-slate-400 dark:hover:text-nvr-cyan'
                >
                  + Save view
                </button>
              </PopoverTrigger>
              <PopoverContent className='w-[240px] p-3' align='end'>
                {(() => {
                  const active = views?.data.find((v) => v.id === activeViewId)
                  if (!active || (active.user !== userId && !isAdmin)) return null
                  return (
                    <button
                      type='button'
                      disabled={updateViewMut.isPending}
                      onClick={() => {
                        updateViewMut.mutate(active)
                        setSaveOpen(false)
                      }}
                      className='mb-2 w-full rounded-md border border-nvr-cyan/40 bg-nvr-cyan/5 px-2 py-1.5 text-[12px] font-medium text-nvr-navy hover:bg-nvr-cyan/10 disabled:opacity-50 dark:text-nvr-cyan'
                    >
                      Update “{active.name}” with current view
                    </button>
                  )
                })()}
                <input
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  placeholder='View name'
                  className='mb-2 w-full rounded-md border border-slate-200 px-2 py-1.5 text-[12px] focus:border-nvr-cyan focus:outline-none dark:border-border dark:bg-card'
                />
                <label className='mb-2 flex items-center gap-2 text-[12px] text-slate-600 dark:text-slate-300'>
                  <Checkbox
                    checked={saveShared || saveAsDefault}
                    disabled={saveAsDefault}
                    onCheckedChange={(c) => setSaveShared(c === true)}
                  />
                  Share with everyone
                </label>
                {canManageQueueDefault && (
                  <label className='mb-2 flex items-center gap-2 text-[12px] text-slate-600 dark:text-slate-300'>
                    <Checkbox
                      checked={saveAsDefault}
                      onCheckedChange={(c) => setSaveAsDefault(c === true)}
                    />
                    Set as queue default (everyone starts here)
                  </label>
                )}
                <button
                  type='button'
                  disabled={!saveName.trim() || saveViewMut.isPending}
                  onClick={() => saveViewMut.mutate()}
                  className='w-full rounded-md bg-nvr-cyan px-2 py-1.5 text-[12px] font-semibold text-white hover:bg-nvr-cyan/90 disabled:opacity-50'
                >
                  Save current view
                </button>
              </PopoverContent>
            </Popover>
            {view === 'table' && (
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type='button'
                    className='flex items-center gap-1 rounded-md px-3 py-1.5 text-[12px] font-medium text-slate-500 hover:text-slate-700 dark:hover:text-foreground'
                  >
                    <SlidersHorizontal className='h-3.5 w-3.5' />
                    Columns
                  </button>
                </PopoverTrigger>
                <PopoverContent className='w-[220px] p-2' align='end'>
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                  >
                    <SortableContext
                      items={orderedToggleableKeys}
                      strategy={verticalListSortingStrategy}
                    >
                      <div className='space-y-1.5'>
                        {orderedToggleableKeys.map((key) => {
                          const col = allToggleable.find((c) => c.key === key)
                          return (
                            <SortableColumnToggle
                              key={key}
                              id={key}
                              label={typeof col?.header === 'string' ? col.header : key}
                              checked={effectiveVisible.has(key)}
                              onCheckedChange={() => handleToggleColumn(key)}
                            />
                          )
                        })}
                      </div>
                    </SortableContext>
                  </DndContext>
                </PopoverContent>
              </Popover>
            )}
            {view === 'table' && (
              <button
                type='button'
                onClick={() => {
                  const next = density === 'compact' ? 'comfortable' : 'compact'
                  setDensity(next)
                  try {
                    localStorage.setItem('nvr_table_density', next)
                  } catch {
                    /* private mode */
                  }
                }}
                aria-label='Row density'
                title={density === 'compact' ? 'Switch to comfortable rows' : 'Switch to compact rows'}
                className='flex h-[30px] w-[30px] items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 shadow-sm hover:bg-slate-50 hover:text-slate-700 dark:border-border dark:bg-card dark:text-slate-400 dark:hover:bg-muted'
              >
                {density === 'compact' ? <Rows4 className='h-3.5 w-3.5' /> : <Rows2 className='h-3.5 w-3.5' />}
              </button>
            )}
            {view === 'table' && workNextEnabled && visibleRows.length > 0 && (
              <button
                type='button'
                onClick={() => startWorkNext()}
                className='flex items-center gap-1.5 rounded-md bg-nvr-cyan px-3.5 py-1.5 text-[12px] font-semibold text-white shadow-sm hover:bg-nvr-cyan/90'
              >
                <Play className='h-3 w-3 fill-current' />
                Work Next
              </button>
            )}
            {creatableCollections.length === 1 && (
              newItemLayouts ? (
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type='button'
                      className='flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 shadow-sm hover:bg-slate-50 dark:border-border dark:bg-card dark:text-slate-200 dark:hover:bg-muted'
                    >
                      <Plus className='h-3.5 w-3.5' />
                      New {titleCase(creatableCollections[0])}
                      <ChevronDown className='h-3 w-3 opacity-60' />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align='end' className='w-60 p-1'>
                    <button
                      type='button'
                      onClick={() =>
                        itemNav.open({
                          collection: creatableCollections[0],
                          itemId: 'new',
                          // Same layout the queue opens existing records with.
                          layoutSlug: displayConfig?.item_layout ?? null
                        })
                      }
                      className='flex w-full items-center rounded px-2 py-1.5 text-left text-[12px] text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-muted'
                    >
                      {newItemLayouts.active?.create_label ?? newItemLayouts.active?.name ?? 'Default layout'}
                      <span className='ml-auto pl-3 text-[10px] text-slate-400 dark:text-slate-500'>default</span>
                    </button>
                    {newItemLayouts.options.map((l) => (
                      <button
                        key={l.id}
                        type='button'
                        onClick={() =>
                          itemNav.open({
                            collection: creatableCollections[0],
                            itemId: 'new',
                            layoutSlug: l.slug
                          })
                        }
                        className='flex w-full items-center rounded px-2 py-1.5 text-left text-[12px] text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-muted'
                      >
                        {l.create_label ?? l.name}
                      </button>
                    ))}
                  </PopoverContent>
                </Popover>
              ) : (
                <button
                  type='button'
                  onClick={() =>
                    itemNav.open({
                      collection: creatableCollections[0],
                      itemId: 'new',
                      // Open a new record on the same layout the queue opens
                      // existing ones with, so creating and reviewing match.
                      layoutSlug: displayConfig?.item_layout ?? null
                    })
                  }
                  className='flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 shadow-sm hover:bg-slate-50 dark:border-border dark:bg-card dark:text-slate-200 dark:hover:bg-muted'
                >
                  <Plus className='h-3.5 w-3.5' />
                  New {titleCase(creatableCollections[0])}
                </button>
              )
            )}
            {creatableCollections.length > 1 && (
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type='button'
                    className='flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 shadow-sm hover:bg-slate-50 dark:border-border dark:bg-card dark:text-slate-200 dark:hover:bg-muted'
                  >
                    <Plus className='h-3.5 w-3.5' />
                    New
                    <ChevronDown className='h-3 w-3 opacity-60' />
                  </button>
                </PopoverTrigger>
                <PopoverContent align='end' className='w-56 p-1'>
                  {creatableCollections.map((c) => (
                    <button
                      key={c}
                      type='button'
                      onClick={() =>
                        itemNav.open({
                          collection: c,
                          itemId: 'new',
                          layoutSlug: displayConfig?.item_layout ?? null
                        })
                      }
                      className='flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-muted'
                    >
                      <Plus className='h-3 w-3 opacity-60' />
                      {titleCase(c)}
                    </button>
                  ))}
                </PopoverContent>
              </Popover>
            )}
            {importCollection && navigate && (
              <ImportFromFileButton
                collection={importCollection}
                onParsed={(result, template) =>
                  navigate(`/collections/${importCollection}/new`, {
                    state: { importResult: result, importTemplateId: template.id }
                  })
                }
              />
            )}
          </div>
        </div>
      </div>

      <div className='flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-6'>
        {view === 'table' ? (
          <>
            {!filtersOpen && activeFilterCount > 0 && (
              <div className='mb-3 flex flex-wrap items-center gap-1.5'>
                {filterDefs
                  .filter((def) => !isFilterEmpty(filterValues[def.key]))
                  .map((def) => (
                    <span
                      key={def.key}
                      title={def.restricted ? 'Options limited to your restricted scope' : undefined}
                      className={`flex items-center overflow-hidden rounded-md border text-[12px] ${
                        def.restricted
                          ? 'border-amber-400 bg-amber-50/50 dark:border-amber-500/60 dark:bg-amber-500/5'
                          : 'border-slate-200 bg-white dark:border-border dark:bg-card'
                      }`}
                    >
                      <button
                        type='button'
                        onClick={() => setFiltersOpen(true)}
                        title='Edit filters'
                        className='flex items-center gap-1 py-1 pl-2 pr-1 hover:bg-slate-50 dark:hover:bg-muted/50'
                      >
                        <span className='text-slate-500 dark:text-muted-foreground'>
                          {filterDefLabel(def)}:
                        </span>
                        <span className='max-w-[180px] truncate font-medium text-slate-700 dark:text-slate-200'>
                          {displayFilterValue(def, filterValues[def.key] ?? '')}
                        </span>
                      </button>
                      <button
                        type='button'
                        aria-label={`Clear ${filterDefLabel(def)} filter`}
                        onClick={() => {
                          setFilterValues((prev) => ({
                            ...prev,
                            [def.key]: Array.isArray(prev[def.key]) ? [] : ''
                          }))
                          setPage(1)
                        }}
                        className='self-stretch px-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-muted dark:hover:text-foreground'
                      >
                        <X className='h-3 w-3' />
                      </button>
                    </span>
                  ))}
                <button
                  type='button'
                  onClick={() => {
                    setFilterValues({ ...seededFiltersRef.current })
                    setPage(1)
                  }}
                  className='px-1.5 py-1 text-[11px] font-medium text-nvr-navy hover:underline dark:text-nvr-cyan'
                >
                  Clear all
                </button>
              </div>
            )}
            {/* Stretch row: the table card fills the remaining height and
                scrolls internally (DataTable fillHeight); the filter rail
                keeps its own height via self-start. */}
            <div className='flex min-h-0 flex-1 gap-4'>
              {filtersOpen && (
                <aside className='w-[240px] shrink-0 self-start overflow-hidden rounded-lg border border-slate-200 bg-white motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-left-1 motion-safe:duration-200 dark:border-border dark:bg-card'>
                  <div className='flex h-10 items-center justify-between border-b border-slate-100 px-3 dark:border-border'>
                    <span className='text-[12px] font-semibold text-slate-700 dark:text-slate-200'>
                      Filters
                    </span>
                    <span className='flex items-center gap-2'>
                      {activeFilterCount > 0 && (
                        <button
                          type='button'
                          onClick={() => {
                            setFilterValues({ ...seededFiltersRef.current })
                            setPage(1)
                          }}
                          className='text-[11px] font-medium text-nvr-navy hover:underline dark:text-nvr-cyan'
                        >
                          Clear all
                        </button>
                      )}
                      <button
                        type='button'
                        onClick={() => setFiltersOpen(false)}
                        aria-label='Collapse filters'
                        className='rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-muted dark:hover:text-foreground'
                      >
                        <PanelLeftClose className='h-3.5 w-3.5' />
                      </button>
                    </span>
                  </div>
                  <div className='max-h-[calc(100vh-360px)] space-y-3 overflow-y-auto p-3'>
                    {filterDefs.map((def) => (
                      <FilterControl
                        key={def.key}
                        def={def}
                        layout='stacked'
                        value={filterValues[def.key] ?? ''}
                        onChange={(value) => {
                          setFilterValues((prev) => ({ ...prev, [def.key]: value }))
                          setPage(1)
                        }}
                      />
                    ))}
                  </div>
                </aside>
              )}
              <div
                className={cn(
                  'relative min-w-0 flex-1 transition-opacity duration-200',
                  isRefetching && 'pointer-events-none opacity-60'
                )}
                aria-busy={isRefetching || undefined}
              >
                {loadElapsed != null && (
                  <span className='absolute left-1/2 top-6 z-[6] -translate-x-1/2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-600 shadow-lg dark:border-border dark:bg-card dark:text-slate-300'>
                    Still working — {loadElapsed}s
                  </span>
                )}
                <DataTable<QueueItemRow>
                  fillHeight
                  density={density}
                  minBodyHeight={360}
                  columns={columns}
                  rows={items}
                  rowKey={(row) => `${row.collection}:${row.item_id}`}
                  total={data?.total ?? 0}
                  page={page}
                  limit={limit}
                  isLoading={showLoading}
                  onPageChange={setPage}
                  onRowClick={(row) => openItem(row)}
                  onRowContextMenu={(row, e) => {
                    e.preventDefault()
                    setRowCtxMenu({ x: e.clientX, y: e.clientY, row })
                  }}
                  rowClassName={(row) =>
                    highlightedId === rowId(row)
                      ? // Pinned sticky cells use bg-inherit — the highlight must be
                        // OPAQUE (nvr-cyan/5-over-white equivalents) or horizontally
                        // scrolled content bleeds through the pinned columns. Same
                        // pair DataTable uses for selected rows when pins are active.
                        'bg-[#f2fdff] dark:bg-[#20303a]'
                      : row.at_risk
                        ? rowHighlightClass(row.at_risk_color ?? 'red')
                        : undefined
                  }
                  emptyMessage={
                    <EmptyState
                      icon={Inbox}
                      title='Nothing in this queue'
                      detail='Records land here when they match the queue sources — a state change or new record can appear at any moment.'
                    />
                  }
                  sort={sort}
                  onSortChange={(next) => {
                    setSort(next)
                    setPage(1)
                  }}
                  filterDefs={filterDefs}
                  filterValues={filterValues}
                  onFilterChange={(key, value) => {
                    setFilterValues((prev) => ({ ...prev, [key]: value }))
                    setPage(1)
                  }}
                  rowGroups={rowGroups ?? undefined}
                  collapsedGroups={collapsedGroups}
                  onToggleGroup={toggleGroup}
                  selectedIds={bulkActionsEnabled ? selectedIds : undefined}
                  onSelectionChange={bulkActionsEnabled ? setSelectedIds : undefined}
                  hideFilterRow
                  nowrapCells
                  columnPins={effectivePins}
                  onColumnPinChange={(key, pin) => {
                    setColumnPins((prev) => {
                      const next = { ...(prev ?? effectivePins) }
                      if (pin) next[key] = pin
                      else delete next[key]
                      return next
                    })
                  }}
                  columnFilterRow
                  hScrollProxy
                />
              </div>
            </div>
          </>
        ) : view === 'kanban' ? (
          <QueueKanbanBoard
            items={items}
            onCardClick={(row) => openItem(row)}
            onDrop={(item, targetState) => transitionMut.mutate({ item, targetState })}
            onClaim={(row) => claimMut.mutate(row)}
            onRelease={(row) => releaseMut.mutate(row)}
            swimlaneBy={swimlaneBy}
            stateLabels={stateLabelByKey}
            laneLabel={swimlaneBy === 'collection' ? collectionLabel : undefined}
            claimsEnabled={claimsEnabled}
          />
        ) : (
          <QueueWorkloadView queueId={queueId} />
        )}
      </div>

      {bulkActionsEnabled && (
        <QueueBulkBar
          count={selectedIds.length}
          claimsEnabled={claimsEnabled}
          states={(data?.available_values.state ?? []).map((s) => ({
            value: s,
            label: stateLabel(s)
          }))}
          busy={bulkBusy}
          onClaim={() =>
            runBulk('Claim', (row) =>
              client.request(
                post(`/queues/${queueId}/claim`, {
                  source_collection: row.collection,
                  item_id: row.item_id
                })
              )
            )
          }
          onRelease={() =>
            runBulk('Release', (row) =>
              client.request(
                post(`/queues/${queueId}/release`, {
                  source_collection: row.collection,
                  item_id: row.item_id
                })
              )
            )
          }
          onTransition={(state) => runBulk('Transition', (row) => performTransition(row, state))}
          onClear={() => setSelectedIds([])}
        />
      )}

      {drillStack?.length ? (
        <RecordDrilldownSheet
          collection={drillStack[0].collection}
          itemId={drillStack[0].itemId}
          layoutId={drillStack[0].layoutId}
          rootLayoutSlug={drillStack[0].rootLayoutSlug}
          width={drillStack[0].width}
          title={drillStack[0].title}
          stack={drillStack}
          onPush={(target) => drill.push([...drillStack, target])}
          onPop={() => drill.back()}
          // Explicit dismissal unwinds every level in one go.
          onClose={() => drill.back(drillStack.length)}
        />
      ) : null}

      {rowCtxMenu &&
  createPortal(
    <div
      style={{
        position: 'fixed',
        left: Math.min(rowCtxMenu.x, window.innerWidth - 200),
        top: Math.min(rowCtxMenu.y, window.innerHeight - 260),
        zIndex: 125
      }}
      className='w-48 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-xl dark:border-slate-700 dark:bg-slate-900'
      onMouseDown={(e) => e.stopPropagation()}
      data-queue-row-menu
    >
      {[
        { label: 'Open', run: () => openItem(rowCtxMenu.row) },
        {
          label: 'Open full record',
          run: () => openItemPage(rowCtxMenu.row)
        },
        { label: 'Peek', run: () => setSheetItem(rowCtxMenu.row) },
        ...(claimsEnabled
          ? [
              rowCtxMenu.row.claimed_by?.id === userId
                ? { label: 'Release claim', run: () => releaseMut.mutate(rowCtxMenu.row) }
                : { label: 'Claim', run: () => claimMut.mutate(rowCtxMenu.row) }
            ]
          : []),
        {
          label: 'Copy ID',
          run: () => void navigator.clipboard?.writeText(rowCtxMenu.row.item_id)
        },
        {
          label: 'Copy link',
          run: () =>
            void navigator.clipboard?.writeText(
              `${window.location.origin}${itemNav.urlFor({
                collection: rowCtxMenu.row.collection,
                itemId: rowCtxMenu.row.item_id,
                layoutSlug: displayConfig?.item_layout ?? null
              })}`
            )
        },
        // Custom actions (#125): the record's registered actions, right here.
        ...customActionsFor(rowCtxMenu.row.collection).map((a) => ({
          label: a.label,
          run: () => runCustomAction(a, rowCtxMenu.row)
        }))
      ].map((a) => (
        <button
          key={a.label}
          type='button'
          onClick={() => {
            a.run()
            setRowCtxMenu(null)
          }}
          className='block w-full truncate px-3 py-1.5 text-left text-[12px] text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800'
        >
          {a.label}
        </button>
      ))}
      {rowCtxMenu.row.collection !== 'tasks' && (
        <div className='mt-1 border-t border-slate-100 pt-1 dark:border-border/60'>
          <p className='px-3 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400'>
            Triage labels
          </p>
          {triageLabels.slice(0, 8).map((l) => {
            const active = (rowCtxMenu.row.labels ?? []).includes(l)
            return (
              <button
                key={l}
                type='button'
                onClick={() => {
                  toggleTriageLabel(rowCtxMenu.row, l)
                  setRowCtxMenu(null)
                }}
                className='flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800'
              >
                <span
                  className={
                    active
                      ? 'h-1.5 w-1.5 rounded-full bg-violet-500'
                      : 'h-1.5 w-1.5 rounded-full border border-slate-300 dark:border-slate-600'
                  }
                />
                {l}
              </button>
            )
          })}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const input = (e.target as HTMLFormElement).elements.namedItem(
                'newlabel'
              ) as HTMLInputElement
              const v = input.value.trim()
              if (v) {
                toggleTriageLabel(rowCtxMenu.row, v)
                setRowCtxMenu(null)
              }
            }}
            className='px-3 py-1'
          >
            <input
              name='newlabel'
              placeholder='＋ New label…'
              maxLength={60}
              className='h-6 w-full rounded border border-slate-200 bg-transparent px-1.5 text-[11.5px] dark:border-border'
              onMouseDown={(e) => e.stopPropagation()}
            />
          </form>
        </div>
      )}
    </div>,
    document.body
  )}

      {aggDrill &&
        createPortal(
          <AggregateDrillPanel
            queueId={queueId}
            drill={aggDrill}
            onClose={() => setAggDrill(null)}
            onOpenRecord={(collection, id) => {
              setAggDrill(null)
              itemNav.open({ collection, itemId: id, layoutSlug: null })
            }}
          />,
          document.body
        )}
      <QueueItemSheet
        item={sheetItem}
        stateLabels={stateLabelByKey}
        collectionLabel={collectionLabel}
        claimsEnabled={claimsEnabled}
        columnFormats={mergedColumnFormats}
        width={displayConfig?.sheet_width}
        itemLayout={displayConfig?.item_layout}
        onOpenChange={(open) => {
          if (!open) {
            setSheetItem(null)
            setWorkNext(false)
          }
        }}
        onClaim={(row) => claimMut.mutate(row as QueueItemRow)}
        onRelease={(row) => releaseMut.mutate(row as QueueItemRow)}
        workNextActive={workNext}
        onNext={() => sheetItem && startWorkNext(sheetItem)}
        refetchItems={() => qc.invalidateQueries({ queryKey: ['queue-items', queueId] })}
      />
    </div>
  )
}

// ─── Drillable aggregates (#394) ─────────────────────────────────────────────
// The rows behind an aggregate cell — fetched on open, capped 200 server-side.
function AggregateDrillPanel({
  queueId,
  drill,
  onClose,
  onOpenRecord
}: {
  queueId: string
  drill: { row: QueueItemRow; path: string; value: string }
  onClose: () => void
  onOpenRecord: (collection: string, id: string) => void
}) {
  const client = useNivaroClient()
  const { data, isLoading } = useQuery<{
    rows: Array<{ id: string | number; leaf_value: unknown; label: string }>
    target: string | null
    value: unknown
  }>({
    queryKey: ['queue-agg-rows', queueId, drill.row.collection, drill.row.item_id, drill.path],
    queryFn: () =>
      client
        .request<{
          data: {
            rows: Array<{ id: string | number; leaf_value: unknown; label: string }>
            target: string | null
            value: unknown
          }
        }>(
          get(`/queues/${queueId}/aggregate-rows`, {
            collection: drill.row.collection,
            item_id: drill.row.item_id,
            path: drill.path
          })
        )
        .then((r) => r.data)
  })
  return (
    <div className='fixed inset-0 z-[130] flex items-center justify-center bg-black/30 p-6' onClick={onClose}>
      <div
        className='max-h-[70vh] w-[480px] overflow-y-auto rounded-xl border border-slate-200 bg-white p-4 shadow-2xl dark:border-border dark:bg-card'
        onClick={(e) => e.stopPropagation()}
      >
        <div className='mb-2 flex items-start justify-between gap-3'>
          <div>
            <p className='text-[13px] font-semibold'>{drill.row.label}</p>
            <p className='text-[11.5px] text-muted-foreground'>
              {formatColumnHeader(drill.path)} = <span className='tabular-nums'>{drill.value}</span>{' '}
              — the rows behind this number
            </p>
          </div>
          <button
            type='button'
            onClick={onClose}
            className='rounded-md px-2 py-1 text-[12px] text-slate-400 hover:bg-muted'
          >
            ✕
          </button>
        </div>
        {isLoading ? (
          <p className='py-6 text-center text-[12.5px] text-slate-400'>Loading…</p>
        ) : (data?.rows ?? []).length === 0 ? (
          <p className='py-6 text-center text-[12.5px] text-slate-400'>
            No contributing rows resolved.
          </p>
        ) : (
          <ul className='divide-y divide-slate-100 dark:divide-border/60'>
            {data?.rows.map((r) => (
              <li key={String(r.id)} className='flex items-center justify-between gap-3 py-1.5'>
                <button
                  type='button'
                  onClick={() => data.target && onOpenRecord(data.target, String(r.id))}
                  className='min-w-0 truncate text-left text-[12.5px] underline decoration-dotted underline-offset-2 hover:text-nvr-navy dark:hover:text-nvr-cyan'
                >
                  {r.label}
                </button>
                <span className='shrink-0 tabular-nums text-[12px] text-slate-600 dark:text-slate-300'>
                  {r.leaf_value == null ? '—' : String(r.leaf_value)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
