import { QueryErrorState } from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import {
  type CalendarEvent,
  type CalendarKind,
  changeKeys,
  fetchCalendar,
  KIND_WORDS,
  STATUS_WORDS
} from './changes-api'

/**
 * The change calendar: month, week or list over the Hub's own rows. Days are the viewer's own
 * calendar days. Deploy windows (allowed times, not changes) show only in the week view, as the
 * open hours of each day; the other views list what changes.
 */

export type CalendarView = 'month' | 'week' | 'list'

// The 3 px edge each entry carries; the legend chips are the only place the word is spelled.
export const KIND_META: Record<CalendarKind, { bar: string; chip: string }> = {
  promote: { bar: 'bg-nvr-cyan', chip: 'bg-nvr-cyan/15 text-nvr-navy dark:text-nvr-cyan' },
  // Not amber: in the Hub look the accent (promote) is amber, and a rollback must read apart.
  rollback: {
    bar: 'bg-fuchsia-500',
    chip: 'bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300'
  },
  scheduled: {
    bar: 'bg-indigo-500',
    chip: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300'
  },
  train: { bar: 'bg-indigo-400', chip: 'bg-indigo-400/10 text-indigo-700 dark:text-indigo-300' },
  move: { bar: 'bg-violet-500', chip: 'bg-violet-500/10 text-violet-700 dark:text-violet-300' },
  upgrade: { bar: 'bg-slate-500', chip: 'bg-slate-500/10 text-slate-700 dark:text-slate-300' },
  freeze: { bar: 'bg-sky-500', chip: 'bg-sky-500/10 text-sky-800 dark:text-sky-300' },
  window: {
    bar: 'bg-emerald-500',
    chip: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  },
  maintenance: {
    bar: 'bg-orange-500',
    chip: 'bg-orange-500/10 text-orange-700 dark:text-orange-300'
  },
  note: { bar: 'bg-slate-400', chip: 'bg-slate-400/10 text-slate-600 dark:text-slate-300' },
  tls: { bar: 'bg-red-500', chip: 'bg-red-500/10 text-red-700 dark:text-red-300' },
  other: { bar: 'bg-slate-400', chip: 'bg-slate-400/10 text-slate-600 dark:text-slate-300' }
}

/** The legend, in the order people look for things. */
export const LEGEND: CalendarKind[] = [
  'promote',
  'rollback',
  'scheduled',
  'train',
  'move',
  'upgrade',
  'freeze',
  'maintenance',
  'tls',
  'window'
]

