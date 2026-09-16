import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlarmClock,
  Bell,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Search,
  Trash2
} from 'lucide-react'
import { Fragment, useEffect, useState } from 'react'
import { useNivaroClient } from '../../context'
import { del, get, post } from '../../lib/commands'
import {
  type NotificationActionSpec,
  type NotificationDeliveryRecord,
  type NotificationDetailRecord,
  type NotificationLane,
  type NotificationRouteMap,
  type NotificationTargetSpec,
  type NotificationWhy,
  resolveNotificationTargetFor,
  runNotificationTarget
} from '../../lib/notification-target'
import { cn, formatRelative } from '../../lib/utils'
import { DeliveryChips } from './DeliveryChips'
import { NotificationActions } from './NotificationActions'
import { NotificationDetailBits } from './NotificationDetailBits'

/**
 * The full notifications inbox — lane tabs (Critical / Needs you / FYI),
 * unread/read/snoozed filters, search, collection filter, day headers,
 * per-row delivery chips ("where did this go?"), inline actions with reply
 * boxes, snooze and delete. The admin hosts it at /notifications; a portal
 * can mount it with its own routes. Needs `<NivaroProvider>`.
 */

const PAGE_SIZE = 25

type StatusFilter = 'all' | 'inbox' | 'read' | 'snoozed' | 'sent'
type LaneFilter = 'all' | 'critical' | 'needs_you' | 'fyi'

/** One send the caller made (#64): the rows sharing a subject + minute,
 *  with each recipient's read state. */
interface SentGroup {
  key: string
  subject: string
  message: string | null
  created_at: string | null
  lane: string | null
  category: string | null
  collection: string | null
  item: string | null
  recipients: Array<{ id: string; name: string; read: boolean; read_at: string | null }>
  read_count: number
  total: number
}

interface NotificationRow {
  id: number
  title?: string | null
  subject?: string | null
  message: string | null
  read?: boolean
  created_at?: string | null
  collection: string | null
  item: string | null
  sender?: string | null
  sender_name?: string | null
  snoozed_until?: string | null
  target?: NotificationTargetSpec | null
  kind?: string | null
  target_label?: string | null
  url?: string | null
  actions?: NotificationActionSpec[] | null
  lane?: NotificationLane | null
  category?: string | null
  delivery?: NotificationDeliveryRecord | null
  detail?: NotificationDetailRecord | null
  why?: NotificationWhy | null
}

const STATUS_TABS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'inbox', label: 'Unread' },
  { key: 'read', label: 'Read' },
  { key: 'snoozed', label: 'Snoozed' },
  { key: 'sent', label: 'Sent' }
]
const LANE_TABS: Array<{ key: LaneFilter; label: string }> = [
  { key: 'all', label: 'Every lane' },
  { key: 'critical', label: 'Critical' },
  { key: 'needs_you', label: 'Needs you' },
  { key: 'fyi', label: 'FYI' }
]

/** Preset snooze targets. Times are the user's local clock. */
function snoozePresets(): Array<{ label: string; until: Date }> {
  const now = new Date()
  const hour = new Date(now.getTime() + 60 * 60 * 1000)
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(8, 0, 0, 0)
  const nextWeek = new Date(now)
  nextWeek.setDate(nextWeek.getDate() + ((8 - nextWeek.getDay()) % 7 || 7))
  nextWeek.setHours(8, 0, 0, 0)
  return [
    { label: 'For 1 hour', until: hour },
    { label: 'Until tomorrow 8am', until: tomorrow },
    { label: 'Until next week', until: nextWeek }
  ]
}

export interface NotificationCenterViewProps {
  routes: NotificationRouteMap
  onNavigate: (path: string) => void
  app?: 'portal' | 'admin'
  mailLogUrl?: (mailLogId: number) => string | null
  /** Host route of the subscriptions page (a watch's "Why me?" links there). */
  subscriptionsPath?: string | null
  /** Toast hooks — hosts wire their own toaster. */
  onNotice?: (message: string) => void
  onError?: (message: string) => void
  className?: string
}

