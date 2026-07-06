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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Flame,
  GripVertical,
  RefreshCw,
  Rows3,
  SlidersHorizontal
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { io, type Socket } from 'socket.io-client'
import { toast } from 'sonner'
import { type Column, DataTable, type FilterDef } from '@/components/data-table'
import { QueueBulkBar } from '@/components/queue-bulk-bar'
import { QueueItemSheet } from '@/components/queue-item-sheet'
import { QueueKanbanBoard } from '@/components/queue-kanban-board'
import { QueueWorkloadView } from '@/components/queue-workload-view'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { buildGroups } from '@/lib/queue-grouping'
import { cn, formatNumber } from '@/lib/utils'

const API_URL = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3055'

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
  aging_hours: number | null
  claimed_by: QueueOwner | null
  extra?: Record<string, unknown>
  url: string
}

interface QueueStats {
  total: number
  by_state: Record<string, number>
  unowned: number
  sla_warning: number
  sla_breached: number
  at_risk: number
}

interface QueueSource {
  id: number
  type: 'collection' | 'tasks' | 'approvals' | 'owned_by_me'
  collection: string | null
}

interface QueueMeta {
  id: string
  name: string
  description: string | null
  materialized: boolean
  sources?: QueueSource[]
  available_extra_fields?: string[]
}

type Scope = 'mine' | 'unowned' | 'all' | 'claimed'

interface QueueView {
  id: number
  name: string
  user: string
  is_shared: boolean
  state: {
    scope?: Scope
    filters?: Record<string, string>
    sort?: string
    group_by?: string | null
    view?: 'table' | 'kanban' | 'workload'
  } | null
}

const SCOPE_TABS: { value: Scope; label: string }[] = [
  { value: 'mine', label: 'My Items' },
  { value: 'unowned', label: 'No Owners' },
  { value: 'claimed', label: 'Claimed by me' },
  { value: 'all', label: 'All Items' }
]