function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}
/** Monday of the week holding `d` (local). */
function startOfWeek(d: Date): Date {
  const x = startOfDay(d)
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7))
  return x
}
const addDays = (d: Date, n: number) => {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`

/** The days the view shows and the range read for them. */
export function viewRange(
  view: CalendarView,
  anchor: Date
): { days: Date[]; from: Date; to: Date } {
  if (view === 'week') {
    const from = startOfWeek(anchor)
    const days = Array.from({ length: 7 }, (_, i) => addDays(from, i))
    return { days, from, to: addDays(from, 7) }
  }
  if (view === 'list') {
    const from = startOfDay(anchor)
    const days = Array.from({ length: 42 }, (_, i) => addDays(from, i))
    return { days, from, to: addDays(from, 42) }
  }
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  const from = startOfWeek(first)
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0)
  const to = addDays(startOfWeek(last), 7)
  const days: Date[] = []
  for (let d = from; d < to; d = addDays(d, 1)) days.push(d)
  return { days, from, to }
}

/** The events touching one local day (an event spanning days shows on each). */
export function eventsOn(events: CalendarEvent[], day: Date): CalendarEvent[] {
  const a = day.getTime()
  const b = addDays(day, 1).getTime()
  return events.filter((e) => {
    const s = Date.parse(e.start)
    const end = e.end ? Date.parse(e.end) : s
    return s < b && Math.max(end, s + 1) > a
  })
}

/** 7 AM, 9:12 AM — minutes only when there are some (narrow week columns). */
const time = (iso: string) => {
  const d = new Date(iso)
  return d.toLocaleTimeString([], {
    hour: 'numeric',
    ...(d.getMinutes() ? { minute: '2-digit' } : {})
  })
}

function spanWords(e: CalendarEvent, day: Date): string {
  const s = Date.parse(e.start)
  const end = e.end ? Date.parse(e.end) : null
  const dayStart = day.getTime()
  const dayEnd = addDays(day, 1).getTime()
  if (end == null) return time(e.start)
  const fromStart = s <= dayStart
  const toEnd = end >= dayEnd
  if (fromStart && toEnd) return 'all day'
  const from = s < dayStart ? 'earlier' : time(e.start)
  const to = end > dayEnd ? 'later' : end === dayEnd ? 'midnight' : time(e.end as string)
  return `${from}–${to}`
}

function EventRow({ e, day, dense }: { e: CalendarEvent; day: Date; dense?: boolean }) {
  const meta = KIND_META[e.kind] ?? KIND_META.other
  const where = [e.app_key, e.env_key].filter(Boolean).join(' · ')
  const tip = [`${KIND_WORDS[e.kind]} · ${STATUS_WORDS[e.status]}`, where || null, e.detail]
    .filter(Boolean)
    .join(' — ')
  const title = (
    <span
      className={cn(
        'min-w-0 text-[11.5px] leading-snug text-slate-700 [overflow-wrap:anywhere] dark:text-slate-200',
        dense ? 'line-clamp-3' : 'flex-1',
        e.status === 'cancelled' && 'line-through',
        e.status === 'failed' && 'text-red-700 dark:text-red-300'
      )}
    >
      {e.title}
      {e.status === 'failed' && <span className='sr-only'> (failed)</span>}
      {e.status === 'on' && (
        <span className='ml-1 text-[10.5px] font-medium text-sky-700 dark:text-sky-300'>
          on now
        </span>
      )}
      {e.status === 'running' && (
        <span className='ml-1 text-[10.5px] font-medium text-nvr-navy dark:text-nvr-cyan'>
          running
        </span>
      )}
    </span>
  )
  const when = (
    <span className='shrink-0 pt-px text-[10.5px] tabular-nums text-slate-500 dark:text-slate-400'>
      {spanWords(e, day)}
    </span>
  )
  return (
    <div
      data-tip={tip}
      className={cn(
        'flex items-start gap-1.5 rounded-md px-1.5 py-1',
        e.status === 'cancelled' && 'opacity-70'
      )}
    >
      <span className={cn('w-[3px] shrink-0 self-stretch rounded-full', meta.bar)} aria-hidden />
      <span className='sr-only'>{KIND_WORDS[e.kind]}: </span>
      {dense ? (
        // A narrow week column: the time above the title, never squeezed beside it.
        <span className='flex min-w-0 flex-1 flex-col'>
          {when}
          {title}
        </span>
      ) : (
        <>
          {title}
          {when}
        </>
      )}
    </div>
  )
}

function DayHead({ day, compact }: { day: Date; compact?: boolean }) {
  const today = dayKey(day) === dayKey(new Date())
  return (
    <div
      className={cn(
        'text-[12px] font-semibold',
        today ? 'text-nvr-navy dark:text-nvr-cyan' : 'text-slate-600 dark:text-slate-300'
      )}
    >
      {day.toLocaleDateString(
        undefined,
        compact ? { day: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric' }
      )}
      {today &&
        (compact ? (
          <span className='sr-only'> (today)</span>
        ) : (
          <span className='ml-1.5 text-[10px] font-medium uppercase'>today</span>
        ))}
    </div>
  )
}

export function ChangeCalendar({
  view,
  anchor,
  onAnchor,
  appId,
  hidden
}: {
  view: CalendarView
  anchor: Date
  onAnchor: (d: Date) => void
  appId: number | null
  hidden: Set<CalendarKind>
}) {
  const { days, from, to } = useMemo(() => viewRange(view, anchor), [view, anchor])
  const fromIso = from.toISOString()
  const toIso = to.toISOString()
  const q = useQuery({
    queryKey: changeKeys.calendar(fromIso, toIso, appId),
    queryFn: () => fetchCalendar(fromIso, toIso, appId),
    refetchInterval: 60_000
  })
  const [picked, setPicked] = useState<string | null>(null)
  const events = useMemo(
    () => (q.data?.events ?? []).filter((e) => !hidden.has(e.kind)),
    [q.data, hidden]
  )
  const changes = useMemo(() => events.filter((e) => e.kind !== 'window'), [events])

  const step = (dir: -1 | 1) => {
    if (view === 'month') onAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1))
    else onAnchor(addDays(anchor, dir * (view === 'week' ? 7 : 42)))
  }
  const title =
    view === 'month'
      ? anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
      : `${days[0].toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${days[days.length - 1].toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`

  const navButton =
    'flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:border-border dark:hover:bg-muted'
  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center gap-2'>
        <button type='button' className={navButton} aria-label='Earlier' onClick={() => step(-1)}>
          <ChevronLeft className='h-4 w-4' aria-hidden />
        </button>
        <button
          type='button'
          onClick={() => onAnchor(new Date())}
          className='h-8 whitespace-nowrap rounded-md border border-slate-200 px-3 text-[12.5px] font-medium text-slate-600 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:border-border dark:text-slate-300 dark:hover:bg-muted'
        >
          Today
        </button>
        <button type='button' className={navButton} aria-label='Later' onClick={() => step(1)}>
          <ChevronRight className='h-4 w-4' aria-hidden />
        </button>
        <h3
          className='m-0 ml-1 text-[14px] font-semibold text-slate-900 dark:text-foreground'
          aria-live='polite'
        >
          {title}
        </h3>
      </div>

      {q.isPending ? (
        <Skeleton className='h-72 w-full' />
      ) : q.isError ? (
        <QueryErrorState
          error={q.error}
          what='the change calendar'
          onRetry={() => void q.refetch()}
        />
      ) : view === 'month' ? (
        <MonthGrid
          days={days}
          month={anchor.getMonth()}
          events={changes}
          picked={picked}
          onPick={setPicked}
        />
      ) : view === 'week' ? (
        <WeekGrid days={days} events={events} />
      ) : (
        <AgendaList days={days} events={changes} />
      )}
    </div>
  )
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function MonthGrid({
  days,
  month,
  events,
  picked,
  onPick
}: {
  days: Date[]
  month: number
  events: CalendarEvent[]
  picked: string | null
  onPick: (k: string | null) => void
}) {
  const pickedDay = days.find((d) => dayKey(d) === picked) ?? null
  return (
    <div className='space-y-3'>
      <div className='overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border'>
        <div className='grid grid-cols-7 gap-px'>
          {WEEKDAYS.map((w) => (
            <div
              key={w}
              className='bg-slate-50 px-2 py-1.5 text-[11px] font-medium text-slate-500 dark:bg-muted/40 dark:text-muted-foreground'
            >
              {w}
            </div>
          ))}
          {days.map((d) => {
            const list = eventsOn(events, d)
            const k = dayKey(d)
            const outside = d.getMonth() !== month
            const shown = list.slice(0, 3)
            return (
              <button
                key={k}
                type='button'
                onClick={() => onPick(picked === k ? null : k)}
                aria-pressed={picked === k}
                aria-label={`${d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}: ${list.length ? `${list.length} change${list.length === 1 ? '' : 's'}` : 'nothing'}`}
                className={cn(
                  'flex min-h-[64px] flex-col items-stretch gap-1 bg-white p-1.5 text-left align-top hover:bg-slate-50 focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/60 sm:min-h-[104px] dark:bg-card dark:hover:bg-muted/50',
                  outside && 'bg-slate-50/70 dark:bg-card/60',
                  picked === k && 'ring-2 ring-inset ring-nvr-cyan'
                )}
              >
                <span className={cn(outside && 'text-slate-500 dark:text-muted-foreground')}>
                  <DayHead day={d} compact />
                </span>
                {/* Phones: a dot per change; wider: up to three titles. */}
                <span className='flex flex-wrap gap-1 sm:hidden' aria-hidden>
                  {list.slice(0, 6).map((e) => (
                    <span
                      key={e.id}
                      className={cn('h-1.5 w-1.5 rounded-full', KIND_META[e.kind].bar)}
                    />
                  ))}
                </span>
                <span className='hidden space-y-0.5 sm:block' aria-hidden>
                  {shown.map((e) => (
                    <span
                      key={e.id}
                      className={cn(
                        'flex items-center gap-1 truncate text-[11px] leading-tight text-slate-700 dark:text-slate-200',
                        e.status === 'cancelled' && 'line-through opacity-70'
                      )}
                    >
                      <span
                        className={cn('h-1.5 w-1.5 shrink-0 rounded-full', KIND_META[e.kind].bar)}
                      />
                      <span className='truncate'>{e.title}</span>
                    </span>
                  ))}
                  {list.length > shown.length && (
                    <span className='block text-[10.5px] font-medium text-nvr-navy dark:text-nvr-cyan'>
                      +{list.length - shown.length} more
                    </span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      </div>
      {pickedDay ? (
        <DayPanel day={pickedDay} events={eventsOn(events, pickedDay)} />
      ) : (
        <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
          Pick a day to see everything on it.
        </p>
      )}
    </div>
  )
}

function DayPanel({ day, events }: { day: Date; events: CalendarEvent[] }) {
  return (
    <section
      aria-label={day.toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric'
      })}
      className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
    >
      <div className='border-b border-slate-100 px-3 py-2 dark:border-border/60'>
        <DayHead day={day} />
      </div>
      <div className='space-y-0.5 p-2'>
        {events.length === 0 ? (
          <p className='m-0 px-1.5 py-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
            Nothing planned or recorded on this day.
          </p>
        ) : (
          events.map((e) => <EventRow key={e.id} e={e} day={day} />)
        )}
      </div>
    </section>
  )
}

function WeekGrid({ days, events }: { days: Date[]; events: CalendarEvent[] }) {
  return (
    <div className='grid grid-cols-1 gap-3 lg:grid-cols-7'>
      {days.map((d) => {
        const list = eventsOn(events, d)
        const open = list.filter((e) => e.kind === 'window')
        const changes = list.filter((e) => e.kind !== 'window')
        const today = dayKey(d) === dayKey(new Date())
        return (
          <section
            key={dayKey(d)}
            aria-label={d.toLocaleDateString(undefined, {
              weekday: 'long',
              month: 'long',
              day: 'numeric'
            })}
            className={cn(
              'rounded-lg border bg-white dark:bg-card',
              today ? 'border-nvr-cyan/50' : 'border-slate-200 dark:border-border'
            )}
          >
            <div className='border-b border-slate-100 px-3 py-2 dark:border-border/60'>
              <DayHead day={d} />
            </div>
            {open.length > 0 && (
              <div className='space-y-0.5 border-b border-slate-100 px-3 py-1.5 dark:border-border/60'>
                {open.map((w) => (
                  <p
                    key={w.id}
                    data-tip={w.detail ?? undefined}
                    className='m-0 truncate text-[11px] text-emerald-700 dark:text-emerald-300'
                  >
                    Open {spanWords(w, d)}
                    {w.app_key ? ` · ${w.app_key}` : ''}
                  </p>
                ))}
              </div>
            )}
            <div className='space-y-0.5 p-2'>
              {changes.length === 0 ? (
                <p className='m-0 px-1 py-1 text-[11px] text-slate-400 dark:text-slate-500'>
                  No changes
                </p>
              ) : (
                changes.map((e) => <EventRow key={e.id} e={e} day={d} dense />)
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function AgendaList({ days, events }: { days: Date[]; events: CalendarEvent[] }) {
  const withEvents = days
    .map((d) => ({ day: d, list: eventsOn(events, d) }))
    .filter((x) => x.list.length > 0)
  if (!withEvents.length)
    return (
      <p className='m-0 rounded-lg border border-slate-200 bg-white px-4 py-6 text-center text-[12px] text-slate-500 dark:border-border dark:bg-card dark:text-muted-foreground'>
        Nothing planned or recorded in these six weeks.
      </p>
    )
  return (
    <ol className='m-0 list-none space-y-3 p-0'>
      {withEvents.map(({ day, list }) => (
        <li
          key={dayKey(day)}
          className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
        >
          <div className='border-b border-slate-100 px-3 py-2 dark:border-border/60'>
            <DayHead day={day} />
          </div>
          <div className='space-y-0.5 p-2'>
            {list.map((e) => (
              <EventRow key={e.id} e={e} day={day} />
            ))}
          </div>
        </li>
      ))}
    </ol>
  )
}
