import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useApiFetchConfig, useItemNavigation, useNavigation } from '../context'
import {
  type NotificationRouteMap,
  resolveNotificationTarget,
  runNotificationTarget
} from '../lib/notification-target'
import { useOptionalRealtime } from '../lib/realtime'
import { slaChip, withinDay } from '../lib/sla-chip'
import { canOpenChatRoom, openChatRoom } from './chat/chat-core'
import { useMyRecordRooms } from './chat/chat-hooks'
import { TickerNumber } from './TickerNumber'
import { UserAvatar } from './UserAvatar'

/**
 * My Work — the personal actionable inbox: records whose current pipeline
 * state resolves the viewer as an owner (SLA-urgency first), their open
 * tasks, and unread notifications. Backed by GET /api/my-work, which reuses
 * the queue owned_by_me resolver + SLA batch so this page always agrees with
 * the queues showing the same records.
 *
 * Host contract: NivaroProvider + NavigationContext (row opens).
 */

interface SlaInfo {
  status: 'ok' | 'warning' | 'breached' | null
  remaining_hours: number | null
}

interface OwnedRow {
  collection: string
  item: string
  label: string
  state: string | null
  state_color: string | null
  url: string
  sla: SlaInfo | null
}

interface TaskRow {
  id: number
  /** 'support' = a support ticket (#999); null = an ordinary task. */
  kind?: string | null
  collection: string | null
  item: string | null
  title: string
  due_date: string | null
  status: string
}

interface NotificationRow {
  id: number
  subject: string
  message: string | null
  sender: string | null
  collection: string | null
  item: string | null
  timestamp: string
}

interface MyWorkData {
  owned: OwnedRow[]
  owned_total: number
  tasks: TaskRow[]
  approvals: Array<Record<string, unknown>>
  notifications: NotificationRow[]
  counts: {
    owned: number
    owned_breached: number
    owned_warning: number
    tasks: number
    approvals: number
    notifications: number
  }
}

const SLA_TONE_CLASS: Record<'ok' | 'warn' | 'alert' | 'neutral', string> = {
  alert: 'bg-red-500/10 text-red-600 dark:text-red-400',
  warn: 'bg-amber-400/15 text-amber-700 dark:text-amber-400',
  neutral: 'bg-slate-500/10 text-slate-600 dark:text-slate-400',
  ok: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
}

