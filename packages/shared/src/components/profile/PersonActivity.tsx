import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Activity, ArrowDownAZ, ArrowUpAZ, Flame, Footprints, Globe, LogIn, X } from 'lucide-react'
import { useState } from 'react'
import { useItemNavigation, useNavigation, useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn, formatDateTime, formatRelative } from '../../lib/utils'
import { SimpleSelect } from '../ui/SimpleSelect'
import { EmptyLine, SectionCard } from './primitives'
import type { PersonProfile } from './types'

// ─── Rhythm (eight weeks) ────────────────────────────────────────────────────

export function StatsCard({ userId, title = 'Rhythm' }: { userId: string; title?: string }) {
  const client = useNivaroClient()
  const { data } = useQuery<{
    weeks: Array<{ transitions: number; tasks_done: number; created: number }>
    streak_days: number
    active_days?: string[]
    typical_hours_utc?: { start: number; end: number; samples: number } | null
    totals: { transitions: number; tasks_done: number; created: number }
  } | null>({
    queryKey: ['nvr-user-stats', userId],
    queryFn: () =>
      client
        .request<{ data: never }>(get(`/users/${userId}/stats`))
        .then((r) => r.data)
        .catch(() => null as never),
    staleTime: 5 * 60_000
  })
  if (!data) return null
  const weekMax = Math.max(1, ...data.weeks.map((w) => w.transitions + w.tasks_done + w.created))
  const quiet = data.totals.transitions + data.totals.tasks_done + data.totals.created === 0
  return (
    <SectionCard
      icon={<Flame className='h-4 w-4' />}
      title={title}
      hint='Last eight weeks'
      testId='stats'
      actions={
        data.streak_days > 0 && (
          <span className='text-[11.5px] font-medium text-amber-600 dark:text-amber-400'>
            {data.streak_days}-day streak
          </span>
        )
      }
    >
      {quiet ? (
        <EmptyLine>Nothing recorded in the last eight weeks.</EmptyLine>
      ) : (
        <>
          <WeekBars weeks={data.weeks} max={weekMax} />
          {data.active_days && <DaysActiveCalendar days={data.active_days} />}
          {data.typical_hours_utc && <TypicalHours hours={data.typical_hours_utc} />}
          <dl className='mt-4 grid grid-cols-3 gap-2 text-center'>
            {[
              ['Approvals', data.totals.transitions],
              ['Tasks done', data.totals.tasks_done],
              ['Records created', data.totals.created]
            ].map(([label, n]) => (
              <div key={String(label)} className='rounded-md bg-slate-50 py-2 dark:bg-muted/40'>
                <dd className='text-[16px] font-semibold tabular-nums text-slate-800 dark:text-slate-100'>
                  {Number(n).toLocaleString()}
                </dd>
                <dt className='text-[10.5px] font-medium uppercase tracking-wide text-slate-400'>
                  {label}
                </dt>
              </div>
            ))}
          </dl>
        </>
      )}
    </SectionCard>
  )
}

const DAY = 864e5
/** Monday 00:00 UTC of the week holding `d`. */
function weekStart(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dow = (x.getUTCDay() + 6) % 7 // Mon = 0
  x.setUTCDate(x.getUTCDate() - dow)
  return x
}
const shortDate = (d: Date) =>
  d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })

