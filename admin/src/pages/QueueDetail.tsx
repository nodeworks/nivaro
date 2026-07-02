import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { SlidersHorizontal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { io, type Socket } from 'socket.io-client'
import { toast } from 'sonner'
import { type Column, DataTable } from '@/components/data-table'
import { QueueKanbanBoard } from '@/components/queue-kanban-board'
import { QueueWorkloadView } from '@/components/queue-workload-view'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
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
  sources?: QueueSource[]
  available_extra_fields?: string[]
}

type Scope = 'mine' | 'unowned' | 'all' | 'claimed'

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

// ─── Page ─────────────────────────────────────────────────────────────────────

export function QueueDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [scope, setScope] = useState<Scope>('all')
  const [page, setPage] = useState(1)
  const [view, setView] = useState<'table' | 'kanban' | 'workload'>('table')
  const limit = 25

  const { data: queue } = useQuery<QueueMeta>({
    queryKey: ['queue-meta', id],
    queryFn: () => api.get(`/queues/${id}`).then((r) => r.data.data),
    enabled: !!id
  })

  const { user } = useAuth()
  const socketRef = useRef<Socket | null>(null)

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
      qc.invalidateQueries({ queryKey: ['queue-items', id] })
      qc.invalidateQueries({ queryKey: ['queue-workload', id] })
    })

    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, [id, queue?.sources, user?.static_token, qc])

  const { data, isLoading } = useQuery<{ data: QueueItemRow[]; stats: QueueStats }>({
    queryKey: ['queue-items', id, scope],
    queryFn: () => api.get(`/queues/${id}/items`, { params: { scope } }).then((r) => r.data),
    enabled: !!id
  })

  const transitionMut = useMutation({
    mutationFn: async ({ item, targetState }: { item: QueueItemRow; targetState: string }) => {
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
  const start = (page - 1) * limit
  const pageItems = items.slice(start, start + limit)

  const baseColumns: Column<QueueItemRow>[] = [
    {
      key: 'collection',
      header: 'Collection',
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
      render: (row) =>
        row.owners.length ? (
          <span className='text-[12px] text-slate-600 dark:text-slate-300'>
            {row.owners.map((o) => o.name).join(', ')}
          </span>
        ) : (
          <span className='text-slate-300'>No owners</span>
        )
    },
    { key: 'aging_hours', header: 'Aging', render: (row) => formatAging(row.aging_hours) },
    { key: 'sla_status', header: 'SLA', render: (row) => <SlaPill status={row.sla_status} /> },
    {
      key: 'at_risk',
      header: 'Risk',
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
    header: field,
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

  const columns: Column<QueueItemRow>[] = [
    ...baseColumns.filter((c) => c.key === 'label' || effectiveVisible.has(c.key)),
    ...extraColumns.filter((c) => effectiveVisible.has(c.key)),
    claimColumn
  ]

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
        <div
          className='mb-4 grid gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border'
          style={{
            gridTemplateColumns: `repeat(${Math.min(stateEntries.length + 1, 6)}, minmax(0, 1fr))`
          }}
        >
          <div className='bg-white px-4 py-3.5 dark:bg-card'>
            <p className='mb-1 text-[11px] font-medium text-slate-400 dark:text-muted-foreground'>
              Total
            </p>
            {isLoading ? (
              <Skeleton className='h-6 w-16 rounded' />
            ) : (
              <p className='text-[22px] font-semibold leading-none tabular-nums text-slate-900 dark:text-foreground'>
                {formatNumber(stats?.total ?? 0)}
              </p>
            )}
          </div>
          {stateEntries.map(([state, count]) => (
            <div key={state} className='bg-white px-4 py-3.5 dark:bg-card'>
              <p className='mb-1 text-[11px] font-medium text-slate-400 dark:text-muted-foreground'>
                {state}
              </p>
              <p className='text-[22px] font-semibold leading-none tabular-nums text-slate-900 dark:text-foreground'>
                {formatNumber(count)}
              </p>
            </div>
          ))}
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
                <div className='space-y-1.5'>
                  {TOGGLEABLE_KEYS.map((key) => {
                    const col = [...baseColumns, ...extraColumns].find((c) => c.key === key)
                    const inputId = `col-toggle-${key}`
                    return (
                      <div key={key} className='flex items-center gap-2 text-[12px]'>
                        <Checkbox
                          id={inputId}
                          checked={effectiveVisible.has(key)}
                          onCheckedChange={() => handleToggleColumn(key)}
                        />
                        <Label htmlFor={inputId} className='cursor-pointer text-[12px] font-normal'>
                          {typeof col?.header === 'string' ? col.header : key}
                        </Label>
                      </div>
                    )
                  })}
                </div>
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
            rows={pageItems}
            rowKey={(row) => `${row.collection}:${row.item_id}`}
            total={items.length}
            page={page}
            limit={limit}
            isLoading={isLoading}
            onPageChange={setPage}
            onRowClick={(row) => navigate(row.url)}
            emptyMessage='Nothing in this queue.'
          />
        ) : view === 'kanban' ? (
          <QueueKanbanBoard
            items={items}
            onCardClick={(row) => navigate(row.url)}
            onDrop={(item, targetState) => transitionMut.mutate({ item, targetState })}
            onClaim={(row) => claimMut.mutate(row)}
            onRelease={(row) => releaseMut.mutate(row)}
          />
        ) : (
          <QueueWorkloadView queueId={id!} />
        )}
      </div>
    </div>
  )
}
