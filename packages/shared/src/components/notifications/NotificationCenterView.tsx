import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlarmClock,
  Archive,
  Bell,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  History,
  Search,
  ShieldCheck,
  Trash2
} from 'lucide-react'
import { Fragment, useEffect, useState } from 'react'
import { useNivaroClient } from '../../context'
import { del, get, patch, post } from '../../lib/commands'
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
import { openInTabs, openInTabsMessage } from '../../lib/open-in-tabs'
import { cn, formatRelative } from '../../lib/utils'
import { hasSnapshotView } from '../NotificationBell'
import { SimpleSelect } from '../ui/SimpleSelect'
import { AsItWasSheet } from './AsItWasSheet'
import {
  bundleAsNotification,
  bundleHeadline,
  bundleLocally,
  categoryChipLabel,
  laneTone,
  type NotificationBundle
} from './bundles'
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

type StatusFilter = 'all' | 'inbox' | 'read' | 'snoozed' | 'archived' | 'sent'
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
  recipients: Array<{
    id: string
    name: string
    read: boolean
    read_at: string | null
    ack?: 'pending' | 'acked' | null
    ack_at?: string | null
  }>
  read_count: number
  /** #2365 — the send asked for acknowledgement. */
  ack_required?: boolean
  ack_count?: number
  total: number
}

interface NotificationRow {
  id: number
  title?: string | null
  subject?: string | null
  message: string | null
  read?: boolean
  archived?: boolean
  /** #2365 — the sender asked for an explicit acknowledgement. */
  ack?: { required: boolean; at: string | null; by: string | null } | null
  created_at?: string | null
  collection: string | null
  item: string | null
  sender?: string | null
  sender_name?: string | null
  snoozed_until?: string | null
  /** #647 — asleep until its record changes, not until a time. */
  snooze_until_change?: boolean
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
  /** #1385 — the record's revision current when the row was written. */
  revision_id?: number | null
}

