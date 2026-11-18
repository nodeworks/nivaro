import {
  markAllNotificationsRead,
  markNotificationRead,
  markNotificationsRead,
  readUnreadNotificationCount
} from '@nivaro/sdk'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Bell,
  Check,
  CheckCheck,
  ChevronDown,
  ExternalLink,
  History,
  Search,
  ShieldCheck,
  X
} from 'lucide-react'
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNivaroClient } from '../context'
import { get, post } from '../lib/commands'
import { createCoalescer } from '../lib/live-counts'
import { useLiveRefetchInterval } from '../lib/live-queries'
import { useTopInserts } from '../lib/live-screen'
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
} from '../lib/notification-target'
import { isNewTabClick, notificationPeekTarget, useRecordPeek } from '../lib/record-peek'
import { cn, formatRelative } from '../lib/utils'
import { AgentBadge } from './AgentBadge'
import { LiveCount } from './LiveCount'
import { AsItWasSheet } from './notifications/AsItWasSheet'
import {
  bundleAsNotification,
  bundleHeadline,
  bundleLocally,
  categoryChipLabel,
  laneTone,
  type NotificationBundle
} from './notifications/bundles'
import { DeliveryChips } from './notifications/DeliveryChips'
import { NotificationActions } from './notifications/NotificationActions'
import { NotificationDetailBits, ResolvedLine } from './notifications/NotificationDetailBits'
import { RelativeTime } from './RelativeTime'
import { SkeletonBar } from './Skeletons'

// Server serialize() shape. The SDK's NotificationItem carries the raw
// columns; the bell needs the click-target extras too, so it types the rows
// itself and treats the page payload as this.
export interface BellNotification {
  id: number
  title: string
  message: string | null
  read: boolean
  created_at: string
  collection: string | null
  item: string | null
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
  /** #2365 — the sender asked for an explicit acknowledgement. */
  ack?: { required: boolean; at: string | null; by: string | null } | null
  /** Army 6 M48 — the record's friendly id ("CR26-81410"); null when nothing
   *  names it (or the reader can't read the collection). Never a row id. */
  record_label?: string | null
  /** The collection's singular name ("Workflow"). */
  record_collection_label?: string | null
}

/**
 * The header of a bell group (army 6 M48: it read "WORKFLOWS · 372960", the
 * row id). A record row: "Workflow CR26-81410" — the collection's singular
 * name and the record's friendly id, or the name alone when nothing names the
 * record. Non-record rows: the target's label only (its item is an internal
 * id). Chat: "Chat". Nothing for rows about nowhere in particular. Pure.
 */
export function bellGroupLabel(
  first:
    | Pick<
        BellNotification,
        'target_label' | 'kind' | 'collection' | 'record_label' | 'record_collection_label'
      >
    | null
    | undefined
): string | null {
  if (!first) return null
  if (first.target_label && first.kind !== 'record') return first.target_label
  if (String(first.collection ?? '') === '__chat__') return 'Chat'
  if (!first.collection) return null
  const word =
    first.record_collection_label?.trim() ||
    (() => {
      const w = String(first.collection).replace(/_/g, ' ').trim()
      return w ? w.charAt(0).toUpperCase() + w.slice(1) : null
    })()
  const label = first.record_label?.trim()
  if (word && label) return `${word} ${label}`
  return label || word || null
}

export type BellLaneTab = 'attention' | 'fyi' | 'all'

/** #3079 — a record-change row offers "What changed": the changed fields read as the reader
 *  on open (GET /notifications/:id/changes). */
export function offersChanges(n: {
  kind?: string | null
  target?: NotificationTargetSpec | null
  collection?: string | null
  item?: string | null
  category?: string | null
  revision_id?: number | null
  detail?: NotificationDetailRecord | null
}): boolean {
  if (!hasSnapshotView(n)) return false
  return (
    n.revision_id != null ||
    (n.detail?.changes?.length ?? 0) > 0 ||
    n.category === 'watch' ||
    n.category === 'workflow'
  )
}

/** A record-kind row offers "as it was" — the snapshot from send time. */
export function hasSnapshotView(n: {
  kind?: string | null
  target?: NotificationTargetSpec | null
  collection?: string | null
  item?: string | null
}): boolean {
  const kind = n.target?.kind ?? n.kind ?? (n.collection && n.item ? 'record' : null)
  if (kind !== 'record') return false
  const collection = n.target?.collection ?? n.collection
  const id = n.target?.id ?? n.item
  return !!collection && id != null && id !== '' && !/^(nivaro|directus)_|^__/i.test(collection)
}

