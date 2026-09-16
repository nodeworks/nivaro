import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  markNotificationsRead,
  readUnreadNotificationCount
} from '@nivaro/sdk'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Check, CheckCheck, ExternalLink } from 'lucide-react'
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNivaroClient } from '../context'
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
import { formatRelative } from '../lib/utils'
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
}

export type BellLaneTab = 'attention' | 'fyi' | 'all'

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
  panelPlacement = 'below'
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
  const badge = attention + extraBadge

  const { data: notifications = [] } = useQuery({
    queryKey: ['notifications', 'bell', app ?? null, tab],
    queryFn: () =>
      client
        .request(
          listNotifications({
            limit: 60,
            app,
            ...(tab === 'attention' ? { lane: 'attention', status: 'inbox' } : {}),
            ...(tab === 'fyi' ? { lane: 'fyi', status: 'inbox' } : {})
          })
        )
        .then((r) => (r.data ?? []) as unknown as BellNotification[]),
    enabled: open
  })

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

  const TABS: Array<{ key: BellLaneTab; label: string; count: number | null }> = [
    { key: 'attention', label: 'Needs you', count: attention },
    { key: 'fyi', label: 'FYI', count: lanes.fyi },
    { key: 'all', label: 'All', count: null }
  ]
  const toggle = () => setOpen((o) => !o)

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
          aria-label={badge ? `Notifications (${badge} need you)` : 'Notifications'}
        >
          <Bell className='h-4 w-4' strokeWidth={1.8} />
          {badge > 0 && (
            <span
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
              {groups.length === 0 ? (
                <p className='px-3 py-6 text-center text-[12px] text-slate-400'>
                  {tab === 'attention'
                    ? 'Nothing needs you right now.'
                    : tab === 'fyi'
                      ? 'No FYI notifications.'
                      : 'No notifications'}
                </p>
              ) : (
                groups.map((g) => {
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
                      {g.rows.map((n) => (
                        <Fragment key={n.id}>
                          <button
                            type='button'
                            onClick={() => {
                              if (!n.read) markRead.mutate(n.id)
                              openTarget(n)
                            }}
                            className={`flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors ${
                              hasRecord ? 'hover:bg-slate-50 dark:hover:bg-muted' : 'cursor-default'
                            }`}
                          >
                            <span
                              className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                                n.read
                                  ? 'bg-transparent'
                                  : n.lane === 'critical'
                                    ? 'bg-red-500'
                                    : 'bg-nvr-cyan'
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
                                  onNavigate={(p) => {
                                    setOpen(false)
                                    onNavigate(p)
                                  }}
                                />
                              </span>
                            </span>
                            {!hasRecord && !n.read && (
                              <span
                                role='button'
                                tabIndex={-1}
                                title='Mark read'
                                onClick={(e) => {
                                  e.stopPropagation()
                                  markRead.mutate(n.id)
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
                              className='px-3 pb-2 pl-[30px]'
                            />
                          )}
                          <NotificationDetailBits
                            detail={n.detail}
                            why={n.why}
                            delivery={n.delivery}
                            subscriptionsPath={subscriptionsPath}
                            onNavigate={(p) => {
                              setOpen(false)
                              onNavigate(p)
                            }}
                            className='px-3 pb-2 pl-[30px] -mt-1'
                          />
                        </Fragment>
                      ))}
                    </div>
                  )
                })
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
    </div>
  )
}