const STATUS_TABS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'inbox', label: 'Unread' },
  { key: 'read', label: 'Read' },
  { key: 'snoozed', label: 'Snoozed' },
  { key: 'archived', label: 'Archived' },
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
  // #1256 — rows about one record fold into a bundle (default on).
  const [groupByRecord, setGroupByRecord] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  // #1385 — the "as it was" sheet for one row.
  const [asItWas, setAsItWas] = useState<NotificationRow | null>(null)
  // #2409 — multi-select + bulk actions; #2406 — clean-up panel.
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const [selectAllMatching, setSelectAllMatching] = useState(false)
  const [bulkSnoozeOpen, setBulkSnoozeOpen] = useState(false)
  const [cleanOpen, setCleanOpen] = useState(false)
  const [cleanDays, setCleanDays] = useState('30')

  // A different view or page is a different selection.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on view change only
  useEffect(() => {
    setSelected(new Set())
    setSelectAllMatching(false)
    setBulkSnoozeOpen(false)
  }, [status, lane, page, search, collectionFilter])

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
      app ?? null,
      groupByRecord
    ],
    queryFn: () =>
      client
        .request<{
          data: NotificationRow[]
          bundles?: NotificationBundle<NotificationRow>[]
          pinned?: NotificationRow[]
          total: number
        }>(
          get('/notifications', {
            page,
            limit: PAGE_SIZE,
            status: status === 'snoozed' || status === 'sent' ? 'all' : status,
            snoozed: status === 'snoozed' ? 'true' : undefined,
            lane: lane === 'all' ? undefined : lane,
            search: search || undefined,
            collection: collectionFilter || undefined,
            app,
            bundle: groupByRecord ? 'record' : undefined
          })
        )
        .then((r) => {
          // An older server answers rows only — the same fold runs here.
          if (!groupByRecord || r.bundles) return r
          const local = bundleLocally(r.data ?? [])
          return { ...r, data: local.rows, bundles: local.bundles }
        }),
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

  // #2365 — acknowledgement-required rows stay pinned until acknowledged.
  const pinned = status === 'archived' || page > 1 ? [] : (data?.pinned ?? [])
  const pinnedIds = new Set(pinned.map((n) => n.id))
  const notifications = (data?.data ?? []).filter((n) => !pinnedIds.has(n.id))
  const bundles = data?.bundles ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['notifications'] })
    void qc.invalidateQueries({ queryKey: ['notification-count'] })
  }

  const markBundleMut = useMutation({
    mutationFn: (ids: number[]) => client.request(post('/notifications/mark-read', { ids })),
    onSuccess: invalidate,
    onError: () => onError?.('Failed to mark the bundle read')
  })
  const markAllMut = useMutation({
    mutationFn: () => client.request(post('/notifications/mark-all-read')),
    onSuccess: () => {
      invalidate()
      onNotice?.('All notifications marked as read')
    },
    onError: () => onError?.('Failed to mark all read')
  })
  const snoozeMut = useMutation({
    mutationFn: ({
      id,
      until,
      untilChange
    }: {
      id: number
      until: Date | null
      untilChange?: boolean
    }) =>
      client.request(
        post(
          `/notifications/${id}/snooze`,
          untilChange ? { until_change: true } : { until: until ? until.toISOString() : null }
        )
      ),
    onSuccess: (_d, vars) => {
      invalidate()
      setSnoozeMenuId(null)
      onNotice?.(
        vars.untilChange
          ? 'Snoozed — it comes back when someone changes the record'
          : vars.until
            ? 'Snoozed — it will return unread'
            : 'Snooze cleared'
      )
    },
    onError: () => onError?.('Failed to snooze')
  })
  const ackMut = useMutation({
    mutationFn: (id: number) => client.request(post(`/notifications/${id}/acknowledge`)),
    onSuccess: () => {
      invalidate()
      onNotice?.('Acknowledged')
    },
    onError: () => onError?.('Failed to acknowledge')
  })
  const listFilter = () => ({
    status: status === 'snoozed' || status === 'sent' ? 'all' : status,
    snoozed: status === 'snoozed' ? 'true' : undefined,
    lane: lane === 'all' ? undefined : lane,
    search: search || undefined,
    collection: collectionFilter || undefined
  })
  const bulkMut = useMutation({
    mutationFn: (v: { action: 'read' | 'archive' | 'snooze'; until?: Date }) =>
      client.request<{ data: { updated: number } }>(
        post('/notifications/bulk-action', {
          action: v.action,
          until: v.until ? v.until.toISOString() : undefined,
          ...(selectAllMatching ? { filter: listFilter() } : { ids: [...selected] })
        })
      ),
    onSuccess: (r, v) => {
      invalidate()
      setSelected(new Set())
      setSelectAllMatching(false)
      setBulkSnoozeOpen(false)
      const n = r.data?.updated ?? 0
      onNotice?.(
        `${n} notification${n === 1 ? '' : 's'} ${
          v.action === 'read' ? 'marked read' : v.action === 'archive' ? 'archived' : 'snoozed'
        }`
      )
    },
    onError: () => onError?.('That bulk action failed')
  })
  const archiveReadMut = useMutation({
    mutationFn: (days: number) =>
      client.request<{ data: { updated: number } }>(post('/notifications/archive-read', { days })),
    onSuccess: (r) => {
      invalidate()
      onNotice?.(`${r.data?.updated ?? 0} archived — find them under Archived`)
    },
    onError: () => onError?.('Clean-up failed')
  })
  const { data: myPrefs } = useQuery({
    queryKey: ['nvr-profile-prefs'],
    queryFn: () =>
      client
        .request<{ data: { preferences?: Record<string, unknown> | null } }>(get('/users/me'))
        .then((r) => (r.data?.preferences ?? {}) as Record<string, unknown>),
    enabled: cleanOpen
  })
  const autoCleanMut = useMutation({
    mutationFn: (days: number | null) =>
      client.request(patch('/users/me/preferences', { notification_cleanup_days: days })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['nvr-profile-prefs'] })
      onNotice?.('Automatic clean-up saved')
    },
    onError: () => onError?.('Could not save the clean-up setting')
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

  /** One inbox row: subject, message, chips, detail bits, inline actions,
   *  snooze and delete. `indent` = a row inside an expanded record bundle. */
  const toggleSelected = (id: number) => {
    setSelectAllMatching(false)
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const renderRow = (n: NotificationRow, indent = false) => {
    const unread = !n.read
    const target = resolveNotificationTargetFor(n, routes)
    return (
      <div
        className={cn(
          'group relative flex items-start gap-3 py-3 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/40',
          indent ? 'bg-slate-50/50 pl-8 pr-4 dark:bg-muted/30' : 'px-4'
        )}
        data-notification-row={n.id}
        data-nvr-lane-row={n.lane ?? ''}
      >
        <input
          type='checkbox'
          checked={selected.has(n.id)}
          onChange={() => toggleSelected(n.id)}
          aria-label='Select notification'
          data-notification-select={n.id}
          className='mt-1.5 h-3.5 w-3.5 shrink-0'
        />
        <span
          className={cn(
            'mt-2 h-2 w-2 shrink-0 rounded-full',
            unread ? (n.lane === 'critical' ? 'bg-red-500' : 'bg-nvr-cyan') : 'bg-transparent'
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
            <DeliveryChips delivery={n.delivery} mailLogUrl={mailLogUrl} onNavigate={onNavigate} />
            {hasSnapshotView(n) && (
              <button
                type='button'
                data-notification-as-it-was={n.id}
                data-tip='The record as it was when you were told'
                onClick={() => setAsItWas(n)}
                className='inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-700 dark:border-border dark:text-slate-400 dark:hover:bg-muted dark:hover:text-slate-200'
              >
                <History className='h-3 w-3' />
                as it was
              </button>
            )}
          </div>
          <NotificationDetailBits
            detail={n.detail}
            why={n.why}
            delivery={n.delivery}
            subscriptionsPath={subscriptionsPath}
            onNavigate={onNavigate}
            className='mt-1'
          />
          {n.ack?.required && (
            <div className='mt-1.5' data-notification-ack={n.ack.at ? 'acked' : 'pending'}>
              {n.ack.at ? (
                <span className='inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10.5px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'>
                  <ShieldCheck className='h-3 w-3' />
                  Acknowledged {formatRelative(n.ack.at)}
                </span>
              ) : (
                <button
                  type='button'
                  disabled={ackMut.isPending}
                  onClick={() => ackMut.mutate(n.id)}
                  data-notification-acknowledge={n.id}
                  className='inline-flex items-center gap-1 rounded-md bg-nvr-cyan px-2.5 py-1 text-[11.5px] font-medium text-white hover:opacity-90 disabled:opacity-50'
                >
                  <ShieldCheck className='h-3.5 w-3.5' />
                  Acknowledge
                </button>
              )}
            </div>
          )}
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
              {n.snooze_until_change
                ? 'Until it changes'
                : `Until ${new Date(n.snoozed_until).toLocaleString([], {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit'
                  })}`}
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
              {n.collection && n.item != null && (
                <button
                  type='button'
                  disabled={snoozeMut.isPending}
                  onClick={() => snoozeMut.mutate({ id: n.id, until: null, untilChange: true })}
                  className='block w-full border-t border-slate-100 px-3 py-1.5 text-left text-[12px] text-slate-700 hover:bg-muted dark:border-border dark:text-foreground'
                  data-snooze-until-change
                >
                  Until the record changes
                </button>
              )}
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
    )
  }

  /** #1256 — a record bundle: "N things on <record>", category chips, the
   *  most urgent lane's colour; expand lists the rows, open goes to the
   *  record, the check marks the whole bundle read. */
  const renderBundle = (b: NotificationBundle<NotificationRow>) => {
    const key = `${b.collection}:${b.item}`
    const isOpen = expanded.has(key)
    const tone = laneTone(b.lane)
    // A deleted record has nowhere to open — the bundle only expands.
    const target = b.deleted ? null : resolveNotificationTargetFor(bundleAsNotification(b), routes)
    const unreadIds = b.rows.filter((n) => !n.read).map((n) => n.id)
    const toggle = () =>
      setExpanded((s) => {
        const next = new Set(s)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
    return (
      <div
        key={`bundle:${key}`}
        data-notification-bundle={key}
        data-notification-bundle-count={b.count}
        data-notification-bundle-lane={b.lane}
        data-notification-bundle-deleted={b.deleted ? 'true' : undefined}
      >
        <div className='group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/40'>
          <button
            type='button'
            aria-expanded={isOpen}
            aria-label={isOpen ? 'Collapse' : 'Expand'}
            data-notification-bundle-expand={key}
            onClick={toggle}
            className='mt-1 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted dark:hover:text-slate-200'
          >
            <ChevronDown
              className={cn('h-3.5 w-3.5 transition-transform', !isOpen && '-rotate-90')}
            />
          </button>
          <span
            className={cn(
              'mt-2 h-2 w-2 shrink-0 rounded-full',
              b.unread > 0 ? tone.dot : 'bg-transparent'
            )}
          />
          <div className='min-w-0 flex-1'>
            <button type='button' onClick={toggle} className='block w-full text-left'>
              <div className='flex items-baseline gap-2'>
                {b.lane === 'critical' && b.unread > 0 && (
                  <span
                    className={cn(
                      'shrink-0 rounded px-1 text-[9.5px] font-bold uppercase tracking-wide',
                      tone.chip
                    )}
                  >
                    Critical
                  </span>
                )}
                <span
                  className={cn(
                    'truncate text-[13px]',
                    b.unread > 0
                      ? cn('font-medium', tone.text)
                      : 'font-normal text-slate-600 dark:text-slate-400'
                  )}
                >
                  {bundleHeadline(b)}
                </span>
                <span className='shrink-0 text-[10.5px] text-slate-400'>
                  {b.newest ? formatRelative(b.newest) : ''}
                </span>
              </div>
            </button>
            <div className='mt-1 flex flex-wrap items-center gap-1.5'>
              {b.collection_label && (
                <span
                  className='rounded border border-slate-200 px-1.5 py-px text-[10px] font-medium text-slate-500 dark:border-border dark:text-slate-400'
                  data-notification-bundle-collection={b.collection}
                >
                  {b.collection_label}
                </span>
              )}
              {b.deleted && (
                <span
                  className='rounded bg-rose-50 px-1.5 py-px text-[10px] font-semibold text-rose-700 dark:bg-rose-900/30 dark:text-rose-300'
                  title='This record has since been deleted'
                >
                  deleted
                </span>
              )}
              {b.categories.map((c) => (
                <span
                  key={c}
                  className='rounded bg-slate-100 px-1.5 py-px text-[10px] font-medium text-slate-600 dark:bg-muted dark:text-slate-300'
                  data-notification-bundle-category={c}
                >
                  {categoryChipLabel(c)}
                </span>
              ))}
              {target && (
                <button
                  type='button'
                  onClick={() => runNotificationTarget(target, onNavigate)}
                  className='inline-flex items-center gap-1 rounded-full bg-nvr-cyan/10 px-2 py-0.5 text-[10px] font-medium text-nvr-navy hover:bg-nvr-cyan/20 dark:bg-nvr-cyan/15 dark:text-nvr-cyan'
                >
                  <ExternalLink className='h-3 w-3' />
                  Open {b.label}
                </button>
              )}
              {b.unread > 0 && b.unread < b.count && (
                <span className='text-[10.5px] text-slate-400'>{b.unread} unread</span>
              )}
            </div>
          </div>
          {unreadIds.length > 0 && (
            <button
              type='button'
              data-notification-bundle-read={key}
              onClick={() => markBundleMut.mutate(unreadIds)}
              className='inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50 dark:border-border dark:text-slate-300 dark:hover:bg-muted'
            >
              <Check className='h-3 w-3' />
              Mark read
            </button>
          )}
        </div>
        {isOpen && (
          <div
            className='divide-y divide-slate-100 border-t border-slate-100 dark:divide-border dark:border-border'
            data-notification-bundle-rows={key}
          >
            {b.rows.map((n) => (
              <Fragment key={n.id}>{renderRow(n, true)}</Fragment>
            ))}
          </div>
        )}
      </div>
    )
  }

  const visibleCount =
    pinned.length + notifications.length + bundles.reduce((a, b) => a + b.rows.length, 0)
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
          <div className='flex items-center gap-2'>
            <button
              type='button'
              onClick={() => setCleanOpen((o) => !o)}
              data-notification-cleanup-toggle
              className='inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 px-3 text-[12px] font-medium text-slate-700 hover:bg-slate-50 dark:border-border dark:text-foreground dark:hover:bg-muted'
            >
              <Archive className='h-3.5 w-3.5' />
              Clean up
            </button>
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
        </div>
        {cleanOpen && (
          <div
            className='mt-3 space-y-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5 text-[12px] text-slate-600 dark:border-border dark:bg-muted/40 dark:text-muted-foreground'
            data-notification-cleanup
          >
            <div className='flex flex-wrap items-center gap-2'>
              Archive everything read and older than
              <SimpleSelect
                value={cleanDays}
                onChange={setCleanDays}
                ariaLabel='Older than'
                className='h-7 w-auto rounded-md border-slate-200 bg-background px-2 text-[12px] dark:border-border'
                options={[
                  { value: '7', label: '7 days' },
                  { value: '30', label: '30 days' },
                  { value: '90', label: '90 days' },
                  { value: '180', label: '180 days' }
                ]}
              />
              <button
                type='button'
                disabled={archiveReadMut.isPending}
                onClick={() => archiveReadMut.mutate(Number(cleanDays))}
                data-notification-archive-read
                className='h-7 rounded-md bg-slate-900 px-2.5 text-[11.5px] font-medium text-white hover:bg-slate-700 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900'
              >
                {archiveReadMut.isPending ? 'Archiving…' : 'Archive now'}
              </button>
            </div>
            <div className='flex flex-wrap items-center gap-2'>
              Or do it automatically — archive read notifications after
              <SimpleSelect
                value={String(myPrefs?.notification_cleanup_days ?? '')}
                onChange={(v) => autoCleanMut.mutate(v ? Number(v) : null)}
                ariaLabel='Automatic clean-up'
                className='h-7 w-auto rounded-md border-slate-200 bg-background px-2 text-[12px] dark:border-border'
                options={[
                  { value: '', label: 'never' },
                  { value: '30', label: '30 days' },
                  { value: '90', label: '90 days' },
                  { value: '180', label: '180 days' }
                ]}
              />
              <span className='text-[11px] text-slate-400'>
                Archived notifications are kept — open the Archived tab to search them.
              </span>
            </div>
          </div>
        )}
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
          <SimpleSelect
            value={collectionFilter}
            onChange={(v) => {
              setCollectionFilter(v)
              setPage(1)
            }}
            ariaLabel='Collection'
            className='h-8 w-auto rounded-md border-slate-200 bg-background px-2 text-[12.5px] dark:border-border'
            options={[
              { value: '', label: 'All collections' },
              ...collections.map((c) => ({ value: c, label: c }))
            ]}
          />
          <label
            className='flex cursor-pointer items-center gap-1.5 text-[12px] text-slate-500 dark:text-slate-400'
            data-tip='Fold every notification about one record into a single entry'
          >
            <input
              type='checkbox'
              checked={groupByRecord}
              onChange={(e) => setGroupByRecord(e.target.checked)}
              className='h-3.5 w-3.5'
              data-notification-group-by-record
            />
            Group by record
          </label>
        </div>
      </header>

      {status !== 'sent' && selected.size > 0 && (
        <div
          className='flex shrink-0 flex-wrap items-center gap-2 border-b border-nvr-cyan/30 bg-nvr-cyan/5 px-8 py-2 text-[12px] text-slate-700 dark:text-slate-200'
          data-notification-bulkbar
        >
          <span className='font-medium'>
            {selectAllMatching ? `All ${total} matching` : `${selected.size} selected`}
          </span>
          {!selectAllMatching && selected.size >= visibleCount && total > visibleCount && (
            <button
              type='button'
              onClick={() => setSelectAllMatching(true)}
              data-notification-select-matching
              className='text-nvr-navy underline decoration-dotted underline-offset-2 dark:text-nvr-cyan'
            >
              Select all {total} matching
            </button>
          )}
          <span className='mx-1 h-4 w-px bg-slate-300 dark:bg-border' />
          <button
            type='button'
            disabled={bulkMut.isPending}
            onClick={() => bulkMut.mutate({ action: 'read' })}
            data-notification-bulk='read'
            className='inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 bg-background px-2 text-[11.5px] font-medium hover:bg-slate-50 dark:border-border'
          >
            <Check className='h-3 w-3' /> Mark read
          </button>
          <div className='relative'>
            <button
              type='button'
              disabled={bulkMut.isPending}
              onClick={() => setBulkSnoozeOpen((o) => !o)}
              data-notification-bulk='snooze'
              className='inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 bg-background px-2 text-[11.5px] font-medium hover:bg-slate-50 dark:border-border'
            >
              <AlarmClock className='h-3 w-3' /> Snooze
            </button>
            {bulkSnoozeOpen && (
              <div className='absolute left-0 top-8 z-20 w-[180px] rounded-md border border-slate-200 bg-white py-1 shadow-lg dark:border-border dark:bg-card'>
                {snoozePresets().map((pset) => (
                  <button
                    key={pset.label}
                    type='button'
                    onClick={() => bulkMut.mutate({ action: 'snooze', until: pset.until })}
                    className='block w-full px-3 py-1.5 text-left text-[12px] text-slate-700 hover:bg-muted dark:text-foreground'
                  >
                    {pset.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          {status !== 'archived' && (
            <button
              type='button'
              disabled={bulkMut.isPending}
              onClick={() => bulkMut.mutate({ action: 'archive' })}
              data-notification-bulk='archive'
              className='inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 bg-background px-2 text-[11.5px] font-medium hover:bg-slate-50 dark:border-border'
            >
              <Archive className='h-3 w-3' /> Archive
            </button>
          )}
          <button
            type='button'
            onClick={() => {
              const urls: string[] = []
              for (const n of [...pinned, ...notifications, ...bundles.flatMap((b) => b.rows)]) {
                if (!selected.has(n.id)) continue
                const t = resolveNotificationTargetFor(n, routes)
                if (!t) continue
                if (t.type === 'external') urls.push(t.url)
                else if (t.type === 'path' && typeof window !== 'undefined')
                  urls.push(`${window.location.origin}${t.path}`)
              }
              if (urls.length === 0) onNotice?.('None of the selected notifications opens a page')
              else onNotice?.(openInTabsMessage(openInTabs(urls)))
            }}
            data-notification-bulk='tabs'
            className='inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 bg-background px-2 text-[11.5px] font-medium hover:bg-slate-50 dark:border-border'
          >
            <ExternalLink className='h-3 w-3' /> Open in tabs
          </button>
          <button
            type='button'
            onClick={() => {
              setSelected(new Set())
              setSelectAllMatching(false)
            }}
            className='ml-auto text-[11.5px] text-slate-500 underline decoration-dotted underline-offset-2'
          >
            Clear selection
          </button>
        </div>
      )}

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
                      {g.ack_required && (
                        <span
                          className='shrink-0 rounded-full bg-sky-50 px-2 py-0.5 text-[10.5px] font-semibold tabular-nums text-sky-700 dark:bg-sky-400/10 dark:text-sky-300'
                          data-nvr-sent-ack-count
                        >
                          {g.ack_count ?? 0} of {g.total} acknowledged
                        </span>
                      )}
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
                          data-nvr-ack={r.ack ?? undefined}
                          data-tip={
                            r.ack === 'acked'
                              ? `Acknowledged${r.ack_at ? ` ${new Date(r.ack_at).toLocaleString()}` : ''}`
                              : r.ack === 'pending'
                                ? 'Has not acknowledged yet'
                                : r.read && r.read_at
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
                          {r.ack === 'acked' && <ShieldCheck className='h-3 w-3' />}
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
        ) : notifications.length === 0 && bundles.length === 0 && pinned.length === 0 ? (
          <div className='flex flex-col items-center justify-center py-24 text-center'>
            <Bell className='h-10 w-10 text-slate-200 dark:text-slate-700' />
            <p className='mt-3 text-[14px] font-medium text-slate-500'>You're all caught up</p>
            <p className='mt-1 text-[12px] text-slate-400'>
              {status === 'inbox' ? 'No unread notifications.' : 'No notifications here.'}
            </p>
          </div>
        ) : (
          <div className='mx-8 my-6 divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-border dark:border-border dark:bg-card'>
            {pinned.length > 0 && (
              <div data-notification-pinned>
                <div className='bg-amber-50 px-4 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-400/10 dark:text-amber-300'>
                  Needs your acknowledgement · {pinned.length}
                </div>
                {pinned.map((n) => (
                  <Fragment key={`pin:${n.id}`}>{renderRow(n)}</Fragment>
                ))}
              </div>
            )}
            {bundles.map(renderBundle)}
            {notifications.map((n, ni) => {
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
              return (
                <Fragment key={n.id}>
                  {header}
                  {renderRow(n)}
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
      <AsItWasSheet
        notificationId={asItWas?.id ?? null}
        title={asItWas?.subject ?? asItWas?.title ?? null}
        onClose={() => setAsItWas(null)}
      />
    </div>
  )
}