export interface NotificationBellProps {
  /** Where each notification kind lands in the host app. */
  routes: NotificationRouteMap
  /** Host router push — the bell never imports a router itself. */
  onNavigate: (path: string) => void
  /** Which app's routes the server should resolve fallback urls for (?app=…). */
  app?: 'portal' | 'admin'
  /**
   * Realtime hookup: invoke the callback whenever a notification arrives and
   * return an unsubscribe. The bell refreshes its queries; anything else
   * (sounds, toasts) stays in the host's handler.
   */
  subscribe?: (onNew: () => void) => () => void
  /** Extra classes for the trigger button (host header styling). */
  buttonClassName?: string
  /** Extra classes for the popup panel (position/size overrides). */
  panelClassName?: string
  /** Rendered above the tab strip inside the panel (host strips such as
   *  "3 access requests waiting on an admin"). */
  beforeList?: ReactNode
  /** Added to the badge count (host-side items the inbox does not hold). */
  extraBadge?: number
  /** Host route for a mail-log row — turns the email delivery chip into a
   *  link. Absent = chips are plain. */
  mailLogUrl?: (mailLogId: number) => string | null
  /** Replace the trigger button entirely (the popup still positions against
   *  the wrapper). */
  renderTrigger?: (state: { open: boolean; badge: number; toggle: () => void }) => ReactNode
  /** Path of the full notifications page — renders a "See all" footer link. */
  allPath?: string | null
  /** Path of the subscriptions page — a watch's "Why me?" offers a Manage link. */
  subscriptionsPath?: string | null
  /** Path of Profile → Notification rules — "Why?" offers a change link there (#3078). */
  rulesPath?: string | null
  /** Called with an error message when an inline action fails. */
  onActionError?: (message: string) => void
  /** Where the panel opens relative to the trigger. 'below' (default) keeps
   *  it inside the trigger's tree; 'right' portals it to document.body and
   *  positions it beside the trigger — for a sidebar rail whose overflow
   *  would clip an inline panel. */
  panelPlacement?: 'below' | 'right'
  /** @deprecated The tab count moved to `TabCountHost`; this does nothing. */
  tabBadge?: boolean
}

/** Feed keys for the bell's held-insert lists (R8). */
const bellRowKey = (n: { id: number }) => `n:${n.id}`
const bellBundleKey = (b: { collection: string; item: string | number }) =>
  `b:${b.collection}:${b.item}`

/**
 * The Nivaro notification bell — the same setup the admin uses: badge that
 * counts what NEEDS YOU (Critical + Needs-you lanes, never FYI), lane tabs,
 * rows grouped by record (five updates on one workflow read as one story),
 * group-level open + mark-read, inline server-approved actions including
 * reply boxes, per-row delivery chips (where did this go?), and
 * click-through routing via the shared notification-target resolver. Needs
 * `<NivaroProvider>`.
 */
