import {
  markAllNotificationsRead,
  markNotificationRead,
  markNotificationsRead,
  readUnreadNotificationCount
} from '@nivaro/sdk'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Check, CheckCheck, ChevronDown, ExternalLink, History } from 'lucide-react'
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNivaroClient } from '../context'
import { get } from '../lib/commands'
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
import { useTabAttention } from '../lib/tab-attention'
import { formatRelative } from '../lib/utils'
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
import { NotificationDetailBits } from './notifications/NotificationDetailBits'

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
}

export type BellLaneTab = 'attention' | 'fyi' | 'all'

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
  /** Called with an error message when an inline action fails. */
  onActionError?: (message: string) => void
  /** Where the panel opens relative to the trigger. 'below' (default) keeps
   *  it inside the trigger's tree; 'right' portals it to document.body and
   *  positions it beside the trigger — for a sidebar rail whose overflow
   *  would clip an inline panel. */
  panelPlacement?: 'below' | 'right'
  /** Put the attention count in front of the browser tab title (default true). */
  tabBadge?: boolean
}

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
  onActionError,
  panelPlacement = 'below',
  tabBadge = true
}: NotificationBellProps) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<BellLaneTab>('attention')
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [fixedPos, setFixedPos] = useState<{ left: number; bottom: number } | null>(null)
  const qc = useQueryClient()

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['notification-count'] })
    void qc.invalidateQueries({ queryKey: ['notifications'] })
  }

  const { data: counts } = useQuery({
    queryKey: ['notification-count'],
    queryFn: () => client.request(readUnreadNotificationCount()),
    refetchInterval: 60_000
  })
  const unread = counts?.unread ?? 0
  // An older server answers only `unread` — fall back to it so the badge
  // never reads zero against a real inbox.
  const attention = counts?.attention ?? unread
  const lanes = counts?.lanes ?? { critical: 0, needs_you: 0, fyi: 0 }
  // The badge is EVERY unread row — an FYI you have not seen is still unread.
  // Red when a critical one is among them; `attention` only sizes the tab.
  const badge = unread + extraBadge
  // The browser tab carries what needs the person (not every FYI), so a
  // glance at another tab says whether to come back.
  useTabAttention(attention + extraBadge, { enabled: tabBadge })

  // #1256 — the server folds rows that name the same record into bundles
  // (`bundle=record`); an older server answers rows only and the same rule
  // runs here so the panel reads the same either way.
  const { data: page } = useQuery({
    queryKey: ['notifications', 'bell', app ?? null, tab],
    queryFn: () =>
      client
        .request<{ data: BellNotification[]; bundles?: NotificationBundle<BellNotification>[] }>(
          get('/notifications', {
            limit: 60,
            app,
            bundle: 'record',
            ...(tab === 'attention' ? { lane: 'attention', status: 'inbox' } : {}),
            ...(tab === 'fyi' ? { lane: 'fyi', status: 'inbox' } : {})
          })
        )
        .then((r) => {
          const rows = r.data ?? []
          if (r.bundles) return { rows, bundles: r.bundles }
          return bundleLocally(rows)
        }),
    enabled: open
  })
  const notifications = page?.rows ?? []
  const bundles = page?.bundles ?? []
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  // The snapshot sheet lives OUTSIDE the panel: opening it closes the panel
  // (a sheet under the panel's z-index would paint behind it) and the sheet
  // keeps its own state.
  const [asItWas, setAsItWas] = useState<BellNotification | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: invalidate is stable per client/qc; re-subscribing on every render would leak listeners
  useEffect(() => subscribe?.(invalidate), [subscribe])

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

  const openTarget = (n: BellNotification) => {
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
   *  rows open their target on click; `indent` is the bundle expand list. */
  const renderRow = (n: BellNotification, hasRecord: boolean, indent = false) => (
    <Fragment key={n.id}>
      <button
        type='button'
        onClick={() => {
          if (!n.read) markRead.mutate(n.id)
          openTarget(n)
        }}
        className={`flex w-full items-start gap-2.5 py-2 pr-3 text-left transition-colors ${
          indent ? 'pl-7' : 'pl-3'
        } ${hasRecord ? 'hover:bg-slate-50 dark:hover:bg-muted' : 'cursor-default'}`}
        data-notification-row={n.id}
      >
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
            <span className='mt-0.5 line-clamp-2 text-[11px] leading-snug text-slate-500'>
              {n.message.replace(/<[^>]+>/g, '')}
            </span>
          )}
          <span className='mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-slate-400'>
            {formatRelative(n.created_at)}
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
                as it was
              </span>
            )}
          </span>
        </span>
        {!hasRecord && !n.read && (
          // biome-ignore lint/a11y/useSemanticElements: nested inside the row's <button> — a real <button> is invalid there
          <span
            role='button'
            tabIndex={-1}
            title='Mark read'
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
            className='mt-0.5 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted dark:hover:text-slate-200'
          >
            <Check className='h-3 w-3' />
          </span>
        )}
      </button>
      {n.actions && n.actions.length > 0 && !n.read && (
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
        subscriptionsPath={subscriptionsPath}
        onNavigate={navigateAndClose}
        className={`-mt-1 pb-2 pr-3 ${indent ? 'pl-[46px]' : 'pl-[30px]'}`}
      />
    </Fragment>
  )

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
                  title='This record has since been deleted'
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
                title='Open record'
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
                title='Mark all read'
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
              {badge > 99 ? '99+' : badge}
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
                        {t.count}
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
            <div className='max-h-96 overflow-y-auto'>
              {groups.length === 0 && bundles.length === 0 ? (
                <p className='px-3 py-6 text-center text-[12px] text-slate-400'>
                  {tab === 'attention'
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
                    // Header label: the target's kind for non-record rows, the
                    // collection · item for record rows, nothing for rows about
                    // nowhere in particular (broadcasts).
                    const first = g.rows[0]
                    const groupLabel =
                      first?.target_label && first?.kind !== 'record'
                        ? `${first.target_label}${g.item ? ` · ${g.item}` : ''}`
                        : String(g.collection) === '__chat__'
                          ? 'Chat'
                          : g.collection
                            ? `${String(g.collection).replace(/_/g, ' ')}${g.item ? ` · ${g.item}` : ''}`
                            : null
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
                                title='Open record'
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
                                  title='Mark read'
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
