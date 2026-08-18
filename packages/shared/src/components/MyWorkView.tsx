import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useApiFetchConfig, useItemNavigation } from '../context'
import { UserAvatar } from './UserAvatar'
import { resolveNotificationTarget, runNotificationTarget, type NotificationRouteMap } from '../lib/notification-target'

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
  remaining_hours?: number | null
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

function SlaChip({ sla }: { sla: SlaInfo | null }) {
  if (!sla?.status || sla.status === 'ok') return null
  const breached = sla.status === 'breached'
  return (
    <span
      className={
        breached
          ? 'rounded px-1.5 py-0.5 text-[10px] font-semibold bg-red-500/10 text-red-600 dark:text-red-400'
          : 'rounded px-1.5 py-0.5 text-[10px] font-semibold bg-amber-400/15 text-amber-700 dark:text-amber-400'
      }
    >
      {breached ? 'SLA breached' : 'SLA warning'}
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
      <p className={`mt-0.5 text-[18px] font-semibold tabular-nums ${tone ?? ''}`}>{value}</p>
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
  const qc = useQueryClient()

  const { data, isLoading, refetch, isFetching } = useQuery<MyWorkData>({
    queryKey: ['my-work'],
    queryFn: async () => {
      const res = await fetch(`${apiBase}/my-work`, { headers: authHeaders, credentials })
      if (!res.ok) throw new Error('my-work failed')
      return ((await res.json()) as { data: MyWorkData }).data
    },
    staleTime: 60_000
  })

  const completeTask = useMutation({
    mutationFn: (id: number) =>
      fetch(`${apiBase}/tasks/${id}`, {
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
    if (collection && item && !/^nivaro_/i.test(collection) && collection !== '__chat__') return true
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
        <button
          type='button'
          onClick={() => refetch()}
          disabled={isFetching}
          className='ml-3 rounded-md border border-slate-200 px-2.5 py-1.5 text-[12px] hover:bg-muted disabled:opacity-50 dark:border-border'
        >
          {isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* Records waiting on me */}
      <section className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
        <div className='border-b border-slate-200 px-4 py-2.5 dark:border-border'>
          <h2 className='text-[13px] font-medium'>Waiting on you</h2>
          <p className='text-[11px] text-muted-foreground'>
            Records whose current step resolves you as an owner — most urgent first.
          </p>
        </div>
        {data.owned.length === 0 ? (
          <p className='px-4 py-6 text-center text-[12.5px] text-muted-foreground'>
            Nothing is waiting on you. Enjoy it.
          </p>
        ) : (
          <ul className='divide-y divide-slate-100 dark:divide-border/60'>
            {data.owned.map((o) => (
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
                  <SlaChip sla={o.sla} />
                  <StateChip state={o.state} color={o.state_color} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className='grid gap-5 lg:grid-cols-2'>
        {/* Tasks */}
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
                    onClick={() => completeTask.mutate(t.id)}
                    disabled={completeTask.isPending}
                    className='flex h-4 w-4 shrink-0 items-center justify-center rounded border border-slate-300 text-transparent hover:border-emerald-500 hover:text-emerald-500 dark:border-border'
                  >
                    ✓
                  </button>
                  <button
                    type='button'
                    onClick={() => open(t.collection, t.item)}
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

        {/* Notifications */}
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
                      <p className='truncate text-[11.5px] text-muted-foreground'>{n.message}</p>
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
      </div>
    </div>
  )
}