export function NotificationBell({
  routes,
  onNavigate,
  app,
  subscribe,
  buttonClassName,
  panelClassName,
  beforeList,
  extraBadge = 0,
  mailLogUrl,
  renderTrigger,
  allPath,
  subscriptionsPath,
  rulesPath,
  onActionError,
  panelPlacement = 'below'
}: NotificationBellProps) {
  const client = useNivaroClient()
  const peek = useRecordPeek()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<BellLaneTab>('attention')
  // Search: what is typed, and what the list asks the server for (250 ms
  // after the last key). Cleared when the panel closes — a fresh open is the
  // normal inbox, never a stale search.
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 250)
    return () => clearTimeout(t)
  }, [searchInput])
  useEffect(() => {
    if (open) return
    setSearchInput('')
    setSearch('')
  }, [open])
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [fixedPos, setFixedPos] = useState<{ left: number; bottom: number } | null>(null)
  const qc = useQueryClient()

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['notification-count'] })
    void qc.invalidateQueries({ queryKey: ['notifications'] })
  }

  // #2450 — with a socket hookup new notifications arrive through `subscribe` and reads from
  // other tabs through read:changed (useUserSync), so the count only needs a slow safety poll.
  // Two minutes, not five: a timed snooze coming back sends no event.
  const countPoll = useLiveRefetchInterval(60_000, { enabled: !!subscribe, safetyMs: 120_000 })
  const { data: counts } = useQuery({
    queryKey: ['notification-count'],
    queryFn: () => client.request(readUnreadNotificationCount()),
    refetchInterval: countPoll
  })
  const unread = counts?.unread ?? 0
  // An older server answers only `unread` — fall back to it so the badge
  // never reads zero against a real inbox.
  const attention = counts?.attention ?? unread
  const lanes = counts?.lanes ?? { critical: 0, needs_you: 0, fyi: 0 }
  // The badge is EVERY unread row — an FYI you have not seen is still unread.
  // Red when a critical one is among them; `attention` only sizes the tab.
  const badge = unread + extraBadge
  // The browser tab's count is no longer the bell's: TabCountHost carries what is waiting on
  // the person (the My Work figure), so a glance at another tab says whether to come back.

  // #1256 — the server folds rows that name the same record into bundles
  // (`bundle=record`); an older server answers rows only and the same rule
  // runs here so the panel reads the same either way.
  const { data: page, isPlaceholderData: pageStale } = useQuery({
    queryKey: ['notifications', 'bell', app ?? null, tab, search],
    queryFn: () =>
      client
        .request<{
          data: BellNotification[]
          bundles?: NotificationBundle<BellNotification>[]
          pinned?: BellNotification[]
        }>(
          get('/notifications', {
            limit: 60,
            app,
            bundle: 'record',
            ...(search ? { search } : {}),
            ...(tab === 'attention' ? { lane: 'attention', status: 'inbox' } : {}),
            ...(tab === 'fyi' ? { lane: 'fyi', status: 'inbox' } : {})
          })
        )
        .then((r) => {
          const pinned = r.pinned ?? []
          const ids = new Set(pinned.map((n) => n.id))
          const rows = (r.data ?? []).filter((n) => !ids.has(n.id))
          if (r.bundles) return { rows, bundles: r.bundles, pinned }
          return { ...bundleLocally(rows), pinned }
        }),
    enabled: open,
    // R8: a lane switch keeps the last list (dimmed) until the new lane answers — no
    // "Nothing needs you" flash between them.
    placeholderData: keepPreviousData
  })
  // R8: new notifications slide in at the top only while the list is scrolled to the top;
  // scrolled down they wait behind "N new" and the row about to be clicked stays put.
  const feedOn = open && !!page && !pageStale
  const rowFeed = useTopInserts(page ? page.rows : undefined, bellRowKey, {
    enabled: feedOn,
    resetKey: `${tab}|${app ?? ''}|${search}`
  })
  const bundleFeed = useTopInserts(page ? page.bundles : undefined, bellBundleKey, {
    enabled: feedOn,
    resetKey: `${tab}|${app ?? ''}|${search}`
  })
  const notifications = page ? rowFeed.rows : []
  // #2365 — acknowledgement-required rows stay pinned above the lists.
  const pinnedRows = page?.pinned ?? []
  const bundles = page ? bundleFeed.rows : []
  const heldNew = rowFeed.held + bundleFeed.held
  const rowRoot = rowFeed.rootRef
  const bundleRoot = bundleFeed.rootRef
  // One stable ref for both feeds: an inline callback ref re-runs on every render (null, then
  // the element), re-wiring both scroll watchers each time.
  const listRef = useCallback(
    (el: HTMLDivElement | null) => {
      rowRoot(el)
      bundleRoot(el)
    },
    [rowRoot, bundleRoot]
  )
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  // The snapshot sheet lives OUTSIDE the panel: opening it closes the panel
  // (a sheet under the panel's z-index would paint behind it) and the sheet
  // keeps its own state.
  const [asItWas, setAsItWas] = useState<BellNotification | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: invalidate is stable per client/qc; re-subscribing on every render would leak listeners
  // A burst of new notifications is one re-read of the count and list (2 s quiet window).
  const invalidateRef = useRef(invalidate)
  invalidateRef.current = invalidate
  useEffect(() => {
    if (!subscribe) return
    const co = createCoalescer(() => invalidateRef.current())
    const off = subscribe(() => co.poke())
    return () => {
      off()
      co.cancel()
    }
  }, [subscribe])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (rootRef.current?.contains(t) || panelRef.current?.contains(t)) return
      setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])
  // 'right' placement: fixed position beside the trigger, bottom-aligned
  // (a sidebar footer opens upward-right), re-measured on resize/scroll.
  useEffect(() => {
    if (!open || panelPlacement !== 'right') return
    const measure = () => {
      const r = rootRef.current?.getBoundingClientRect()
      if (!r) return
      setFixedPos({
        left: Math.round(r.right + 12),
        bottom: Math.max(8, Math.round(window.innerHeight - r.bottom))
      })
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [open, panelPlacement])

  const acknowledge = useMutation({
    mutationFn: (id: number) => client.request(post(`/notifications/${id}/acknowledge`)),
    onSuccess: invalidate
  })
  const markRead = useMutation({
    mutationFn: (id: number) => client.request(markNotificationRead(id)),
    onSuccess: invalidate
  })
  const markGroup = useMutation({
    mutationFn: (ids: number[]) => client.request(markNotificationsRead(ids)),
    onSuccess: invalidate
  })
  const markAll = useMutation({
    mutationFn: () => client.request(markAllNotificationsRead()),
    onSuccess: invalidate
  })

  // Group by record — five updates on one workflow read as one story, not
  // five rows. Record-less notifications stay individual.
  const shown = useMemo(() => notifications.slice(0, 40), [notifications])
  const groups = useMemo(() => {
    const map = new Map<
      string,
      { key: string; collection: string | null; item: string | null; rows: BellNotification[] }
    >()
    for (const n of shown) {
      const key = n.collection && n.item ? `${n.collection}:${n.item}` : `single:${n.id}`
      const g = map.get(key) ?? {
        key,
        collection: n.collection ?? null,
        item: n.item ?? null,
        rows: []
      }
      g.rows.push(n)
      map.set(key, g)
    }
    return [...map.values()]
  }, [shown])

  const openTarget = (n: BellNotification, e?: React.MouseEvent) => {
    // Realtime #17: a plain record notification opens in the app's record sheet; the person
    // stays where they were. The row's "Open record" button still goes to the full page.
    const peekAt = peek ? notificationPeekTarget(n) : null
    if (peekAt && peek && !isNewTabClick(e)) {
      setOpen(false)
      peek.open(peekAt)
      return
    }
    const target = resolveNotificationTargetFor(n, routes)
    if (target) {
      setOpen(false)
      runNotificationTarget(target, onNavigate)
    }
  }

  const navigateAndClose = (p: string) => {
    setOpen(false)
    onNavigate(p)
  }

  /** One notification row + its action strip and detail bits. `hasRecord`
   *  rows open their target on click; `indent` is the bundle expand list.
   *
   *  A row is a button only when ITS target resolves in this app. One with
   *  nowhere to go (a monitor notice, a broadcast) is plain text with its own
   *  Mark read button: a row-sized button that does nothing once the row is
   *  read was clicked again and again on the first day live. */
  const renderRow = (n: BellNotification, hasRecord: boolean, indent = false) => {
    const opens = resolveNotificationTargetFor(n, routes) != null
    const pad = `py-2 pr-3 ${indent ? 'pl-7' : 'pl-3'}`
    const body = (
      <>
        <span
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
            n.read ? 'bg-transparent' : n.lane === 'critical' ? 'bg-red-500' : 'bg-nvr-cyan'
          }`}
        />
        <span className='min-w-0 flex-1'>
          <span
            className={`block truncate text-[12.5px] ${
              n.read
                ? 'font-normal text-slate-600 dark:text-slate-400'
                : 'font-medium text-slate-900 dark:text-slate-100'
            }`}
          >
            {n.lane === 'critical' && !n.read && (
              <span className='mr-1 rounded bg-red-500/10 px-1 text-[9.5px] font-bold uppercase tracking-wide text-red-600 dark:text-red-400'>
                Critical
              </span>
            )}
            {n.title}
          </span>
          {n.message && (
            <span className='mt-0.5 line-clamp-2 whitespace-pre-line text-[11px] leading-snug text-slate-500'>
              {n.message.replace(/<[^>]+>/g, '')}
            </span>
          )}
          <ResolvedLine resolved={n.detail?.resolved} />
          <span className='mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-slate-400'>
            <RelativeTime value={n.created_at} />
            <AgentBadge label={n.detail?.via_agent} />
            <DeliveryChips
              delivery={n.delivery}
              mailLogUrl={mailLogUrl}
              onNavigate={navigateAndClose}
            />
            {hasSnapshotView(n) && (
              // biome-ignore lint/a11y/useSemanticElements: nested inside the row's <button> — a real <button> is invalid there
              <span
                role='button'
                tabIndex={-1}
                data-notification-as-it-was={n.id}
                data-tip='The record as it was when you were told'
                onClick={(e) => {
                  e.stopPropagation()
                  setOpen(false)
                  setAsItWas(n)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    e.stopPropagation()
                    setOpen(false)
                    setAsItWas(n)
                  }
                }}
                className='inline-flex items-center gap-0.5 rounded px-1 text-[10.5px] text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted dark:hover:text-slate-200'
              >
                <History className='h-3 w-3' />
                Record when sent
              </span>
            )}
          </span>
        </span>
      </>
    )
    const markReadClass =
      'mt-0.5 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted dark:hover:text-slate-200'
    return (
      <Fragment key={n.id}>
        {opens ? (
          <button
            type='button'
            onClick={(e) => {
              if (!n.read) markRead.mutate(n.id)
              openTarget(n, e)
            }}
            className={`flex w-full items-start gap-2.5 text-left transition-colors hover:bg-slate-50 dark:hover:bg-muted ${pad}`}
            data-notification-row={n.id}
          >
            {body}
            {!hasRecord && !n.read && (
              // biome-ignore lint/a11y/useSemanticElements: nested inside the row's <button> — a real <button> is invalid there
              <span
                role='button'
                tabIndex={-1}
                aria-label='Mark read'
                data-tip='Mark read'
                onClick={(e) => {
                  e.stopPropagation()
                  markRead.mutate(n.id)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    e.stopPropagation()
                    markRead.mutate(n.id)
                  }
                }}
                className={markReadClass}
              >
                <Check className='h-3 w-3' />
              </span>
            )}
          </button>
        ) : (
          <div
            className={`flex w-full items-start gap-2.5 text-left ${pad}`}
            data-notification-row={n.id}
            data-notification-plain
          >
            {body}
            {/* Kept in the layout once read (hidden, out of the tab order):
                taking it away widened the text column, so a two-line message
                re-wrapped to one and the rows below jumped up. */}
            <button
              type='button'
              aria-label='Mark read'
              data-tip='Mark read'
              tabIndex={n.read ? -1 : undefined}
              onClick={() => markRead.mutate(n.id)}
              className={cn(markReadClass, 'shrink-0', n.read && 'invisible')}
            >
              <Check className='h-3 w-3' />
            </button>
          </div>
        )}
        {n.ack?.required && !n.ack.at && (
          <div className={`pb-2 pr-3 ${indent ? 'pl-[46px]' : 'pl-[30px]'}`}>
            <button
              type='button'
              disabled={acknowledge.isPending}
              onClick={() => acknowledge.mutate(n.id)}
              data-notification-acknowledge={n.id}
              className='inline-flex items-center gap-1 rounded-md bg-nvr-cyan px-2 py-1 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-50'
            >
              <ShieldCheck className='h-3 w-3' />
              Acknowledge
            </button>
          </div>
        )}
        {n.actions && n.actions.length > 0 && !n.read && !n.detail?.resolved && (
          <NotificationActions
            actions={n.actions}
            notificationId={n.id}
            onError={onActionError}
            className={`pb-2 pr-3 ${indent ? 'pl-[46px]' : 'pl-[30px]'}`}
          />
        )}
        <NotificationDetailBits
          detail={n.detail}
          why={n.why}
          delivery={n.delivery}
          notificationId={n.id}
          recordChanges={offersChanges(n)}
          subscriptionsPath={subscriptionsPath}
          rulesPath={rulesPath}
          onNavigate={navigateAndClose}
          className={`pb-3 pr-3 ${indent ? 'pl-[46px]' : 'pl-[30px]'}`}
        />
      </Fragment>
    )
  }

  /** #1256 — a record bundle: "N things on <record>", category chips, the
   *  most urgent lane's colour; expand lists the rows, open goes to the
   *  record, the check marks the whole bundle read. */
  const renderBundle = (b: NotificationBundle<BellNotification>) => {
    const key = `${b.collection}:${b.item}`
    const isOpen = expanded.has(key)
    const tone = laneTone(b.lane)
    // A deleted record has nowhere to open — the bundle only expands.
    const target = b.deleted ? null : resolveNotificationTargetFor(bundleAsNotification(b), routes)
    const unreadIds = b.rows.filter((n) => !n.read).map((n) => n.id)
    return (
      <div
        key={`bundle:${key}`}
        className='border-b border-slate-50 last:border-b-0 dark:border-border/50'
        data-notification-bundle-deleted={b.deleted ? 'true' : undefined}
        data-notification-bundle={key}
        data-notification-bundle-count={b.count}
        data-notification-bundle-lane={b.lane}
      >
        <div className='flex items-start gap-2 px-3 py-2'>
          <button
            type='button'
            aria-expanded={isOpen}
            aria-label={isOpen ? 'Collapse' : 'Expand'}
            data-notification-bundle-expand={key}
            onClick={() =>
              setExpanded((s) => {
                const next = new Set(s)
                if (next.has(key)) next.delete(key)
                else next.add(key)
                return next
              })
            }
            className='mt-0.5 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted dark:hover:text-slate-200'
          >
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${isOpen ? '' : '-rotate-90'}`}
            />
          </button>
          <button
            type='button'
            onClick={() => {
              if (target) {
                setOpen(false)
                runNotificationTarget(target, onNavigate)
              } else {
                setExpanded((s) => new Set(s).add(key))
              }
            }}
            className='min-w-0 flex-1 text-left'
          >
            <span className='flex items-center gap-1.5'>
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${b.unread > 0 ? tone.dot : 'bg-transparent'}`}
              />
              <span
                className={`truncate text-[12.5px] ${b.unread > 0 ? `font-medium ${tone.text}` : 'font-normal text-slate-600 dark:text-slate-400'}`}
              >
                {bundleHeadline(b)}
              </span>
            </span>
            <span className='mt-1 flex flex-wrap items-center gap-1 pl-3.5 text-[10.5px] text-slate-400'>
              {b.lane === 'critical' && b.unread > 0 && (
                <span
                  className={`rounded px-1 text-[9.5px] font-bold uppercase tracking-wide ${tone.chip}`}
                >
                  Critical
                </span>
              )}
              {b.collection_label && (
                <span
                  className='rounded border border-slate-200 px-1 py-px text-[9.5px] font-medium text-slate-500 dark:border-border dark:text-slate-400'
                  data-notification-bundle-collection={b.collection}
                >
                  {b.collection_label}
                </span>
              )}
              {b.deleted && (
                <span
                  className='rounded bg-rose-50 px-1 py-px text-[9.5px] font-semibold text-rose-700 dark:bg-rose-900/30 dark:text-rose-300'
                  data-notification-bundle-gone
                  data-tip='This record has since been deleted'
                >
                  deleted
                </span>
              )}
              {b.categories.map((c) => (
                <span
                  key={c}
                  className='rounded bg-slate-100 px-1 py-px text-[9.5px] font-medium text-slate-600 dark:bg-muted dark:text-slate-300'
                  data-notification-bundle-category={c}
                >
                  {categoryChipLabel(c)}
                </span>
              ))}
              <span>{b.newest ? formatRelative(b.newest) : ''}</span>
              {b.unread > 0 && b.unread < b.count && <span>· {b.unread} unread</span>}
            </span>
          </button>
          <span className='flex shrink-0 items-center gap-0.5'>
            {target && (
              <button
                type='button'
                aria-label='Open record'
                data-tip='Open record'
                data-notification-open-record
                onClick={() => {
                  setOpen(false)
                  runNotificationTarget(target, onNavigate)
                }}
                className='rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted dark:hover:text-slate-200'
              >
                <ExternalLink className='h-3 w-3' />
              </button>
            )}
            {unreadIds.length > 0 && (
              <button
                type='button'
                aria-label='Mark read'
                data-tip='Mark read'
                data-notification-bundle-read={key}
                onClick={() => markGroup.mutate(unreadIds)}
                className='rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted dark:hover:text-slate-200'
              >
                <Check className='h-3 w-3' />
              </button>
            )}
          </span>
        </div>
        {isOpen && (
          <div
            className='border-t border-slate-50 bg-slate-50/50 dark:border-border/50 dark:bg-muted/30'
            data-notification-bundle-rows={key}
          >
            {b.rows.map((n) => renderRow(n, true, true))}
          </div>
        )}
      </div>
    )
  }

  const TABS: Array<{ key: BellLaneTab; label: string; count: number | null }> = [
    { key: 'attention', label: 'Needs you', count: attention },
    { key: 'fyi', label: 'FYI', count: lanes.fyi },
    { key: 'all', label: 'All', count: null }
  ]
  // Open on the lane that actually holds unread rows: nothing needs you but
  // FYI does → land on FYI instead of an empty Needs-you list.
  const toggle = () =>
    setOpen((o) => {
      if (!o && tab === 'attention' && attention === 0 && lanes.fyi > 0) setTab('fyi')
      return !o
    })

  return (
    <div ref={rootRef} className='relative' data-nvr-notification-bell>
      {renderTrigger ? (
        renderTrigger({ open, badge, toggle })
      ) : (
        <button
          type='button'
          onClick={toggle}
          className={
            buttonClassName ??
            'relative rounded-md p-1.5 text-slate-500 transition-colors hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-muted'
          }
          aria-label={badge ? `Notifications (${badge} unread)` : 'Notifications'}
        >
          <Bell className='h-4 w-4' strokeWidth={1.8} />
          {badge > 0 && (
            <span
              data-nvr-recording-hide
              className={`absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9.5px] font-bold ${
                lanes.critical > 0 ? 'bg-red-500 text-white' : 'bg-nvr-cyan text-nvr-navy'
              }`}
            >
              <LiveCount value={badge > 99 ? '99+' : badge} />
            </span>
          )}
        </button>
      )}
      {open &&
        (panelPlacement === 'right' ? createPortal : (n: ReactNode) => n)(
          <div
            ref={panelRef}
            className={`${
              panelPlacement === 'right' ? 'fixed z-[110]' : 'absolute right-0 top-10 z-40'
            } w-[360px] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-border dark:bg-card ${panelClassName ?? ''}`}
            style={
              panelPlacement === 'right' && fixedPos
                ? { left: fixedPos.left, bottom: fixedPos.bottom }
                : undefined
            }
            data-nvr-notification-panel
          >
            {beforeList}
            <div className='flex items-center justify-between border-b border-slate-100 px-3 py-2 dark:border-border/60'>
              <div className='flex items-center gap-1 rounded-md bg-slate-100 p-0.5 dark:bg-muted'>
                {TABS.map((t) => (
                  <button
                    key={t.key}
                    type='button'
                    onClick={() => setTab(t.key)}
                    data-nvr-lane-tab={t.key}
                    className={
                      tab === t.key
                        ? 'rounded bg-white px-2 py-0.5 text-[11px] font-medium text-slate-900 shadow-sm dark:bg-card dark:text-slate-100'
                        : 'rounded px-2 py-0.5 text-[11px] font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400'
                    }
                  >
                    {t.label}
                    {t.count != null && t.count > 0 && (
                      <span
                        className={`ml-1 rounded-full px-1 text-[9.5px] font-bold ${
                          t.key === 'attention' && lanes.critical > 0
                            ? 'bg-red-500/15 text-red-600 dark:text-red-400'
                            : 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300'
                        }`}
                      >
                        <LiveCount value={t.count} />
                      </span>
                    )}
                  </button>
                ))}
              </div>
              {unread > 0 && (
                <button
                  type='button'
                  onClick={() => markAll.mutate()}
                  className='inline-flex items-center gap-1 text-[11px] font-medium text-slate-400 transition-colors hover:text-nvr-cyan'
                >
                  <CheckCheck className='h-3.5 w-3.5' strokeWidth={2} />
                  Mark all read
                </button>
              )}
            </div>
            <div className='border-b border-slate-100 px-3 py-1.5 dark:border-border/60'>
              <div className='relative'>
                <Search
                  className='pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400'
                  aria-hidden='true'
                />
                <input
                  type='search'
                  value={searchInput}
                  onChange={(e) => {
                    const v = e.target.value
                    // A search looks through everything, read or not: from
                    // "Needs you" (unread only) the person would miss the
                    // notice they already opened. They can narrow again.
                    if (v.trim() && !searchInput.trim() && tab !== 'all') setTab('all')
                    setSearchInput(v)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && searchInput) {
                      e.stopPropagation()
                      setSearchInput('')
                    }
                  }}
                  placeholder='Search notifications'
                  aria-label='Search notifications'
                  data-nvr-notification-search
                  className='h-7 w-full rounded-md border border-slate-200 bg-background pl-7 pr-7 text-[12px] placeholder:text-slate-400 focus:border-nvr-cyan focus:outline-none dark:border-border [&::-webkit-search-cancel-button]:hidden'
                />
                {searchInput && (
                  <button
                    type='button'
                    aria-label='Clear search'
                    data-tip='Clear search'
                    onClick={() => setSearchInput('')}
                    className='absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted dark:hover:text-slate-200'
                  >
                    <X className='h-3 w-3' />
                  </button>
                )}
              </div>
            </div>
            <div
              ref={listRef}
              className={cn(
                'max-h-96 overflow-y-auto transition-opacity',
                pageStale && 'opacity-60'
              )}
              aria-busy={!page || pageStale || undefined}
            >
              {heldNew > 0 && (
                <div className='sticky top-0 z-[1] flex justify-center py-1'>
                  <button
                    type='button'
                    data-notification-new-pill={heldNew}
                    onClick={() => {
                      rowFeed.reveal()
                      bundleFeed.reveal()
                    }}
                    className='rounded-full border border-nvr-cyan/40 bg-white px-2.5 py-0.5 text-[11px] font-medium text-nvr-navy shadow-sm hover:bg-nvr-cyan/10 dark:bg-card dark:text-nvr-cyan'
                  >
                    {heldNew} new
                  </button>
                </div>
              )}
              {pinnedRows.length > 0 && (
                <div data-notification-pinned>
                  <div className='bg-amber-50 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-400/10 dark:text-amber-300'>
                    Needs your acknowledgement
                  </div>
                  {pinnedRows.map((n) => (
                    <Fragment key={n.id}>
                      {renderRow(n, !!resolveNotificationTargetFor(n, routes))}
                    </Fragment>
                  ))}
                </div>
              )}
              {!page ? (
                <div className='space-y-3 px-3 py-4' data-notification-loading>
                  {[72, 88, 64].map((w) => (
                    <div key={w} className='space-y-1.5'>
                      <SkeletonBar width={`${w}%`} />
                      <SkeletonBar width='40%' className='h-2.5' />
                    </div>
                  ))}
                </div>
              ) : groups.length === 0 && bundles.length === 0 && pinnedRows.length === 0 ? (
                <p className='px-3 py-6 text-center text-[12px] text-slate-400'>
                  {search
                    ? `No notifications match “${search}”.`
                    : tab === 'attention'
                      ? 'Nothing needs you right now.'
                      : tab === 'fyi'
                        ? 'No FYI notifications.'
                        : 'No notifications'}
                </p>
              ) : (
                [
                  ...bundles.map(renderBundle),
                  ...groups.map((g) => {
                    const unreadIds = g.rows.filter((n) => !n.read).map((n) => n.id)
                    // The group's target = its newest row's (rows share collection + item).
                    const target = resolveNotificationTargetFor(g.rows[0], routes)
                    const hasRecord = !!target
                    // Header label (bellGroupLabel): "Workflow CR26-81410" for record
                    // rows, the target's kind otherwise — never a row id.
                    const first = g.rows.find((r) => r.record_label) ?? g.rows[0]
                    const groupLabel = bellGroupLabel(first)
                    return (
                      <div
                        key={g.key}
                        className='border-b border-slate-50 last:border-b-0 dark:border-border/50'
                      >
                        {hasRecord && groupLabel && (
                          <div className='flex items-center gap-1.5 px-3 pt-2'>
                            <span className='truncate text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
                              {groupLabel}
                              {g.rows.length > 1 ? ` · ${g.rows.length}` : ''}
                            </span>
                            <span className='ml-auto flex items-center gap-0.5'>
                              <button
                                type='button'
                                aria-label='Open record'
                                data-tip='Open record'
                                data-notification-open-record
                                onClick={() => {
                                  if (unreadIds.length) markGroup.mutate(unreadIds)
                                  setOpen(false)
                                  runNotificationTarget(target, onNavigate)
                                }}
                                className='rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted dark:hover:text-slate-200'
                              >
                                <ExternalLink className='h-3 w-3' />
                              </button>
                              {unreadIds.length > 0 && (
                                <button
                                  type='button'
                                  aria-label='Mark read'
                                  data-tip='Mark read'
                                  onClick={() => markGroup.mutate(unreadIds)}
                                  className='rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted dark:hover:text-slate-200'
                                >
                                  <Check className='h-3 w-3' />
                                </button>
                              )}
                            </span>
                          </div>
                        )}
                        {g.rows.map((n) => renderRow(n, hasRecord))}
                      </div>
                    )
                  })
                ]
              )}
            </div>
            {allPath && (
              <button
                type='button'
                onClick={() => {
                  setOpen(false)
                  onNavigate(allPath)
                }}
                className='block w-full border-t border-slate-100 px-3 py-1.5 text-center text-[11px] font-medium text-slate-500 hover:text-nvr-cyan dark:border-border/60'
              >
                See all notifications
              </button>
            )}
          </div>,
          document.body
        )}
      <AsItWasSheet
        notificationId={asItWas?.id ?? null}
        title={asItWas?.title ?? null}
        onClose={() => setAsItWas(null)}
      />
    </div>
  )
}