export function NotificationCenterView({
  routes,
  onNavigate,
  app,
  mailLogUrl,
  subscriptionsPath,
  onNotice,
  onError,
  className
}: NotificationCenterViewProps) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [status, setStatus] = useState<StatusFilter>('all')
  const [lane, setLane] = useState<LaneFilter>('all')
  // #64 — the Sent tab: read receipts for what I sent (critical by default).
  const [sentCriticalOnly, setSentCriticalOnly] = useState(true)
  const { data: sentGroups = [], isLoading: sentLoading } = useQuery<SentGroup[]>({
    queryKey: ['notifications', 'sent', sentCriticalOnly],
    queryFn: () =>
      client
        .request<{ data: SentGroup[] }>(
          get('/notifications/sent', { lane: sentCriticalOnly ? 'critical' : 'all' })
        )
        .then((r) => r.data ?? []),
    enabled: status === 'sent',
    refetchInterval: status === 'sent' ? 30_000 : false
  })
  const [page, setPage] = useState(1)
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const [snoozeMenuId, setSnoozeMenuId] = useState<number | null>(null)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [collectionFilter, setCollectionFilter] = useState('')

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 350)
    return () => clearTimeout(t)
  }, [searchInput])

  const { data: counts } = useQuery({
    queryKey: ['notification-count'],
    queryFn: () =>
      client.request<{
        unread: number
        attention?: number
        lanes?: { critical: number; needs_you: number; fyi: number }
      }>(get('/notifications/unread-count'))
  })

  const { data, isLoading } = useQuery({
    queryKey: [
      'notifications',
      'center',
      status,
      lane,
      page,
      search,
      collectionFilter,
      app ?? null
    ],
    queryFn: () =>
      client.request<{ data: NotificationRow[]; total: number }>(
        get('/notifications', {
          page,
          limit: PAGE_SIZE,
          status: status === 'snoozed' || status === 'sent' ? 'all' : status,
          snoozed: status === 'snoozed' ? 'true' : undefined,
          lane: lane === 'all' ? undefined : lane,
          search: search || undefined,
          collection: collectionFilter || undefined,
          app
        })
      ),
    placeholderData: keepPreviousData,
    enabled: status !== 'sent'
  })

  const { data: collections = [] } = useQuery<string[]>({
    queryKey: ['notifications', 'center', 'collections'],
    queryFn: () =>
      client
        .request<{ data?: Array<{ collection: string }> } | Array<{ collection: string }>>(
          get('/collections')
        )
        .then((r) => {
          const rows = Array.isArray(r) ? r : (r.data ?? [])
          return [...new Set(rows.map((c) => c.collection))].sort()
        }),
    staleTime: 300_000
  })

  const notifications = data?.data ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['notifications'] })
    void qc.invalidateQueries({ queryKey: ['notification-count'] })
  }

  const markAllMut = useMutation({
    mutationFn: () => client.request(post('/notifications/mark-all-read')),
    onSuccess: () => {
      invalidate()
      onNotice?.('All notifications marked as read')
    },
    onError: () => onError?.('Failed to mark all read')
  })
  const snoozeMut = useMutation({
    mutationFn: ({ id, until }: { id: number; until: Date | null }) =>
      client.request(
        post(`/notifications/${id}/snooze`, { until: until ? until.toISOString() : null })
      ),
    onSuccess: (_d, vars) => {
      invalidate()
      setSnoozeMenuId(null)
      onNotice?.(vars.until ? 'Snoozed — it will return unread' : 'Snooze cleared')
    },
    onError: () => onError?.('Failed to snooze')
  })
  const deleteMut = useMutation({
    mutationFn: (id: number) => client.request(del(`/notifications/${id}`)),
    onSuccess: () => {
      invalidate()
      setConfirmDeleteId(null)
      onNotice?.('Notification deleted')
    },
    onError: () => onError?.('Failed to delete notification')
  })

  const handleRowClick = async (n: NotificationRow) => {
    if (!n.read) {
      await client.request(post(`/notifications/${n.id}/read`)).catch(() => undefined)
      invalidate()
    }
    runNotificationTarget(resolveNotificationTargetFor(n, routes), onNavigate)
  }

  const laneCount = (k: LaneFilter) =>
    k === 'all' ? null : (counts?.lanes?.[k as keyof NonNullable<typeof counts.lanes>] ?? null)

  return (
    <div className={cn('flex flex-1 min-h-0 flex-col', className)} data-nvr-notification-center>
      <header className='shrink-0 border-b border-slate-200 bg-white px-8 py-5 dark:border-border dark:bg-background'>
        <div className='flex items-center justify-between'>
          <div>
            <h1 className='text-xl font-bold text-slate-900 dark:text-slate-100'>Notifications</h1>
            <p className='mt-0.5 text-[13px] text-slate-400'>
              {total} notification{total === 1 ? '' : 's'}
              {counts?.attention != null && counts.attention > 0
                ? ` · ${counts.attention} need${counts.attention === 1 ? 's' : ''} you`
                : ''}
            </p>
          </div>
          <button
            type='button'
            onClick={() => markAllMut.mutate()}
            disabled={markAllMut.isPending}
            className='inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 px-3 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:text-foreground dark:hover:bg-muted'
          >
            <CheckCheck className='h-3.5 w-3.5' />
            {markAllMut.isPending ? 'Marking…' : 'Mark all read'}
          </button>
        </div>
        {/* Lane strip — what the badge counts sits first */}
        <div className='mt-4 flex flex-wrap items-center gap-2'>
          <div className='flex items-center gap-1'>
            {LANE_TABS.map((t) => {
              const c = laneCount(t.key)
              return (
                <button
                  key={t.key}
                  type='button'
                  onClick={() => {
                    setLane(t.key)
                    setPage(1)
                  }}
                  data-nvr-lane={t.key}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors',
                    lane === t.key
                      ? t.key === 'critical'
                        ? 'bg-red-500/10 text-red-700 dark:text-red-400'
                        : 'bg-nvr-cyan/10 text-nvr-navy dark:bg-nvr-cyan/15 dark:text-nvr-cyan'
                      : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700 dark:hover:bg-slate-800/50'
                  )}
                >
                  {t.label}
                  {c != null && c > 0 && (
                    <span className='ml-1.5 rounded-full bg-slate-200 px-1.5 text-[10px] font-bold text-slate-600 dark:bg-slate-700 dark:text-slate-300'>
                      {c}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          <span className='mx-1 h-5 w-px bg-slate-200 dark:bg-border' />
          <div className='flex items-center gap-1'>
            {STATUS_TABS.map((t) => (
              <button
                key={t.key}
                type='button'
                onClick={() => {
                  setStatus(t.key)
                  setPage(1)
                }}
                className={cn(
                  'rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors',
                  status === t.key
                    ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                    : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700 dark:hover:bg-slate-800/50'
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className='relative ml-auto'>
            <Search className='pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder='Search notifications…'
              className='h-8 w-[240px] rounded-md border border-slate-200 bg-background pl-8 pr-2.5 text-[12.5px] dark:border-border'
            />
          </div>
          <select
            value={collectionFilter}
            onChange={(e) => {
              setCollectionFilter(e.target.value)
              setPage(1)
            }}
            aria-label='Collection'
            className='h-8 rounded-md border border-slate-200 bg-background px-2 text-[12.5px] dark:border-border'
          >
            <option value=''>All collections</option>
            {collections.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </header>

      <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
        {status === 'sent' ? (
          <div className='mx-8 my-6 space-y-3' data-nvr-sent>
            <div className='flex flex-wrap items-center gap-3 text-[12px] text-slate-500'>
              <span>
                What you sent, with who has read it. A send is one subject to its recipients; a
                critical send bypasses mutes and quiet hours, so its receipts matter most.
              </span>
              <label className='ml-auto flex cursor-pointer items-center gap-1.5'>
                <input
                  type='checkbox'
                  checked={sentCriticalOnly}
                  onChange={(e) => setSentCriticalOnly(e.target.checked)}
                  className='h-3.5 w-3.5'
                  data-nvr-sent-critical
                />
                Critical only
              </label>
            </div>
            {sentLoading ? (
              <p className='py-10 text-[13px] text-slate-400'>Loading…</p>
            ) : sentGroups.length === 0 ? (
              <div className='flex flex-col items-center justify-center py-24 text-center'>
                <Bell className='h-10 w-10 text-slate-200 dark:text-slate-700' />
                <p className='mt-3 text-[14px] font-medium text-slate-500'>Nothing sent yet</p>
                <p className='mt-1 text-[12px] text-slate-400'>
                  {sentCriticalOnly
                    ? 'No critical sends. Untick "Critical only" to see everything you sent.'
                    : 'Messages you send to stakeholders or colleagues appear here.'}
                </p>
              </div>
            ) : (
              <div className='divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-border dark:border-border dark:bg-card'>
                {sentGroups.map((g) => (
                  <div key={g.key} className='px-4 py-3' data-nvr-sent-row>
                    <div className='flex items-baseline gap-2'>
                      {g.lane === 'critical' && (
                        <span className='shrink-0 rounded bg-red-500/10 px-1 text-[9.5px] font-bold uppercase tracking-wide text-red-600 dark:text-red-400'>
                          Critical
                        </span>
                      )}
                      <span className='truncate text-[13px] font-medium text-slate-900 dark:text-slate-100'>
                        {g.subject.replace(/^critical:\s*/i, '')}
                      </span>
                      <span className='shrink-0 text-[10.5px] text-slate-400'>
                        {formatRelative(g.created_at ?? new Date())}
                      </span>
                      <span
                        className={cn(
                          'ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold tabular-nums',
                          g.read_count === g.total
                            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
                            : 'bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300'
                        )}
                        data-nvr-sent-read-count
                      >
                        {g.read_count} of {g.total} read
                      </span>
                    </div>
                    {g.message && (
                      <p className='mt-0.5 line-clamp-2 text-[12px] text-slate-500'>
                        {g.message.replace(/<[^>]+>/g, '')}
                      </p>
                    )}
                    <div className='mt-1.5 flex flex-wrap gap-1'>
                      {g.recipients.map((r) => (
                        <span
                          key={r.id}
                          className={cn(
                            'inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10.5px]',
                            r.read
                              ? 'border-emerald-200 bg-emerald-50/70 text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-900/10 dark:text-emerald-300'
                              : 'border-slate-200 bg-slate-50 text-slate-500 dark:border-border dark:bg-muted dark:text-slate-400'
                          )}
                          data-nvr-receipt={r.read ? 'read' : 'unread'}
                          data-tip={
                            r.read && r.read_at
                              ? `Read ${new Date(r.read_at).toLocaleString()}`
                              : r.read
                                ? 'Read'
                                : 'Not read yet'
                          }
                        >
                          <span
                            className={cn(
                              'h-1.5 w-1.5 rounded-full',
                              r.read ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'
                            )}
                          />
                          {r.name}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : isLoading ? (
          <p className='px-8 py-10 text-[13px] text-slate-400'>Loading…</p>
        ) : notifications.length === 0 ? (
          <div className='flex flex-col items-center justify-center py-24 text-center'>
            <Bell className='h-10 w-10 text-slate-200 dark:text-slate-700' />
            <p className='mt-3 text-[14px] font-medium text-slate-500'>You're all caught up</p>
            <p className='mt-1 text-[12px] text-slate-400'>
              {status === 'inbox' ? 'No unread notifications.' : 'No notifications here.'}
            </p>
          </div>
        ) : (
          <div className='mx-8 my-6 divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-border dark:border-border dark:bg-card'>
            {notifications.map((n, ni) => {
              const unread = !n.read
              const bucketOf = (ts: string | Date | null | undefined) => {
                if (!ts) return 'Older'
                const d = new Date(ts)
                const now = new Date()
                const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate())
                if (d >= midnight) return 'Today'
                if (d >= new Date(midnight.getTime() - 86400e3)) return 'Yesterday'
                if (d >= new Date(midnight.getTime() - 6 * 86400e3)) return 'This week'
                return 'Older'
              }
              const bucket = bucketOf(n.created_at)
              const prevBucket = ni > 0 ? bucketOf(notifications[ni - 1].created_at) : null
              const header =
                bucket !== prevBucket ? (
                  <div className='bg-slate-50/80 px-4 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400 dark:bg-muted/40'>
                    {bucket}
                  </div>
                ) : null
              const target = resolveNotificationTargetFor(n, routes)
              return (
                <Fragment key={n.id}>
                  {header}
                  <div
                    className='group relative flex items-start gap-3 px-4 py-3 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/40'
                    data-nvr-lane-row={n.lane ?? ''}
                  >
                    <span
                      className={cn(
                        'mt-2 h-2 w-2 shrink-0 rounded-full',
                        unread
                          ? n.lane === 'critical'
                            ? 'bg-red-500'
                            : 'bg-nvr-cyan'
                          : 'bg-transparent'
                      )}
                    />
                    <div className='min-w-0 flex-1'>
                      <button
                        type='button'
                        onClick={() => void handleRowClick(n)}
                        className='block w-full text-left'
                      >
                        <div className='flex items-baseline gap-2'>
                          {n.lane === 'critical' && (
                            <span className='shrink-0 rounded bg-red-500/10 px-1 text-[9.5px] font-bold uppercase tracking-wide text-red-600 dark:text-red-400'>
                              Critical
                            </span>
                          )}
                          {n.lane === 'needs_you' && unread && (
                            <span className='shrink-0 rounded bg-nvr-cyan/10 px-1 text-[9.5px] font-bold uppercase tracking-wide text-nvr-navy dark:text-nvr-cyan'>
                              Needs you
                            </span>
                          )}
                          <span
                            className={cn(
                              'truncate text-[13px]',
                              unread
                                ? 'font-medium text-slate-900 dark:text-slate-100'
                                : 'font-normal text-slate-600 dark:text-slate-400'
                            )}
                          >
                            {n.subject ?? n.title ?? '—'}
                          </span>
                          <span className='shrink-0 text-[10.5px] text-slate-400'>
                            {formatRelative(n.created_at ?? new Date())}
                          </span>
                        </div>
                        {n.message && (
                          <p className='mt-0.5 line-clamp-2 text-[12px] text-slate-500'>
                            {n.message.replace(/<[^>]+>/g, '')}
                          </p>
                        )}
                      </button>
                      <div className='mt-1 flex flex-wrap items-center gap-2'>
                        {n.sender_name && (
                          <span className='text-[11px] text-slate-400'>From {n.sender_name}</span>
                        )}
                        {target && (
                          <button
                            type='button'
                            onClick={() => runNotificationTarget(target, onNavigate)}
                            className='inline-flex items-center gap-1 rounded-full bg-nvr-cyan/10 px-2 py-0.5 text-[10px] font-medium text-nvr-navy hover:bg-nvr-cyan/20 dark:bg-nvr-cyan/15 dark:text-nvr-cyan'
                          >
                            {target.type === 'chat'
                              ? 'Open chat'
                              : target.type === 'external'
                                ? 'Open in app ↗'
                                : n.target_label && n.kind !== 'record'
                                  ? `${n.target_label}${n.item ? ` #${n.item}` : ''}`
                                  : n.collection === '__chat__'
                                    ? 'Chat'
                                    : n.collection
                                      ? `${n.collection}${n.item ? ` #${n.item}` : ''}`
                                      : 'Open'}
                          </button>
                        )}
                        <DeliveryChips
                          delivery={n.delivery}
                          mailLogUrl={mailLogUrl}
                          onNavigate={onNavigate}
                        />
                      </div>
                      <NotificationDetailBits
                        detail={n.detail}
                        why={n.why}
                        delivery={n.delivery}
                        subscriptionsPath={subscriptionsPath}
                        onNavigate={onNavigate}
                        className='mt-1'
                      />
                      {n.actions && n.actions.length > 0 && (
                        <NotificationActions
                          actions={unread ? n.actions : n.actions.filter((a) => !!a.input)}
                          notificationId={n.id}
                          size='sm'
                          onError={onError}
                          onDone={() => onNotice?.('Done')}
                          className='mt-1.5'
                        />
                      )}
                    </div>
                    <div className='relative shrink-0'>
                      {n.snoozed_until && new Date(n.snoozed_until) > new Date() ? (
                        <button
                          type='button'
                          onClick={() => snoozeMut.mutate({ id: n.id, until: null })}
                          className='inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10.5px] font-medium text-amber-700 hover:bg-amber-100 dark:bg-amber-400/10 dark:text-amber-300'
                          data-tip='Click to wake now'
                        >
                          <AlarmClock className='h-3 w-3' />
                          Until{' '}
                          {new Date(n.snoozed_until).toLocaleString([], {
                            month: 'short',
                            day: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit'
                          })}
                        </button>
                      ) : (
                        <button
                          type='button'
                          onClick={() => setSnoozeMenuId(snoozeMenuId === n.id ? null : n.id)}
                          className='rounded p-1.5 text-slate-300 opacity-0 transition-all hover:bg-amber-50 hover:text-amber-500 group-hover:opacity-100 dark:hover:bg-amber-400/10'
                          aria-label='Snooze notification'
                        >
                          <AlarmClock className='h-3.5 w-3.5' />
                        </button>
                      )}
                      {snoozeMenuId === n.id && (
                        <div className='absolute right-0 top-8 z-20 w-[180px] rounded-md border border-slate-200 bg-white py-1 shadow-lg dark:border-border dark:bg-card'>
                          {snoozePresets().map((pset) => (
                            <button
                              key={pset.label}
                              type='button'
                              disabled={snoozeMut.isPending}
                              onClick={() => snoozeMut.mutate({ id: n.id, until: pset.until })}
                              className='block w-full px-3 py-1.5 text-left text-[12px] text-slate-700 hover:bg-muted dark:text-foreground'
                            >
                              {pset.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className='shrink-0'>
                      {confirmDeleteId === n.id ? (
                        <div className='flex items-center gap-1.5'>
                          <button
                            type='button'
                            onClick={() => setConfirmDeleteId(null)}
                            className='h-6 rounded-md border border-slate-200 px-2 text-[11px] dark:border-border'
                          >
                            Cancel
                          </button>
                          <button
                            type='button'
                            disabled={deleteMut.isPending}
                            onClick={() => deleteMut.mutate(n.id)}
                            className='h-6 rounded-md bg-red-500 px-2 text-[11px] text-white hover:bg-red-600'
                          >
                            {deleteMut.isPending ? 'Deleting…' : 'Delete'}
                          </button>
                        </div>
                      ) : (
                        <button
                          type='button'
                          onClick={() => setConfirmDeleteId(n.id)}
                          className='rounded p-1.5 text-slate-300 opacity-0 transition-all hover:bg-red-50 hover:text-red-400 group-hover:opacity-100'
                          aria-label='Delete notification'
                        >
                          <Trash2 className='h-3.5 w-3.5' />
                        </button>
                      )}
                    </div>
                  </div>
                </Fragment>
              )
            })}
          </div>
        )}
        {status !== 'sent' && total > PAGE_SIZE && (
          <div className='mx-8 mb-6 flex items-center justify-between'>
            <p className='text-[12px] text-slate-400'>
              Page {page} of {totalPages}
            </p>
            <div className='flex items-center gap-2'>
              <button
                type='button'
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className='inline-flex h-7 items-center rounded-md border border-slate-200 px-2 text-[12px] disabled:opacity-40 dark:border-border'
              >
                <ChevronLeft className='mr-1 h-3.5 w-3.5' />
                Previous
              </button>
              <button
                type='button'
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className='inline-flex h-7 items-center rounded-md border border-slate-200 px-2 text-[12px] disabled:opacity-40 dark:border-border'
              >
                Next
                <ChevronRight className='ml-1 h-3.5 w-3.5' />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