/** Actions per week, oldest → newest, each bar labelled by its Monday and its count. */
function WeekBars({
  weeks,
  max
}: {
  weeks: Array<{ transitions: number; tasks_done: number; created: number }>
  max: number
}) {
  const thisMonday = weekStart(new Date())
  return (
    <div data-person-week-bars>
      <p className='text-[10.5px] font-medium uppercase tracking-wide text-slate-400'>
        Actions per week
      </p>
      <div className='mt-1.5 flex items-end gap-1.5' data-person-stats-bars>
        {weeks.map((w, i) => {
          const total = w.transitions + w.tasks_done + w.created
          const h = total === 0 ? 2 : Math.max(6, Math.round((total / max) * 56))
          const monday = new Date(thisMonday.getTime() - (weeks.length - 1 - i) * 7 * DAY)
          const current = i === weeks.length - 1
          return (
            <div
              key={monday.toISOString()}
              className='flex flex-1 flex-col items-center justify-end'
              title={`Week of ${shortDate(monday)} · ${total} actions · ${w.transitions} approvals · ${w.tasks_done} tasks · ${w.created} created`}
            >
              <span
                className={cn(
                  'mb-0.5 text-[10.5px] tabular-nums',
                  total === 0 ? 'text-transparent' : 'text-slate-500 dark:text-slate-400'
                )}
                aria-hidden={total === 0}
              >
                {total}
              </span>
              <div
                className={cn(
                  'w-full rounded-sm',
                  current
                    ? 'bg-nvr-cyan'
                    : total === 0
                      ? 'bg-slate-200 dark:bg-slate-700'
                      : 'bg-slate-300 dark:bg-slate-600'
                )}
                style={{ height: h }}
              />
              <span
                className={cn(
                  'mt-1 text-[10px] tabular-nums',
                  current ? 'font-semibold text-slate-700 dark:text-slate-200' : 'text-slate-400'
                )}
              >
                {current ? 'This wk' : shortDate(monday)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const WEEKDAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', 'Sun']

/** Eight weeks as a calendar — one column per week, one row per weekday. */
function DaysActiveCalendar({ days }: { days: string[] }) {
  const set = new Set(days)
  const thisMonday = weekStart(new Date())
  const todayKey = new Date().toISOString().slice(0, 10)
  const weeks = Array.from({ length: 8 }, (_, i) => {
    const monday = new Date(thisMonday.getTime() - (7 - i) * 7 * DAY)
    return {
      monday,
      cells: Array.from({ length: 7 }, (_, d) => {
        const date = new Date(monday.getTime() + d * DAY)
        const key = date.toISOString().slice(0, 10)
        return { key, on: set.has(key), future: key > todayKey, today: key === todayKey, date }
      })
    }
  })
  const active = weeks
    .flat()
    .flatMap((w) => w.cells)
    .filter((c) => c.on).length
  const shown = weeks.flatMap((w) => w.cells).filter((c) => !c.future).length
  return (
    <div className='mt-4' data-person-presence-strip={active}>
      <div className='flex items-baseline justify-between'>
        <p className='text-[10.5px] font-medium uppercase tracking-wide text-slate-400'>
          Days with activity
        </p>
        <p className='text-[11.5px] tabular-nums text-slate-600 dark:text-slate-300'>
          <span className='font-semibold'>{active}</span> of the last {shown} days
        </p>
      </div>
      <div className='mt-1.5 flex gap-1.5'>
        <div className='flex flex-col gap-[3px] pr-1' aria-hidden>
          {WEEKDAY_LABELS.map((l, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed weekday rows
              key={i}
              className='h-3 text-[9.5px] leading-3 text-slate-400'
            >
              {l}
            </span>
          ))}
        </div>
        {weeks.map((w) => (
          <div key={w.monday.toISOString()} className='flex flex-1 flex-col gap-[3px]'>
            {w.cells.map((c) => (
              <span
                key={c.key}
                title={
                  c.future
                    ? undefined
                    : `${c.date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })}${c.on ? ' · active' : ' · no activity'}`
                }
                className={cn(
                  'h-3 rounded-[2px]',
                  c.future
                    ? 'bg-transparent'
                    : c.on
                      ? 'bg-nvr-cyan'
                      : 'bg-slate-200 dark:bg-slate-700',
                  c.today && 'ring-1 ring-slate-400 dark:ring-slate-300'
                )}
              />
            ))}
          </div>
        ))}
      </div>
      <div className='mt-1.5 flex items-center justify-between text-[10px] text-slate-400'>
        <span className='flex items-center gap-1'>
          <span className='inline-block h-2.5 w-2.5 rounded-[2px] bg-nvr-cyan' /> did something
          <span className='ml-2 inline-block h-2.5 w-2.5 rounded-[2px] bg-slate-200 dark:bg-slate-700' />{' '}
          quiet
        </span>
        <span>{shortDate(weeks[0].monday)} → today</span>
      </div>
    </div>
  )
}

/** "Usually active 10 AM – 3:30 PM", from UTC hours into the viewer's own clock, to the half hour. */
function TypicalHours({ hours }: { hours: { start: number; end: number; samples: number } }) {
  const offsetH = -new Date().getTimezoneOffset() / 60
  const local = (h: number) => (((h + offsetH) % 24) + 24) % 24
  const fmt = (h: number) => {
    const half = Math.round(h * 2) / 2
    const whole = Math.floor(half) % 24
    const mins = half % 1 ? 30 : 0
    const d = new Date(2000, 0, 1, whole, mins)
    return d.toLocaleTimeString([], { hour: 'numeric', minute: mins ? '2-digit' : undefined })
  }
  return (
    <p className='mt-3 text-[12px] text-slate-600 dark:text-slate-300' data-person-typical-hours>
      Usually active{' '}
      <span className='font-medium text-slate-800 dark:text-slate-100'>
        {fmt(local(hours.start))} – {fmt(local(hours.end))}
      </span>
      <span className='text-slate-400'>
        {' '}
        · your time · based on {hours.samples.toLocaleString()} actions
      </span>
    </p>
  )
}

// ─── Activity feed ───────────────────────────────────────────────────────────

interface ActivityEntry {
  id: number
  action: string
  timestamp: string
  collection: string | null
  item: string | null
  comment: string | null
  ip: string | null
  /** Display-template label, or what a junction row links ("Zone: Zone 3 · on CR26-80332"). */
  record_label?: string | null
  /** True when the row is a junction link — the verb reads linked / unlinked. */
  link?: boolean
  collection_label?: string | null
}
interface ActivitySummary {
  total: number
  actions: Array<{ action: string; count: number }>
  collections: Array<{ collection: string; collection_label?: string | null; count: number }>
}

/** A junction write is a link, not a record — say so. */
function verbFor(entry: ActivityEntry): string {
  if (!entry.link) return entry.action
  if (entry.action === 'create') return 'linked'
  if (entry.action === 'delete') return 'unlinked'
  return entry.action
}

const ACTION_META: Record<string, { cls: string; dot: string }> = {
  create: {
    cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400',
    dot: 'bg-emerald-500'
  },
  update: {
    cls: 'bg-[#00ceff1a] text-nvr-navy dark:text-nvr-cyan',
    dot: 'bg-nvr-cyan'
  },
  delete: { cls: 'bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400', dot: 'bg-red-500' },
  login: {
    cls: 'bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-400',
    dot: 'bg-violet-500'
  }
}
const ACTION_FALLBACK = {
  cls: 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground',
  dot: 'bg-slate-400'
}
const PAGE_LIMIT = 50

export function ActivityFeedCard({ userId }: { userId: string }) {
  const client = useNivaroClient()
  const { urlFor } = useItemNavigation()
  const nav = useNavigation()
  const [action, setAction] = useState('')
  const [collection, setCollection] = useState('')
  const [sort, setSort] = useState<'desc' | 'asc'>('desc')
  const hasFilters = !!action || !!collection

  const { data: summary } = useQuery<ActivitySummary>({
    queryKey: ['nvr-user-activity-summary', userId],
    queryFn: () =>
      client
        .request<{ data: ActivitySummary }>(get(`/user-activity/${userId}/summary`))
        .then((r) => r.data)
  })
  const pages = useInfiniteQuery({
    queryKey: ['nvr-user-activity', userId, action, collection, sort],
    queryFn: ({ pageParam }) =>
      client.request<{ data: ActivityEntry[]; total: number; page: number; limit: number }>(
        get(`/user-activity/${userId}`, {
          page: pageParam,
          limit: PAGE_LIMIT,
          ...(action && { action }),
          ...(collection && { collection }),
          sort
        })
      ),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.limit < last.total ? last.page + 1 : undefined)
  })
  const entries = pages.data?.pages.flatMap((p) => p.data) ?? []
  const total = pages.data?.pages[0]?.total ?? summary?.total ?? 0

  const grouped: Array<{ date: string; entries: ActivityEntry[] }> = []
  for (const entry of entries) {
    const date = new Date(entry.timestamp).toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    })
    const last = grouped[grouped.length - 1]
    if (last?.date === date) last.entries.push(entry)
    else grouped.push({ date, entries: [entry] })
  }

  return (
    <SectionCard
      icon={<Activity className='h-4 w-4' />}
      title='Activity'
      hint={total ? `${total.toLocaleString()} event${total === 1 ? '' : 's'}` : undefined}
      testId='activity'
      actions={
        <button
          type='button'
          onClick={() => setSort((d) => (d === 'desc' ? 'asc' : 'desc'))}
          className='inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] text-slate-500 hover:bg-slate-50 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-muted'
        >
          {sort === 'desc' ? (
            <ArrowDownAZ className='h-3.5 w-3.5' />
          ) : (
            <ArrowUpAZ className='h-3.5 w-3.5' />
          )}
          {sort === 'desc' ? 'Newest first' : 'Oldest first'}
        </button>
      }
    >
      {summary && summary.actions.length > 0 && (
        <div className='mb-3 flex flex-wrap items-center gap-1.5'>
          {summary.actions.map((a) => {
            const meta = ACTION_META[a.action] ?? ACTION_FALLBACK
            return (
              <button
                key={a.action}
                type='button'
                aria-pressed={action === a.action}
                onClick={() => setAction(action === a.action ? '' : a.action)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition-opacity',
                  meta.cls,
                  action && action !== a.action && 'opacity-40'
                )}
              >
                {a.action}
                <span className='font-mono opacity-70'>{a.count}</span>
              </button>
            )
          })}
          {summary.collections.length > 1 && (
            <SimpleSelect
              ariaLabel='Collection'
              value={collection}
              onChange={setCollection}
              options={[
                { value: '', label: 'Every collection' },
                ...summary.collections.map((c) => ({
                  value: c.collection,
                  label: `${c.collection_label ?? c.collection} · ${c.count}`
                }))
              ]}
              className='ml-auto h-7 w-[200px] text-[11.5px]'
            />
          )}
          {hasFilters && (
            <button
              type='button'
              onClick={() => {
                setAction('')
                setCollection('')
              }}
              className='inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-600'
            >
              <X className='h-3 w-3' /> Clear
            </button>
          )}
        </div>
      )}

      {pages.isLoading ? (
        <div className='space-y-3' aria-busy>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className='flex animate-pulse gap-3'>
              <div className='mt-1 h-2 w-2 rounded-full bg-slate-100 dark:bg-muted' />
              <div className='flex-1 space-y-1.5'>
                <div className='h-3 w-24 rounded bg-slate-100 dark:bg-muted' />
                <div className='h-3 w-48 rounded bg-slate-100 dark:bg-muted' />
              </div>
            </div>
          ))}
        </div>
      ) : entries.length === 0 ? (
        <EmptyLine>
          {hasFilters ? 'Nothing matches those filters.' : 'No activity recorded.'}
        </EmptyLine>
      ) : (
        <div>
          {grouped.map((group) => (
            <div key={group.date}>
              <div className='flex items-center gap-3 py-2'>
                <div className='h-px flex-1 bg-slate-100 dark:bg-border' />
                <span className='text-[11px] font-medium text-slate-400'>{group.date}</span>
                <div className='h-px flex-1 bg-slate-100 dark:bg-border' />
              </div>
              <ol className='relative ml-1 border-l border-slate-100 dark:border-border'>
                {group.entries.map((entry) => {
                  const meta = ACTION_META[entry.action] ?? ACTION_FALLBACK
                  const href =
                    entry.collection && entry.item
                      ? urlFor({ collection: entry.collection, itemId: entry.item })
                      : null
                  return (
                    <li key={entry.id} className='relative py-2 pl-4' data-activity-row={entry.id}>
                      <span
                        className={cn(
                          'absolute -left-[4.5px] top-[15px] h-2 w-2 rounded-full',
                          meta.dot
                        )}
                      />
                      <div className='flex flex-wrap items-baseline gap-x-2 gap-y-0.5'>
                        <span
                          className={cn(
                            'rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                            meta.cls
                          )}
                        >
                          {verbFor(entry)}
                        </span>
                        {entry.collection &&
                          (href ? (
                            <a
                              href={href}
                              onClick={(e) => {
                                if (e.metaKey || e.ctrlKey) return
                                e.preventDefault()
                                nav.navigate(href)
                              }}
                              className='min-w-0 truncate text-[12.5px] text-slate-700 hover:underline dark:text-slate-200'
                              title={`${entry.collection} #${entry.item}`}
                            >
                              {entry.link ? null : (
                                <span className='text-slate-400'>
                                  {entry.collection_label ?? entry.collection}{' '}
                                </span>
                              )}
                              <span className='font-medium'>
                                {entry.record_label ?? `#${entry.item}`}
                              </span>
                            </a>
                          ) : (
                            <span className='text-[12.5px] text-slate-600 dark:text-slate-300'>
                              {entry.collection_label ?? entry.collection}
                            </span>
                          ))}
                        <span
                          className='ml-auto text-[11px] text-slate-400'
                          title={formatDateTime(entry.timestamp)}
                        >
                          {formatRelative(entry.timestamp)}
                        </span>
                      </div>
                      {entry.comment && (
                        <p className='mt-0.5 text-[11.5px] text-slate-500 dark:text-slate-400'>
                          {entry.comment}
                        </p>
                      )}
                      {entry.ip && (
                        <span className='mt-0.5 inline-flex items-center gap-1 font-mono text-[10px] text-slate-300 dark:text-slate-600'>
                          <Globe className='h-2.5 w-2.5' /> {entry.ip}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ol>
            </div>
          ))}
          {pages.hasNextPage && (
            <div className='pt-3 text-center'>
              <button
                type='button'
                disabled={pages.isFetchingNextPage}
                onClick={() => void pages.fetchNextPage()}
                className='inline-flex h-7 items-center rounded-md border border-slate-200 px-3 text-[11.5px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:text-slate-300 dark:hover:bg-muted'
              >
                {pages.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </div>
      )}
    </SectionCard>
  )
}

// ─── Journey trail (admin pages visited) ─────────────────────────────────────

interface JourneyStep {
  path: string
  entered_at: string
  duration_seconds: number | null
}
interface JourneySession {
  session_id: string
  started_at: string
  steps: JourneyStep[]
}

function pageLabel(path: string): string {
  if (path === '/') return 'Dashboard'
  const parts = path.split('/').filter(Boolean)
  if (parts[0] === 'collections' && parts[1]) {
    return parts[2] ? `${parts[1]} · record ${parts[2]}` : `${parts[1]} (browser)`
  }
  return parts
    .map((p) => p.replace(/-/g, ' '))
    .join(' › ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}
function fmtDuration(seconds: number | null): string {
  if (seconds == null) return ''
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  return m < 60 ? `${m}m ${seconds % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

export function JourneyCard({ userId }: { userId: string }) {
  const client = useNivaroClient()
  const nav = useNavigation()
  const today = new Date().toISOString().slice(0, 10)
  const [date, setDate] = useState(today)
  const { data: days = [] } = useQuery<Array<{ date: string; steps: number }>>({
    queryKey: ['nvr-journey-days', userId],
    queryFn: () =>
      client
        .request<{ data: Array<{ date: string; steps: number }> }>(get(`/journeys/days/${userId}`))
        .then((r) => r.data)
        .catch(() => [])
  })
  const { data, isLoading } = useQuery<{ sessions: JourneySession[] } | null>({
    queryKey: ['nvr-journey', userId, date],
    queryFn: () =>
      client
        .request<{ data: { sessions: JourneySession[] } }>(
          get(`/journeys/user/${userId}`, { date })
        )
        .then((r) => r.data)
        .catch(() => null)
  })
  const sessions = data?.sessions ?? []
  const adminHref = (path: string) => (nav.consoleUrl ? nav.consoleUrl(path) : path)
  return (
    <SectionCard
      icon={<Footprints className='h-4 w-4' />}
      title='Pages visited'
      hint='Their path through the admin, per session — kept 30 days'
      testId='journey'
    >
      {days.length > 0 && (
        <div className='mb-3 flex flex-wrap gap-1.5'>
          {days.slice(0, 14).map((d) => (
            <button
              key={d.date}
              type='button'
              aria-pressed={date === d.date}
              onClick={() => setDate(d.date)}
              className={cn(
                'rounded-full border px-2 py-0.5 text-[11px]',
                date === d.date
                  ? 'border-nvr-cyan bg-accent text-nvr-navy dark:text-nvr-cyan'
                  : 'border-slate-200 text-slate-500 dark:border-border dark:text-slate-400'
              )}
              title={`${d.steps} page views`}
            >
              {d.date === today ? 'Today' : d.date.slice(5)}
            </button>
          ))}
        </div>
      )}
      {isLoading ? (
        <EmptyLine>Loading…</EmptyLine>
      ) : sessions.length === 0 ? (
        <EmptyLine>No admin pages recorded {date === today ? 'today' : `on ${date}`}.</EmptyLine>
      ) : (
        <div className='space-y-4'>
          {sessions.map((s, si) => (
            <div key={s.session_id}>
              <p className='mb-1.5 text-[11px] font-medium text-slate-400'>
                Session {si + 1} · started {formatRelative(s.started_at)} · {s.steps.length} page
                {s.steps.length === 1 ? '' : 's'}
              </p>
              <ol className='relative ml-2 border-l border-slate-200 dark:border-border'>
                {s.steps.map((step, i) => {
                  const safe =
                    step.path.startsWith('/') &&
                    !step.path.startsWith('//') &&
                    !step.path.includes(':')
                  const href = safe ? adminHref(step.path) : null
                  return (
                    <li key={`${step.entered_at}-${i}`} className='relative py-1 pl-4'>
                      <span className='absolute -left-[3.5px] top-[13px] h-1.5 w-1.5 rounded-full bg-nvr-cyan' />
                      <div className='flex items-baseline gap-2'>
                        {href ? (
                          <a
                            href={href}
                            onClick={(e) => {
                              if (e.metaKey || e.ctrlKey) return
                              e.preventDefault()
                              nav.navigate(href)
                            }}
                            className='truncate text-[12.5px] text-slate-700 hover:text-nvr-navy hover:underline dark:text-slate-300 dark:hover:text-nvr-cyan'
                          >
                            {pageLabel(step.path)}
                          </a>
                        ) : (
                          <span className='truncate text-[12.5px] text-slate-700 dark:text-slate-300'>
                            {pageLabel(step.path)}
                          </span>
                        )}
                        <span className='shrink-0 text-[10.5px] tabular-nums text-slate-400'>
                          {new Date(step.entered_at).toLocaleTimeString(undefined, {
                            hour: '2-digit',
                            minute: '2-digit'
                          })}
                          {step.duration_seconds != null &&
                            ` · ${fmtDuration(step.duration_seconds)}`}
                        </span>
                      </div>
                    </li>
                  )
                })}
              </ol>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  )
}

// ─── Sign-ins ────────────────────────────────────────────────────────────────

export function SignInsCard({ profile: p }: { profile: PersonProfile }) {
  const logins = p.admin?.logins ?? []
  return (
    <SectionCard
      icon={<LogIn className='h-4 w-4' />}
      title='Sign-ins'
      hint={
        p.admin
          ? `${p.admin.sessions} live session${p.admin.sessions === 1 ? '' : 's'} · ${p.admin.activity_30d.toLocaleString()} actions in 30 days`
          : undefined
      }
      testId='sign-ins'
    >
      {logins.length === 0 ? (
        <EmptyLine>No sign-in recorded yet.</EmptyLine>
      ) : (
        <ul className='space-y-1.5'>
          {logins.map((l) => (
            <li
              key={l.at}
              className='flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-slate-600 dark:text-slate-300'
            >
              <span title={formatDateTime(l.at)}>{formatRelative(l.at)}</span>
              <span className='rounded-full bg-slate-100 px-1.5 py-px text-[10.5px] font-medium text-slate-600 dark:bg-muted dark:text-slate-300'>
                {l.method}
              </span>
              {l.ip && <span className='font-mono text-[11px] text-slate-400'>{l.ip}</span>}
              {l.new_ip && (
                <span className='rounded-full bg-amber-50 px-1.5 py-px text-[10.5px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'>
                  new address
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  )
}