// Time-to-breach chip — "breaches in 6h" / "breached 2d ago" — amber for a
// soon-due warning, red once breached, slate otherwise. #853.
function SlaChip({ sla }: { sla: SlaInfo | null }) {
  const chip = slaChip(sla)
  if (!chip) return null
  return (
    <span
      data-sla-chip={chip.tone}
      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${SLA_TONE_CLASS[chip.tone]}`}
    >
      {chip.label}
    </span>
  )
}

function StateChip({ state, color }: { state: string | null; color: string | null }) {
  if (!state) return null
  return (
    <span
      className='rounded-full px-2 py-0.5 text-[10.5px] font-medium'
      style={{
        backgroundColor: color ? `${color}22` : 'rgba(100,116,139,.12)',
        color: color ?? undefined
      }}
    >
      {state.replace(/_/g, ' ')}
    </span>
  )
}

function Tile({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className='rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'>
      <p className='text-[10.5px] uppercase tracking-wide text-muted-foreground'>{label}</p>
      <p className={`mt-0.5 text-[18px] font-semibold tabular-nums ${tone ?? ''}`}>
        <TickerNumber value={value} />
      </p>
    </div>
  )
}

export function MyWorkView({
  notificationRoutes,
  onOpenPath
}: {
  /** Host page map so notification clicks land on real pages (reports, queues,
   *  alerts…); without it only record targets are clickable. */
  notificationRoutes?: NotificationRouteMap
  onOpenPath?: (path: string) => void
} = {}) {
  const { apiBase, authHeaders, credentials } = useApiFetchConfig()
  const { open: openItem } = useItemNavigation()
  const nav = useNavigation()
  const qc = useQueryClient()
  // A support ticket opens its own page (/support?ticket=), in whichever app.
  const openTicket = (id: number) => {
    const path =
      notificationRoutes?.support?.(String(id)) ??
      nav.consoleUrl?.(`/support?ticket=${id}`) ??
      `/support?ticket=${id}`
    if (onOpenPath) onOpenPath(path)
    else nav.navigate(path)
  }

  // Live "updates available" pill (#278). My Work re-aggregation is expensive
  // (~seconds of live owner resolution) so events never auto-refresh — a
  // 30s-debounced pill offers the refresh instead. Collections come from the
  // owned records already on screen.
  const realtime = useOptionalRealtime()
  const [updatesPending, setUpdatesPending] = useState(false)
  // #368 — per-browser section order/visibility (deliberately unlogged UI pref)
  const [sectionPrefs, setSectionPrefs] = useState<{ order: string[]; hidden: string[] }>(() => {
    try {
      const raw = localStorage.getItem('nvr_mywork_sections')
      if (raw) {
        const p = JSON.parse(raw)
        if (Array.isArray(p?.order) && Array.isArray(p?.hidden)) {
          const order = ['records', 'tasks', 'notifications'].sort(
            (a, b) => p.order.indexOf(a) - p.order.indexOf(b)
          )
          return { order, hidden: p.hidden.filter((h: string) => order.includes(h)) }
        }
      }
    } catch {
      /* fresh defaults */
    }
    return { order: ['records', 'tasks', 'notifications'], hidden: [] }
  })
  const updateSectionPrefs = (next: { order: string[]; hidden: string[] }) => {
    setSectionPrefs(next)
    try {
      localStorage.setItem('nvr_mywork_sections', JSON.stringify(next))
    } catch {
      /* storage full/blocked — session-only */
    }
  }
  const [customizeOpen, setCustomizeOpen] = useState(false)
  const debounceRef = useRef(0)
  // #853 — which owned rows show, by their SLA reading; client-side only.
  const [slaFilter, setSlaFilter] = useState<'all' | 'soon' | 'breached'>('all')

  const { data, isLoading, refetch, isFetching } = useQuery<MyWorkData>({
    queryKey: ['my-work'],
    queryFn: async () => {
      const res = await fetch(`${apiBase}/my-work`, { headers: authHeaders, credentials })
      if (!res.ok) throw new Error('my-work failed')
      return ((await res.json()) as { data: MyWorkData }).data
    },
    staleTime: 60_000
  })

  const liveCollections = useMemo(() => {
    const set = new Set<string>()
    for (const r of data?.owned ?? []) if (r.collection) set.add(r.collection)
    return [...set]
  }, [data])
  useEffect(() => {
    if (!realtime || liveCollections.length === 0) return
    return realtime.subscribeCollections(liveCollections, () => {
      const now = Date.now()
      if (now - debounceRef.current < 30_000) return
      debounceRef.current = now
      setUpdatesPending(true)
    })
  }, [realtime, liveCollections])

  const completeTask = useMutation({
    // A ticket closes through /support so its requester hears about it.
    mutationFn: (t: { id: number; kind?: string | null }) =>
      fetch(`${apiBase}/${t.kind === 'support' ? 'support/tickets' : 'tasks'}/${t.id}`, {
        method: 'PATCH',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        credentials,
        body: JSON.stringify({ status: 'done' })
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-work'] })
  })

  const markRead = useMutation({
    mutationFn: (ids: number[]) =>
      fetch(`${apiBase}/notifications/mark-read`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        credentials,
        body: JSON.stringify({ ids })
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-work'] })
      qc.invalidateQueries({ queryKey: ['notifications'] })
    }
  })

  const open = (collection: string | null, item: string | null) => {
    const routes: NotificationRouteMap = {
      record: (c, i) => {
        // Record targets always work — openItem is the host's record router.
        openItem({ collection: c, itemId: i })
        return null
      },
      ...notificationRoutes
    }
    const target = resolveNotificationTarget(collection, item, {
      ...routes,
      record: (c, i) => notificationRoutes?.record?.(c, i) ?? null
    })
    if (target) {
      runNotificationTarget(target, (path) => onOpenPath?.(path))
      return
    }
    // No resolvable page-level target — fall back to the record route.
    if (collection && item && !/^nivaro_/i.test(collection) && collection !== '__chat__') {
      openItem({ collection, itemId: item })
    }
  }
  const notificationTargetFor = (collection: string | null, item: string | null) => {
    if (collection && item && !/^nivaro_/i.test(collection) && collection !== '__chat__')
      return true
    return !!resolveNotificationTarget(collection, item, {
      record: () => null,
      ...notificationRoutes
    })
  }

  if (isLoading || !data) {
    return (
      <div className='grid grid-cols-4 gap-3 p-6'>
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className='h-16 animate-pulse rounded-lg bg-[hsl(var(--nvr-skeleton))]' />
        ))}
      </div>
    )
  }

  return (
    <div className='space-y-5 p-6' data-my-work>
      <div className='flex items-start justify-between'>
        <div className='grid flex-1 grid-cols-2 gap-3 lg:grid-cols-4'>
          <Tile label='Waiting on you' value={data.counts.owned} />
          <Tile
            label='SLA breached'
            value={data.counts.owned_breached}
            tone={data.counts.owned_breached > 0 ? 'text-red-600 dark:text-red-400' : ''}
          />
          <Tile label='Open tasks' value={data.counts.tasks} />
          <Tile label='Unread notifications' value={data.counts.notifications} />
        </div>
        {updatesPending && (
          <button
            type='button'
            onClick={() => {
              setUpdatesPending(false)
              void refetch()
            }}
            className='ml-3 inline-flex items-center gap-1.5 rounded-full border border-[#00ceff]/40 bg-[#00ceff]/10 px-3 py-1.5 text-[12px] font-medium text-[#0e7490] hover:bg-[#00ceff]/20 dark:text-[#67e8f9]'
          >
            <span className='h-1.5 w-1.5 animate-pulse rounded-full bg-[#00ceff]' />
            Updates available — refresh
          </button>
        )}
        <button
          type='button'
          onClick={() => {
            setUpdatesPending(false)
            void refetch()
          }}
          disabled={isFetching}
          className='ml-3 rounded-md border border-slate-200 px-2.5 py-1.5 text-[12px] hover:bg-muted disabled:opacity-50 dark:border-border'
        >
          {isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
        <div className='relative ml-2'>
          <button
            type='button'
            onClick={() => setCustomizeOpen((o) => !o)}
            className='rounded-md border border-slate-200 px-2.5 py-1.5 text-[12px] hover:bg-muted dark:border-border'
          >
            Customize
          </button>
          {customizeOpen && (
            <div className='absolute right-0 top-full z-20 mt-1 w-56 rounded-lg border border-slate-200 bg-white p-2 shadow-lg dark:border-border dark:bg-card'>
              <p className='px-1 pb-1.5 text-[11px] font-semibold text-slate-500'>Sections</p>
              {sectionPrefs.order.map((k, idx) => {
                const label =
                  k === 'records' ? 'Waiting on you' : k === 'tasks' ? 'My tasks' : 'Notifications'
                const hidden = sectionPrefs.hidden.includes(k)
                const move = (dir: -1 | 1) => {
                  const order = [...sectionPrefs.order]
                  const j = idx + dir
                  if (j < 0 || j >= order.length) return
                  ;[order[idx], order[j]] = [order[j], order[idx]]
                  updateSectionPrefs({ ...sectionPrefs, order })
                }
                return (
                  <div key={k} className='flex items-center gap-1 rounded px-1 py-1 hover:bg-muted'>
                    <button
                      type='button'
                      onClick={() =>
                        updateSectionPrefs({
                          ...sectionPrefs,
                          hidden: hidden
                            ? sectionPrefs.hidden.filter((h) => h !== k)
                            : [...sectionPrefs.hidden, k]
                        })
                      }
                      className='flex h-4 w-4 items-center justify-center rounded border border-slate-300 text-[10px] dark:border-border'
                      title={hidden ? 'Show section' : 'Hide section'}
                    >
                      {hidden ? '' : '✓'}
                    </button>
                    <span
                      className={`min-w-0 flex-1 truncate text-[12px] ${hidden ? 'text-slate-400 line-through' : ''}`}
                    >
                      {label}
                    </span>
                    <button
                      type='button'
                      onClick={() => move(-1)}
                      disabled={idx === 0}
                      className='px-1 text-[11px] text-slate-400 hover:text-foreground disabled:opacity-30'
                    >
                      ↑
                    </button>
                    <button
                      type='button'
                      onClick={() => move(1)}
                      disabled={idx === sectionPrefs.order.length - 1}
                      className='px-1 text-[11px] text-slate-400 hover:text-foreground disabled:opacity-30'
                    >
                      ↓
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* My Work customization (#368): the three sections render in the
          user's saved order; hidden ones are skipped; consecutive card
          sections pair up into the two-column grid. Per-browser UI pref. */}
      {(() => {
        const renderers: Record<string, () => React.ReactNode> = {
          records: () => {
            const soonCount = data.owned.filter((o) => withinDay(o.sla)).length
            const breachedCount = data.owned.filter((o) => o.sla?.status === 'breached').length
            const filteredOwned =
              slaFilter === 'soon'
                ? data.owned.filter((o) => withinDay(o.sla))
                : slaFilter === 'breached'
                  ? data.owned.filter((o) => o.sla?.status === 'breached')
                  : data.owned
            const slaFilters = [
              { key: 'all' as const, label: `All (${data.owned.length})` },
              { key: 'soon' as const, label: `Warning within 24h (${soonCount})` },
              { key: 'breached' as const, label: `Breached (${breachedCount})` }
            ]
            return (
              <section className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
                <div className='border-b border-slate-200 px-4 py-2.5 dark:border-border'>
                  <h2 className='text-[13px] font-medium'>Waiting on you</h2>
                  <p className='text-[11px] text-muted-foreground'>
                    Records whose current step resolves you as an owner — most urgent first.
                  </p>
                </div>
                {data.owned.length > 0 && (
                  <div className='flex flex-wrap items-center gap-1 border-b border-slate-100 px-4 py-2 dark:border-border/60'>
                    <div className='flex items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-muted'>
                      {slaFilters.map((f) => (
                        <button
                          key={f.key}
                          type='button'
                          data-my-work-sla-filter={f.key}
                          aria-pressed={slaFilter === f.key}
                          onClick={() => setSlaFilter(f.key)}
                          className={[
                            'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors duration-150',
                            slaFilter === f.key
                              ? 'bg-white text-slate-900 shadow-sm dark:bg-card dark:text-foreground'
                              : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
                          ].join(' ')}
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {filteredOwned.length === 0 ? (
                  <p className='px-4 py-6 text-center text-[12.5px] text-muted-foreground'>
                    {data.owned.length === 0
                      ? 'Nothing is waiting on you. Enjoy it.'
                      : 'Nothing matches this filter.'}
                  </p>
                ) : (
                  <ul className='divide-y divide-slate-100 dark:divide-border/60'>
                    {filteredOwned.map((o) => (
                      <li key={`${o.collection}:${o.item}`}>
                        <button
                          type='button'
                          onClick={() => open(o.collection, o.item)}
                          className='flex w-full items-center gap-2.5 px-4 py-2 text-left hover:bg-muted'
                        >
                          <span className='min-w-0 flex-1 truncate text-[12.5px] font-medium'>
                            {o.label}
                          </span>
                          <span className='hidden text-[11px] text-muted-foreground sm:inline'>
                            {o.collection.replace(/_/g, ' ')}
                          </span>
                          <StateChip state={o.state} color={o.state_color} />
                          <SlaChip sla={o.sla} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )
          },
          tasks: () => (
            <section className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
              <div className='border-b border-slate-200 px-4 py-2.5 dark:border-border'>
                <h2 className='text-[13px] font-medium'>My tasks</h2>
              </div>
              {data.tasks.length === 0 ? (
                <p className='px-4 py-5 text-center text-[12.5px] text-muted-foreground'>
                  No open tasks.
                </p>
              ) : (
                <ul className='divide-y divide-slate-100 dark:divide-border/60'>
                  {data.tasks.map((t) => (
                    <li key={t.id} className='flex items-center gap-2.5 px-4 py-2'>
                      <button
                        type='button'
                        title='Mark done'
                        onClick={() => completeTask.mutate(t)}
                        disabled={completeTask.isPending}
                        className='flex h-4 w-4 shrink-0 items-center justify-center rounded border border-slate-300 text-transparent hover:border-emerald-500 hover:text-emerald-500 dark:border-border'
                      >
                        ✓
                      </button>
                      {(t as { priority?: string }).priority === 'urgent' && (
                        <span className='shrink-0 rounded bg-red-500/10 px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400'>
                          urgent
                        </span>
                      )}
                      {t.kind === 'support' && (
                        <span className='shrink-0 rounded bg-slate-100 px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-slate-600 dark:bg-white/10 dark:text-slate-300'>
                          support
                        </span>
                      )}
                      <button
                        type='button'
                        onClick={() =>
                          t.kind === 'support' ? openTicket(t.id) : open(t.collection, t.item)
                        }
                        className='min-w-0 flex-1 truncate text-left text-[12.5px] hover:underline'
                      >
                        {t.title}
                      </button>
                      {t.due_date && (
                        <span
                          className={`text-[11px] tabular-nums ${
                            new Date(t.due_date) < new Date()
                              ? 'font-medium text-red-600 dark:text-red-400'
                              : 'text-muted-foreground'
                          }`}
                        >
                          {new Date(t.due_date).toLocaleDateString()}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ),
          notifications: () => (
            <section className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
              <div className='flex items-center justify-between border-b border-slate-200 px-4 py-2.5 dark:border-border'>
                <h2 className='text-[13px] font-medium'>Unread notifications</h2>
                {data.notifications.length > 0 && (
                  <button
                    type='button'
                    onClick={() => markRead.mutate(data.notifications.map((n) => n.id))}
                    className='text-[11px] text-[#00a5cc] hover:underline'
                  >
                    Mark all read
                  </button>
                )}
              </div>
              {data.notifications.length === 0 ? (
                <p className='px-4 py-5 text-center text-[12.5px] text-muted-foreground'>
                  You're all caught up.
                </p>
              ) : (
                <ul className='divide-y divide-slate-100 dark:divide-border/60'>
                  {data.notifications.map((n) => (
                    <li key={n.id} className='flex items-start gap-2.5 px-4 py-2'>
                      <UserAvatar
                        userId={n.sender}
                        className='mt-0.5 h-5 w-5'
                        fallback={
                          <span className='mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[9px] font-semibold text-slate-500 dark:bg-muted' />
                        }
                      />
                      <button
                        type='button'
                        onClick={() => open(n.collection, n.item)}
                        className={
                          notificationTargetFor(n.collection, n.item)
                            ? 'min-w-0 flex-1 cursor-pointer text-left hover:opacity-80'
                            : 'min-w-0 flex-1 cursor-default text-left'
                        }
                      >
                        <p className='truncate text-[12.5px] font-medium'>{n.subject}</p>
                        {n.message && (
                          <p className='truncate text-[11.5px] text-muted-foreground'>
                            {n.message}
                          </p>
                        )}
                      </button>
                      <button
                        type='button'
                        title='Mark read'
                        onClick={() => markRead.mutate([n.id])}
                        className='text-[11px] text-muted-foreground hover:text-foreground'
                      >
                        ✓
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )
        }
        const visible = sectionPrefs.order.filter((k) => !sectionPrefs.hidden.includes(k))
        const out: React.ReactNode[] = []
        let i = 0
        while (i < visible.length) {
          const k = visible[i]
          if (k === 'records') {
            out.push(<div key={k}>{renderers[k]()}</div>)
            i++
          } else {
            const pair = [k]
            if (i + 1 < visible.length && visible[i + 1] !== 'records') pair.push(visible[i + 1])
            out.push(
              <div key={pair.join('+')} className='grid gap-5 lg:grid-cols-2'>
                {pair.map((pk) => (
                  <div key={pk}>{renderers[pk]()}</div>
                ))}
              </div>
            )
            i += pair.length
          }
        }
        return out
      })()}
      <RecordConversations />
    </div>
  )
}

/**
 * Record rooms with unread messages (#969) — the conversations about work you
 * own or follow. Renders nothing without a chat dock or with nothing unread,
 * so My Work stays quiet for people who do not use chat.
 */
function RecordConversations() {
  const enabled = canOpenChatRoom()
  const { rooms } = useMyRecordRooms(enabled)
  if (!enabled || rooms.length === 0) return null
  return (
    <section
      className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
      data-my-work-chat
    >
      <div className='border-b border-slate-200 px-4 py-2.5 dark:border-border'>
        <h2 className='text-[13px] font-medium'>Record conversations</h2>
      </div>
      <ul className='divide-y divide-slate-100 dark:divide-border/60'>
        {rooms.map((r) => (
          <li key={r.room}>
            <button
              type='button'
              onClick={() => openChatRoom(r.room, r.label)}
              className='flex w-full items-center gap-2.5 px-4 py-2 text-left hover:bg-slate-50 dark:hover:bg-muted/40'
              data-my-work-chat-room={r.room}
            >
              <span className='min-w-0 flex-1'>
                <span className='block truncate text-[12.5px] font-medium'>{r.label}</span>
                {r.last_message && (
                  <span className='block truncate text-[11.5px] text-muted-foreground'>
                    {r.last_message.sender_name ? `${r.last_message.sender_name}: ` : ''}
                    {r.last_message.message.replace(/@\[([^\]]+)\]/g, '@$1')}
                  </span>
                )}
              </span>
              {r.mentions > 0 && (
                <span className='flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white'>
                  @
                </span>
              )}
              <span className='flex h-5 min-w-5 items-center justify-center rounded-full bg-slate-100 px-1.5 text-[10px] font-bold tabular-nums text-slate-600 dark:bg-muted dark:text-slate-300'>
                {r.unread > 99 ? '99+' : r.unread}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