function formatAging(hours: number | null): string {
  if (hours == null) return '—'
  if (hours < 1) return '<1h'
  if (hours < 24) return `${Math.round(hours)}h`
  return `${Math.round(hours / 24)}d`
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

function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null
  const w = 64
  const h = 18
  const max = Math.max(...points)
  const min = Math.min(...points)
  const range = max - min || 1
  const step = w / (points.length - 1)
  const path = points
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - 2 - ((v - min) / range) * (h - 4)).toFixed(1)}`)
    .join(' ')
  return (
    <svg width={w} height={h} className='mt-1.5 opacity-40' aria-hidden='true'>
      <path d={path} fill='none' stroke='currentColor' strokeWidth='1.5' />
    </svg>
  )
}

function StatTile({
  label,
  count,
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
  active: boolean
  isLoading?: boolean
  tone?: 'amber' | 'red'
  trend?: number[]
  delta?: number | null
  /** When true a rising delta renders red and a falling one green (breached/at-risk style). */
  deltaBadIsUp?: boolean
  onClick: () => void
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      className={cn(
        'bg-white px-4 py-3.5 text-left transition-colors hover:bg-slate-50 dark:bg-card dark:hover:bg-card/80',
        active && 'ring-1 ring-inset ring-nvr-cyan bg-nvr-cyan/5 dark:bg-nvr-cyan/10'
      )}
    >
      <p
        className={cn(
          'mb-1 text-[11px] font-medium',
          tone === 'red'
            ? 'text-red-500 dark:text-red-400'
            : tone === 'amber'
              ? 'text-amber-600 dark:text-amber-400'
              : 'text-slate-400 dark:text-muted-foreground'
        )}
      >
        {label}
      </p>
      {isLoading ? (
        <Skeleton className='h-6 w-16 rounded' />
      ) : (
        <p className='flex items-baseline gap-1.5 text-[22px] font-semibold leading-none tabular-nums text-slate-900 dark:text-foreground'>
          {formatNumber(count)}
          {delta != null && delta !== 0 && (
            <span
              className={cn(
                'text-[11px] font-medium',
                deltaBadIsUp
                  ? delta > 0
                    ? 'text-red-500'
                    : 'text-emerald-600'
                  : 'text-slate-400'
              )}
            >
              {delta > 0 ? '↑' : '↓'}
              {formatNumber(Math.abs(delta))}
            </span>
          )}
        </p>
      )}
      {trend && <Sparkline points={trend} />}
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

export function QueueDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [scope, setScope] = useState<Scope>('all')
  const [page, setPage] = useState(1)
  const [view, setView] = useState<'table' | 'kanban' | 'workload'>('table')
  const [sort, setSort] = useState('')
  const [filterValues, setFilterValues] = useState<Record<string, string>>({})
  // Single serializable value so Phase 3 saved views can persist it without rework.
  const [groupBy, setGroupBy] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [swimlaneBy, setSwimlaneBy] = useState<'collection' | 'owners' | null>(null)
  // Socket-driven updates no longer refetch under the user — they accumulate here
  // and surface as a "N updates · Refresh" pill the user triggers explicitly.
  const [pendingUpdates, setPendingUpdates] = useState(0)
  const limit = 25

  const { data: queue } = useQuery<QueueMeta>({
    queryKey: ['queue-meta', id],
    queryFn: () => api.get(`/queues/${id}`).then((r) => r.data.data),
    enabled: !!id
  })

  const { user } = useAuth()
  const socketRef = useRef<Socket | null>(null)

  // Non-materialized queues default to priority order — the table's default
  // order IS the triage order. Materialized queues keep server order: priority
  // sorting routes them back to live resolution (sla math is JS-only), which
  // would defeat the 5k+ row cache; the Priority chip remains an explicit opt-in.
  const defaultSortApplied = useRef(false)
  useEffect(() => {
    if (!queue || defaultSortApplied.current) return
    defaultSortApplied.current = true
    if (!queue.materialized) setSort('-priority')
  }, [queue])

  // Live-refresh: join a collection:* room per distinct collection-type source
  // and invalidate this queue's item/workload queries on collection:update, so
  // claims/releases/transitions made by other viewers show up without a manual
  // reload. collection:join is server-gated on a completed `auth` handshake
  // (see api/src/plugins/socketio.ts) — joins are emitted only after we
  // receive `auth:ok`, never synchronously after `connect`/`auth`, or the
  // server silently drops the join and collection:update is never received.
  useEffect(() => {
    if (!id || !queue?.sources) return

    const collections = [
      ...new Set(
        queue.sources
          .filter((s) => s.type === 'collection' && s.collection)
          .map((s) => s.collection as string)
      )
    ]
    if (collections.length === 0) return

    const socket = io(API_URL, { transports: ['websocket', 'polling'], withCredentials: true })
    socketRef.current = socket

    socket.on('connect', () => {
      const token = user?.static_token
      if (token) socket.emit('auth', { token })
    })

    socket.on('auth:ok', () => {
      for (const collection of collections) {
        socket.emit('collection:join', { collection })
      }
    })

    socket.on('collection:update', () => {
      setPendingUpdates((n) => n + 1)
    })

    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, [id, queue?.sources, user?.static_token, qc])

  const apiFilters = (() => {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(filterValues)) {
      if (!value) continue
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

  function clearAllTileFilters() {
    setFilterValues({})
    setScope('all')
    setPage(1)
  }

  const { data, isLoading } = useQuery<{
    data: QueueItemRow[]
    stats: QueueStats
    available_values: { collection: string[]; state: string[] }
    truncated: boolean
    total: number
  }>({
    queryKey: [
      'queue-items',
      id,
      scope,
      sort,
      filterValues,
      view === 'table' && !groupBy ? page : 'all',
      groupBy
    ],
    queryFn: () =>
      api
        .get(`/queues/${id}/items`, {
          params: {
            scope,
            sort,
            filters: JSON.stringify(apiFilters),
            // Grouping renders the full matching set (kanban's existing path) —
            // groups are derived client-side, so pagination pauses while grouped.
            ...(view === 'table' && !groupBy ? { page, limit } : {})
          }
        })
        .then((r) => r.data),
    enabled: !!id
  })

  async function performTransition(item: QueueItemRow, targetState: string) {
    const instanceRes = await api.get(`/pipelines/instance/${item.collection}/${item.item_id}`)
    const instanceData = instanceRes.data.data as {
      states: Array<{ id: string; key: string }>
      available_transitions: Array<{ id: string; to_state: string }>
    } | null
    if (!instanceData || instanceData.states.length === 0) {
      throw new Error('This item has no workflow instance')
    }

    const targetStateRow = instanceData.states.find((s) => s.key === targetState)
    if (!targetStateRow) throw new Error('Target state not found')

    const transition = instanceData.available_transitions.find(
      (t) => t.to_state === targetStateRow.id
    )
    if (!transition) throw new Error('No transition available to move this item here')

    await api.post(`/pipelines/instance/${item.collection}/${item.item_id}/transition`, {
      transition_id: transition.id
    })
  }

  const transitionMut = useMutation({
    mutationFn: async ({ item, targetState }: { item: QueueItemRow; targetState: string }) => {
      await performTransition(item, targetState)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['queue-items', id, scope] })
    },
    onError: (err: unknown) => {
      const resp = (err as { response?: { data?: { error?: string } } })?.response
      const message =
        resp?.data?.error ?? (err instanceof Error ? err.message : 'Failed to move item')
      toast.error(message)
      qc.invalidateQueries({ queryKey: ['queue-items', id, scope] })
    }
  })

  const claimMut = useMutation({
    mutationFn: (item: QueueItemRow) =>
      api.post(`/queues/${id}/claim`, {
        source_collection: item.collection,
        item_id: item.item_id
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['queue-items', id, scope] }),
    onError: () => toast.error('Failed to claim item')
  })

  const releaseMut = useMutation({
    mutationFn: (item: QueueItemRow) =>
      api.post(`/queues/${id}/release`, {
        source_collection: item.collection,
        item_id: item.item_id
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['queue-items', id, scope] }),
    onError: () => toast.error('Failed to release item')
  })

  const { data: subs } = useQuery<{
    data: Array<{ id: number; queue_id: string | null; digest_frequency: string }>
  }>({
    queryKey: ['notification-subscriptions'],
    queryFn: () => api.get('/notification-subscriptions').then((r) => r.data)
  })
  const mySub = subs?.data.find((s) => s.queue_id === id)

  const subscribeMut = useMutation({
    mutationFn: (frequency: 'daily' | 'weekly') =>
      api.post('/notification-subscriptions', { queue_id: id, digest_frequency: frequency }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notification-subscriptions'] })
      toast.success('Subscribed to digest')
    },
    onError: () => toast.error('Failed to subscribe')
  })

  const unsubscribeMut = useMutation({
    mutationFn: (subId: number) => api.delete(`/notification-subscriptions/${subId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notification-subscriptions'] })
      toast.success('Unsubscribed')
    },
    onError: () => toast.error('Failed to unsubscribe')
  })

  const { data: columnPrefs } = useQuery<{ data: { visible_columns: string[] | null } }>({
    queryKey: ['queue-column-prefs', id],
    queryFn: () => api.get(`/queues/${id}/column-prefs`).then((r) => r.data),
    enabled: !!id
  })

  const [visibleColumns, setVisibleColumns] = useState<string[] | null>(null)
  const loadedFromServerRef = useRef(false)
  // Consumed by the debounced-save effect below: setVisibleColumns() in the load
  // effect causes visibleColumns to change on the NEXT render, which would
  // otherwise make the save effect's dependency-changed check pass immediately
  // (loadedFromServerRef is already true by then) and re-PUT the data we just
  // loaded. This flag makes the save effect skip exactly that one transition —
  // but only when there's a real previously-saved value to redundantly resave.
  // When visible_columns is null (user has never customized this queue),
  // setVisibleColumns(null) is a no-op against the initial `useState(null)`, so
  // no render/effect re-run ever happens to consume the flag — leaving it
  // `true` for the user's actual first toggle and silently dropping that save.
  // Only arm the guard when there's a non-null loaded value to protect.
  const skipNextSaveRef = useRef(false)

  useEffect(() => {
    if (!columnPrefs) return
    loadedFromServerRef.current = true
    if (columnPrefs.data.visible_columns !== null) {
      skipNextSaveRef.current = true
    }
    setVisibleColumns(columnPrefs.data.visible_columns)
  }, [columnPrefs])

  const saveColumnPrefsMut = useMutation({
    mutationFn: (cols: string[]) => api.put(`/queues/${id}/column-prefs`, { visible_columns: cols })
  })

  // biome-ignore lint/correctness/useExhaustiveDependencies: only re-run on visibleColumns change; saveColumnPrefsMut is stable per mount and including it would refire on every render
  useEffect(() => {
    if (!loadedFromServerRef.current || visibleColumns === null) return
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false
      return
    }
    const timer = setTimeout(() => {
      saveColumnPrefsMut.mutate(visibleColumns)
    }, 400)
    return () => clearTimeout(timer)
  }, [visibleColumns])

  const items = data?.data ?? []
  const stats = data?.stats
  const stateEntries = stats ? Object.entries(stats.by_state) : []

  // Any completed refetch clears the pending-updates pill — the data on screen
  // is current again, however the refetch was triggered.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on data identity
  useEffect(() => {
    setPendingUpdates(0)
  }, [data])

  function refreshPendingUpdates() {
    qc.invalidateQueries({ queryKey: ['queue-items', id] })
    qc.invalidateQueries({ queryKey: ['queue-workload', id] })
    setPendingUpdates(0)
  }

  // ── Trends (daily snapshots → sparklines + deltas on the global tiles) ──
  const { data: trends } = useQuery<{
    data: Array<{
      snapshot_date: string
      total: number
      unowned: number
      sla_warning: number
      sla_breached: number
      at_risk: number
    }>
  }>({
    queryKey: ['queue-trends', id],
    queryFn: () => api.get(`/queues/${id}/trends`, { params: { days: 14 } }).then((r) => r.data),
    enabled: !!id,
    staleTime: 5 * 60 * 1000
  })

  function trendFor(metric: 'total' | 'unowned' | 'sla_warning' | 'sla_breached' | 'at_risk'): {
    trend?: number[]
    delta?: number | null
  } {
    const rows = trends?.data ?? []
    if (rows.length === 0) return {}
    const series = rows.map((r) => r[metric])
    const last = rows[rows.length - 1]
    return { trend: series, delta: (stats?.[metric] ?? 0) - last[metric] }
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

  // Keep the open sheet's item fresh across refetches (claim/transition update it).
  useEffect(() => {
    if (!sheetItem) return
    const fresh = items.find((r) => rowId(r) === rowId(sheetItem))
    if (fresh && fresh !== sheetItem) setSheetItem(fresh)
    // biome-ignore lint/correctness/useExhaustiveDependencies: sync only when data changes
  }, [items])

  const workNextEligible = (row: QueueItemRow) =>
    !row.claimed_by || row.claimed_by.id === user?.id

  function startWorkNext(after?: QueueItemRow) {
    const startIdx = after ? visibleRows.findIndex((r) => rowId(r) === rowId(after)) + 1 : 0
    const next = visibleRows.slice(startIdx).find(workNextEligible)
    if (!next) {
      setWorkNext(false)
      setSheetItem(null)
      toast.info('Nothing left to work on — queue clear!')
      return
    }
    setWorkNext(true)
    setHighlightedId(rowId(next))
    if (!next.claimed_by) claimMut.mutate(next)
    setSheetItem(next)
  }

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
      const idx = highlightedId
        ? visibleRows.findIndex((r) => rowId(r) === highlightedId)
        : -1
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
        setSheetItem(visibleRows[idx])
      } else if (e.key === 'c' && idx >= 0) {
        e.preventDefault()
        const row = visibleRows[idx]
        row.claimed_by?.id === user?.id ? releaseMut.mutate(row) : claimMut.mutate(row)
      } else if (e.key === 'o' && idx >= 0) {
        e.preventDefault()
        navigate(visibleRows[idx].url)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [view, visibleRows, highlightedId, sheetItem, user?.id, claimMut, releaseMut, navigate])

  // ── Saved views ──
  const { data: views } = useQuery<{ data: QueueView[] }>({
    queryKey: ['queue-views', id],
    queryFn: () => api.get(`/queues/${id}/views`).then((r) => r.data),
    enabled: !!id
  })
  const [activeViewId, setActiveViewId] = useState<number | null>(null)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveShared, setSaveShared] = useState(false)

  function applyView(v: QueueView) {
    const s = v.state ?? {}
    setScope(s.scope ?? 'all')
    setFilterValues(s.filters ?? {})
    setSort(s.sort ?? '')
    setGroupBy(s.group_by ?? null)
    if (s.view) setView(s.view)
    setPage(1)
    setActiveViewId(v.id)
  }

  const saveViewMut = useMutation({
    mutationFn: () =>
      api.post(`/queues/${id}/views`, {
        name: saveName.trim(),
        is_shared: saveShared,
        state: { scope, filters: filterValues, sort, group_by: groupBy, view }
      }),
    onSuccess: (res) => {
      setSaveOpen(false)
      setSaveName('')
      setSaveShared(false)
      setActiveViewId(res.data.data.id as number)
      qc.invalidateQueries({ queryKey: ['queue-views', id] })
      toast.success('View saved')
    },
    onError: () => toast.error('Failed to save view')
  })

  const deleteViewMut = useMutation({
    mutationFn: (viewId: number) => api.delete(`/queues/views/${viewId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['queue-views', id] })
      setActiveViewId(null)
    },
    onError: () => toast.error('Failed to delete view')
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
    qc.invalidateQueries({ queryKey: ['queue-items', id] })
    if (fail) toast.warning(`${label}: ${ok} succeeded, ${fail} failed`)
    else toast.success(`${label}: ${ok} succeeded`)
  }

  const rowGroups = groups?.map((g) => ({
    key: g.key,
    rows: g.rows,
    header: (
      <>
        <span>{g.key}</span>
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

  const baseColumns: Column<QueueItemRow>[] = [
    {
      key: 'collection',
      header: 'Collection',
      sortable: true,
      render: (row) => <Badge variant='outline'>{row.collection}</Badge>
    },
    {
      key: 'label',
      header: 'Item',
      render: (row) => <span className='font-medium'>{row.label}</span>
    },
    {
      key: 'state',
      header: 'State',
      sortable: true,
      render: (row) =>
        row.state ? (
          <span
            className='rounded px-1.5 py-0.5 text-[11px] font-medium'
            style={{
              backgroundColor: row.state_color ? `${row.state_color}1a` : undefined,
              color: row.state_color ?? undefined
            }}
          >
            {row.state}
          </span>
        ) : (
          <span className='text-slate-300'>—</span>
        )
    },
    {
      key: 'owners',
      header: 'Owners',
      sortable: true,
      render: (row) =>
        row.owners.length ? (
          <span className='text-[12px] text-slate-600 dark:text-slate-300'>
            {row.owners.map((o) => o.name).join(', ')}
          </span>
        ) : (
          <span className='text-slate-300'>No owners</span>
        )
    },
    {
      key: 'aging_hours',
      header: 'Aging',
      sortable: true,
      render: (row) => formatAging(row.aging_hours)
    },
    {
      key: 'sla_status',
      header: 'SLA',
      sortable: true,
      render: (row) => <SlaPill status={row.sla_status} />
    },
    {
      key: 'at_risk',
      header: 'Risk',
      sortable: true,
      render: (row) => (row.at_risk ? <span className='text-red-500'>⚑ At risk</span> : null)
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

  const extraColumns: Column<QueueItemRow>[] = extraFieldKeys.map((field) => ({
    key: `extra.${field}`,
    header: formatColumnHeader(field),
    sortable: true,
    render: (row) => {
      const value = row.extra?.[field]
      return value == null || value === '' ? (
        <span className='text-slate-300'>—</span>
      ) : (
        <span className='text-[12px]'>{String(value)}</span>
      )
    }
  }))

  const TOGGLEABLE_KEYS = [
    'collection',
    'state',
    'owners',
    'aging_hours',
    'sla_status',
    'at_risk',
    ...extraFieldKeys.map((f) => `extra.${f}`)
  ]

  const DEFAULT_VISIBLE_COLUMNS = [
    'collection',
    'state',
    'owners',
    'aging_hours',
    'sla_status',
    'at_risk',
    ...extraFieldKeys.slice(0, 2).map((f) => `extra.${f}`)
  ]

  const effectiveVisible = new Set(visibleColumns ?? DEFAULT_VISIBLE_COLUMNS)

  // Render order of the middle (toggleable) columns follows visible_columns'
  // actual array order (the viewer's saved drag-reorder), falling back to
  // TOGGLEABLE_KEYS' order for any column not yet toggled on — so the
  // Customize Columns popover shows a stable, sensible position for a column
  // before it's ever been visible.
  const orderedToggleableKeys = [
    ...(visibleColumns ?? []).filter((k) => TOGGLEABLE_KEYS.includes(k)),
    ...TOGGLEABLE_KEYS.filter((k) => !(visibleColumns ?? []).includes(k))
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
  const allToggleable = [...baseColumns, ...extraColumns]

  const columns: Column<QueueItemRow>[] = [
    labelColumn,
    ...orderedToggleableKeys
      .filter((k) => effectiveVisible.has(k))
      .map((k) => allToggleable.find((c) => c.key === k))
      .filter((c): c is Column<QueueItemRow> => c !== undefined),
    claimColumn
  ]

  const groupOptions: { value: string; label: string }[] = [
    { value: 'state', label: 'State' },
    { value: 'collection', label: 'Collection' },
    { value: 'sla_status', label: 'SLA status' },
    { value: 'at_risk', label: 'At risk' },
    { value: 'owners', label: 'Owner' },
    { value: 'aging', label: 'Aging' },
    ...extraFieldKeys
      .filter((f) => effectiveVisible.has(`extra.${f}`))
      .map((f) => ({ value: `extra.${f}`, label: formatColumnHeader(f) }))
  ]

  const filterDefs: FilterDef[] = [
    {
      key: 'collection',
      placeholder: 'Collection',
      type: 'select' as const,
      options: (data?.available_values.collection ?? []).map((c) => ({ label: c, value: c }))
    },
    {
      key: 'state',
      placeholder: 'State',
      type: 'select' as const,
      options: (data?.available_values.state ?? []).map((s) => ({ label: s, value: s }))
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
    { key: 'label', placeholder: 'Search item…', type: 'text' as const },
    { key: 'owners', placeholder: 'Search owners…', type: 'text' as const },
    ...extraFieldKeys.map((f) => ({
      key: `extra.${f}`,
      placeholder: `Search ${formatColumnHeader(f)}…`,
      type: 'text' as const
    }))
  ].filter((def) => effectiveVisible.has(def.key) || def.key === 'label' || def.key === 'owners')

  function handleToggleColumn(key: string) {
    const current = new Set(effectiveVisible)
    if (current.has(key)) current.delete(key)
    else current.add(key)
    setVisibleColumns([...current])
  }

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <div className='sticky top-0 z-10 shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <h1 className='text-[17px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
          {queue?.name ?? 'Queue'}
        </h1>
        {queue?.description && (
          <p className='mt-0.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
            {queue.description}
          </p>
        )}
      </div>

      <div className='flex-1 overflow-y-auto p-6'>
        {data?.truncated && (
          <div className='mb-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[12px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300'>
            <AlertTriangle className='h-4 w-4 shrink-0' />
            <span>
              {queue?.materialized
                ? 'This request used the live path and hit the row safety limit — the table below may not include every matching item, but the totals above are exact (served from the cache). Clear the priority sort or SLA filter to browse everything.'
                : 'One or more sources in this queue exceeded the row safety limit — some items may be missing from totals and the table below. Totals become exact automatically once the queue finishes promoting to the materialized cache.'}
            </span>
          </div>
        )}
        <div
          className='mb-4 grid gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border'
          style={{
            gridTemplateColumns: `repeat(${Math.min(stateEntries.length + 5, 6)}, minmax(0, 1fr))`
          }}
        >
          <StatTile
            label='Total'
            count={stats?.total ?? 0}
            active={Object.values(filterValues).every((v) => !v) && scope === 'all'}
            isLoading={isLoading}
            {...trendFor('total')}
            onClick={clearAllTileFilters}
          />
          {stateEntries.map(([state, count]) => (
            <StatTile
              key={state}
              label={state}
              count={count}
              active={filterValues.state === state}
              isLoading={isLoading}
              onClick={() => toggleTileFilter('state', state)}
            />
          ))}
          <StatTile
            label='Warning'
            count={stats?.sla_warning ?? 0}
            tone='amber'
            active={filterValues.sla_status === 'warning'}
            isLoading={isLoading}
            deltaBadIsUp
            {...trendFor('sla_warning')}
            onClick={() => toggleTileFilter('sla_status', 'warning')}
          />
          <StatTile
            label='Breached'
            count={stats?.sla_breached ?? 0}
            tone='red'
            active={filterValues.sla_status === 'breached'}
            isLoading={isLoading}
            deltaBadIsUp
            {...trendFor('sla_breached')}
            onClick={() => toggleTileFilter('sla_status', 'breached')}
          />
          <StatTile
            label='At Risk'
            count={stats?.at_risk ?? 0}
            tone='red'
            active={filterValues.at_risk === 'yes'}
            isLoading={isLoading}
            deltaBadIsUp
            {...trendFor('at_risk')}
            onClick={() => toggleTileFilter('at_risk', 'yes')}
          />
          <StatTile
            label='Unowned'
            count={stats?.unowned ?? 0}
            active={scope === 'unowned'}
            isLoading={isLoading}
            deltaBadIsUp
            {...trendFor('unowned')}
            onClick={() => {
              setScope(scope === 'unowned' ? 'all' : 'unowned')
              setPage(1)
            }}
          />
        </div>

        <div className='mb-4 flex items-center gap-1 border-b border-slate-200 dark:border-border'>
          {SCOPE_TABS.map((tab) => (
            <button
              key={tab.value}
              type='button'
              onClick={() => {
                setScope(tab.value)
                setPage(1)
              }}
              className={cn(
                'border-b-2 px-3 py-2 text-[13px] font-medium transition-colors',
                scope === tab.value
                  ? 'border-nvr-cyan text-nvr-navy dark:text-nvr-cyan'
                  : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-muted-foreground'
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {(views?.data.length ?? 0) > 0 || saveOpen ? (
          <div className='mb-3 flex flex-wrap items-center gap-1.5'>
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
                <button type='button' onClick={() => applyView(v)}>
                  {v.name}
                  {v.is_shared && <span className='ml-1 text-slate-400'>· shared</span>}
                </button>
                {v.user === user?.id && (
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
              <PopoverContent className='w-[240px] p-3' align='start'>
                <input
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  placeholder='View name'
                  className='mb-2 w-full rounded-md border border-slate-200 px-2 py-1.5 text-[12px] focus:border-nvr-cyan focus:outline-none dark:border-border dark:bg-card'
                />
                <label className='mb-2 flex items-center gap-2 text-[12px] text-slate-600 dark:text-slate-300'>
                  <Checkbox
                    checked={saveShared}
                    onCheckedChange={(c) => setSaveShared(c === true)}
                  />
                  Share with everyone
                </label>
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
          </div>
        ) : (
          <div className='mb-3'>
            <button
              type='button'
              onClick={() => setSaveOpen(true)}
              className='rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-[11px] font-medium text-slate-500 hover:border-nvr-cyan hover:text-nvr-navy dark:border-border dark:text-slate-400 dark:hover:text-nvr-cyan'
            >
              + Save view
            </button>
          </div>
        )}

        <div className='mb-4 flex items-center gap-1'>
          <button
            type='button'
            onClick={() => setView('table')}
            className={cn(
              'rounded-md px-3 py-1.5 text-[12px] font-medium',
              view === 'table'
                ? 'bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                : 'text-slate-500'
            )}
          >
            Table
          </button>
          <button
            type='button'
            onClick={() => setView('kanban')}
            className={cn(
              'rounded-md px-3 py-1.5 text-[12px] font-medium',
              view === 'kanban'
                ? 'bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                : 'text-slate-500'
            )}
          >
            Kanban
          </button>
          <button
            type='button'
            onClick={() => setView('workload')}
            className={cn(
              'rounded-md px-3 py-1.5 text-[12px] font-medium',
              view === 'workload'
                ? 'bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                : 'text-slate-500'
            )}
          >
            Workload
          </button>
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
          {view === 'table' && visibleRows.length > 0 && (
            <button
              type='button'
              onClick={() => startWorkNext()}
              className='flex items-center gap-1 rounded-md bg-nvr-cyan px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-nvr-cyan/90'
            >
              Work Next ▶
            </button>
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
          {view === 'table' && (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type='button'
                  className='ml-auto flex items-center gap-1 rounded-md px-3 py-1.5 text-[12px] font-medium text-slate-500 hover:text-slate-700 dark:hover:text-foreground'
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
          {mySub ? (
            <button
              type='button'
              onClick={() => unsubscribeMut.mutate(mySub.id)}
              className={cn(
                'rounded-md px-3 py-1.5 text-[12px] font-medium text-slate-500 hover:text-slate-700 dark:hover:text-foreground',
                view !== 'table' && 'ml-auto'
              )}
            >
              Subscribed ({mySub.digest_frequency}) · Unsubscribe
            </button>
          ) : (
            <button
              type='button'
              onClick={() => subscribeMut.mutate('daily')}
              className={cn(
                'rounded-md px-3 py-1.5 text-[12px] font-medium text-nvr-navy hover:bg-nvr-cyan/10 dark:text-nvr-cyan',
                view !== 'table' && 'ml-auto'
              )}
            >
              Get daily digest
            </button>
          )}
        </div>

        {view === 'table' ? (
          <DataTable<QueueItemRow>
            columns={columns}
            rows={items}
            rowKey={(row) => `${row.collection}:${row.item_id}`}
            total={data?.total ?? 0}
            page={page}
            limit={limit}
            isLoading={isLoading}
            onPageChange={setPage}
            onRowClick={(row) => {
              setHighlightedId(rowId(row))
              setSheetItem(row)
            }}
            rowClassName={(row) =>
              highlightedId === rowId(row) ? 'bg-nvr-cyan/5 dark:bg-nvr-cyan/10' : undefined
            }
            emptyMessage='Nothing in this queue.'
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
            selectedIds={selectedIds}
            onSelectionChange={setSelectedIds}
          />
        ) : view === 'kanban' ? (
          <QueueKanbanBoard
            items={items}
            onCardClick={(row) => setSheetItem(row)}
            onDrop={(item, targetState) => transitionMut.mutate({ item, targetState })}
            onClaim={(row) => claimMut.mutate(row)}
            onRelease={(row) => releaseMut.mutate(row)}
            swimlaneBy={swimlaneBy}
          />
        ) : (
          <QueueWorkloadView queueId={id!} />
        )}
      </div>

      <QueueBulkBar
        count={selectedIds.length}
        states={data?.available_values.state ?? []}
        busy={bulkBusy}
        onClaim={() =>
          runBulk('Claim', (row) =>
            api.post(`/queues/${id}/claim`, {
              source_collection: row.collection,
              item_id: row.item_id
            })
          )
        }
        onRelease={() =>
          runBulk('Release', (row) =>
            api.post(`/queues/${id}/release`, {
              source_collection: row.collection,
              item_id: row.item_id
            })
          )
        }
        onTransition={(state) => runBulk('Transition', (row) => performTransition(row, state))}
        onClear={() => setSelectedIds([])}
      />

      <QueueItemSheet
        item={sheetItem}
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
        refetchItems={() => qc.invalidateQueries({ queryKey: ['queue-items', id] })}
      />
    </div>
  )
}
