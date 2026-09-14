import {
  type Command,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  markNotificationsRead,
  readUnreadNotificationCount
} from '@nivaro/sdk'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Check, CheckCheck, ExternalLink } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useNivaroClient } from '../context'
import {
  type NotificationActionSpec,
  type NotificationRouteMap,
  type NotificationTargetSpec,
  resolveNotificationTargetFor,
  runNotificationTarget
} from '../lib/notification-target'
import { formatRelative } from '../lib/utils'

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
}

/**
 * The Nivaro notification bell — the same setup the admin uses: unread badge,
 * unread/all tabs, rows grouped by record (five updates on one workflow read
 * as one story), group-level open + mark-read, inline server-approved
 * actions, and click-through routing via the shared notification-target
 * resolver. Needs `<NivaroProvider>`.
 */
export function NotificationBell({
  routes,
  onNavigate,
  app,
  subscribe,
  buttonClassName,
  panelClassName
}: NotificationBellProps) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'unread' | 'all'>('unread')
  const rootRef = useRef<HTMLDivElement>(null)
  const qc = useQueryClient()

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['notification-count'] })
    void qc.invalidateQueries({ queryKey: ['notifications'] })
  }

  const { data: unread = 0 } = useQuery({
    queryKey: ['notification-count'],
    queryFn: () => client.request(readUnreadNotificationCount()).then((r) => r.unread ?? 0),
    refetchInterval: 60_000
  })
  const { data: notifications = [] } = useQuery({
    queryKey: ['notifications', app ?? null],
    queryFn: () =>
      client
        .request(listNotifications({ limit: 60, app }))
        .then((r) => (r.data ?? []) as unknown as BellNotification[]),
    enabled: open
  })

  useEffect(() => subscribe?.(invalidate), [subscribe]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

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
  const runAction = useMutation({
    mutationFn: async ({ action, id }: { action: NotificationActionSpec; id: number }) => {
      const command: Command<unknown> = {
        _method: action.method,
        _path: action.endpoint,
        _body: action.body ?? {}
      }
      await client.request(command)
      if (action.mark_read) await client.request(markNotificationRead(id)).catch(() => {})
    },
    onSuccess: invalidate
  })

  // Group by record — five updates on one workflow read as one story, not
  // five rows. Record-less notifications stay individual.
  const shown = useMemo(
    () => (tab === 'unread' ? notifications.filter((n) => !n.read) : notifications).slice(0, 40),
    [notifications, tab]
  )
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

  return (
    <div ref={rootRef} className='relative'>
      <button
        type='button'
        onClick={() => setOpen((o) => !o)}
        className={
          buttonClassName ??
          'relative rounded-md p-1.5 text-slate-500 transition-colors hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-muted'
        }
        aria-label={unread ? `Notifications (${unread} unread)` : 'Notifications'}
      >
        <Bell className='h-4 w-4' strokeWidth={1.8} />
        {unread > 0 && (
          <span className='absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-nvr-cyan px-1 text-[9.5px] font-bold text-nvr-navy'>
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          className={`absolute right-0 top-10 z-40 w-[340px] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-border dark:bg-card ${panelClassName ?? ''}`}
        >
          <div className='flex items-center justify-between border-b border-slate-100 px-3 py-2 dark:border-border/60'>
            <div className='flex items-center gap-1 rounded-md bg-slate-100 p-0.5 dark:bg-muted'>
              {(['unread', 'all'] as const).map((t) => (
                <button
                  key={t}
                  type='button'
                  onClick={() => setTab(t)}
                  className={
                    tab === t
                      ? 'rounded bg-white px-2 py-0.5 text-[11px] font-medium capitalize text-slate-900 shadow-sm dark:bg-card dark:text-slate-100'
                      : 'rounded px-2 py-0.5 text-[11px] font-medium capitalize text-slate-500 hover:text-slate-700 dark:text-slate-400'
                  }
                >
                  {t}
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
                {tab === 'unread' ? "You're all caught up." : 'No notifications'}
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
                              n.read ? 'bg-transparent' : 'bg-nvr-cyan'
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
                              {n.title}
                            </span>
                            {n.message && (
                              <span className='mt-0.5 line-clamp-2 text-[11px] leading-snug text-slate-500'>
                                {n.message.replace(/<[^>]+>/g, '')}
                              </span>
                            )}
                            <span className='mt-0.5 block text-[10.5px] text-slate-400'>
                              {formatRelative(n.created_at)}
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
                          <div className='flex gap-1 px-3 pb-2 pl-[30px]'>
                            {n.actions.map((a) => (
                              <button
                                key={a.key}
                                type='button'
                                onClick={() => runAction.mutate({ action: a, id: n.id })}
                                className='rounded-full border border-nvr-cyan/40 bg-nvr-cyan/10 px-2 py-0.5 text-[10.5px] font-semibold text-nvr-navy hover:bg-nvr-cyan/20 dark:bg-nvr-cyan/15 dark:text-nvr-cyan'
                              >
                                {a.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </Fragment>
                    ))}
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
