import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Flame, Footprints, LogIn } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useItemNavigation, useNavigation, useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn, formatDateTime, formatRelative } from '../../lib/utils'
import { ErrorNotice } from '../ErrorNotice'
import { SkeletonBar } from '../Skeletons'
import { SimpleSelect } from '../ui/SimpleSelect'
import { isSafeAdminPath, localDateKey, localDayOffset, shiftDate } from './dayTimelineLayout'
import {
  fallbackJourneyLabel,
  fmtClock,
  fmtDuration,
  fmtSpan,
  foldJourneySession,
  type JourneyRow,
  type JourneySessionView,
  type JourneyStepIn,
  words
} from './journey-view'
import { EmptyLine, SectionCard, usePersonUrl } from './primitives'
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
// The feed lives in ./ActivityFeedCard (shared activity sentences, access changes to them).

export { ActivityFeedCard, activityLinkable } from './ActivityFeedCard'

// ─── Pages visited (journey trail) ───────────────────────────────────────────

interface JourneySession {
  session_id: string
  started_at: string
  app?: string
  steps: JourneyStepIn[]
}

/** A route in words, for callers that have only the path (the Day view's fallback). */
export function pageLabel(path: string): string {
  const l = fallbackJourneyLabel(path)
  return l.section && l.kind === 'page' ? `${l.section} › ${l.title}` : l.title
}
export { fmtDuration }

/** Days with page data (last 30) and the front ends seen — shared by the
 *  Pages visited card and the Day view, keyed ['nvr-journey-days', id, app]. */
export function fetchJourneyDays(
  client: ReturnType<typeof useNivaroClient>,
  userId: string,
  app: string | null
): Promise<{ days: Array<{ date: string; steps: number }>; apps: string[] }> {
  return client
    .request<{ data: Array<{ date: string; steps: number }>; apps?: string[] }>(
      get(`/journeys/days/${userId}`, app ? { app } : undefined)
    )
    .then((r) => ({ days: r.data ?? [], apps: r.apps ?? [] }))
    .catch(() => ({ days: [], apps: [] }))
}

/**
 * An app's name for people: the admin is "Admin"; a portal reads "Portal" when it is the only
 * one, else its label in words ("Field portal"), never a raw key like "efp-new".
 */
function appNamer(apps: string[]): (a: string | null | undefined) => string {
  const portals = apps.filter((a) => a !== 'admin')
  return (a) => {
    if (!a || a === 'admin') return 'Admin'
    return portals.length <= 1 ? 'Portal' : words(a)
  }
}

/** A duration as fmtDuration shows it, in seconds — so a day total adds up to what its sessions say. */
function shownSeconds(s: number): number {
  return s < 600 ? s : Math.floor(s / 60) * 60
}

/** "Today", "Yesterday", "Wed, Nov 11". */
function dayName(date: string, today: string): string {
  if (date === today) return 'Today'
  if (date === shiftDate(today, -1)) return 'Yesterday'
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(Number(today.slice(0, 4)) !== y ? { year: 'numeric' } : {})
  })
}

/** "yesterday", "Wed, Nov 11" ("on Wed, Nov 11" with `on`) — for use inside a sentence. */
function midSentenceDay(date: string, today: string, on = false): string {
  const name = dayName(date, today)
  if (name === 'Today' || name === 'Yesterday') return name.toLowerCase()
  return on ? `on ${name}` : name
}

/** Rows shown before a long session folds behind "Show more". */
const SESSION_PREVIEW = 8
/** Time on one page that reads as real work rather than passing through. */
const LONG_DWELL_S = 5 * 60

export function JourneyCard({ userId }: { userId: string }) {
  const client = useNivaroClient()
  const today = localDateKey(new Date())
  const [date, setDate] = useState(today)
  // #1391 — journeys cover the admin and the portal; null = every app.
  const [appFilter, setAppFilter] = useState<string | null>(null)
  const { data: dayData } = useQuery({
    queryKey: ['nvr-journey-days', userId, appFilter],
    queryFn: () => fetchJourneyDays(client, userId, appFilter)
  })
  const days = dayData?.days ?? []
  const apps = dayData?.apps ?? []
  const tzOffset = localDayOffset(date)
  const { data, isLoading, isError, error, refetch } = useQuery<{ sessions: JourneySession[] }>({
    queryKey: ['nvr-journey', userId, date, tzOffset, appFilter],
    queryFn: () =>
      client
        .request<{ data: { sessions: JourneySession[] } }>(
          get(`/journeys/user/${userId}`, {
            date,
            tz_offset: tzOffset,
            ...(appFilter ? { app: appFilter } : {})
          })
        )
        .then((r) => r.data ?? { sessions: [] }),
    retry: false
  })
  const multiApp = apps.length > 1 || (apps.length === 1 && apps[0] !== 'admin')

  // The picker offers today plus every day with pages, newest first.
  const dayKeys = useMemo(
    () => [...new Set([today, ...days.map((d) => d.date)])].sort().reverse(),
    [today, days]
  )
  const at = dayKeys.indexOf(date)
  const newer = at > 0 ? dayKeys[at - 1] : null
  const older = at >= 0 && at < dayKeys.length - 1 ? dayKeys[at + 1] : null

  const sessions = useMemo(
    () =>
      (data?.sessions ?? [])
        .map((s) => ({ s, v: foldJourneySession(s.steps) }))
        .filter((x) => x.v.rows.length > 0)
        .sort((a, b) => a.v.start.localeCompare(b.v.start)),
    [data]
  )
  const maxDwell = Math.max(60, ...sessions.flatMap((x) => x.v.rows.map((r) => r.seconds ?? 0)))
  const totalSeconds = sessions.reduce((n, x) => n + shownSeconds(x.v.seconds), 0)
  const appName = appNamer(apps)
  const latestDay = days.find((d) => d.date !== date)?.date ?? null

  const stepButton =
    'inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40 disabled:pointer-events-none disabled:opacity-30 dark:text-slate-400 dark:hover:bg-muted dark:hover:text-slate-100'
  const dayControls = (
    <div className='flex items-center gap-0.5' data-journey-day-picker>
      <button
        type='button'
        aria-label='Earlier day'
        disabled={!older}
        onClick={() => older && setDate(older)}
        className={stepButton}
      >
        <ChevronLeft className='h-3.5 w-3.5' />
      </button>
      <SimpleSelect
        value={date}
        onChange={setDate}
        ariaLabel='Day'
        options={dayKeys.map((k) => ({ value: k, label: dayName(k, today) }))}
        className='h-7 w-[124px] gap-1 rounded-md border-slate-200 bg-white px-2 text-[12px] font-medium text-slate-700 dark:border-border dark:bg-card dark:text-slate-200 [&>svg]:h-3.5 [&>svg]:w-3.5'
        triggerProps={{ 'data-journey-day': date }}
      />
      <button
        type='button'
        aria-label='Later day'
        disabled={!newer}
        onClick={() => newer && setDate(newer)}
        className={stepButton}
      >
        <ChevronRight className='h-3.5 w-3.5' />
      </button>
    </div>
  )

  return (
    <SectionCard
      icon={<Footprints className='h-4 w-4' />}
      title='Pages visited'
      hint='Session by session, kept 30 days'
      testId='journey'
      actions={dayControls}
    >
      {(multiApp || sessions.length > 0) && (
        <div className='mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2'>
          {multiApp ? (
            <fieldset
              className='inline-flex rounded-md border border-slate-200 p-0.5 dark:border-border'
              data-journey-apps
            >
              <legend className='sr-only'>App</legend>
              {[null, ...apps].map((a) => (
                <button
                  key={a ?? '__all'}
                  type='button'
                  aria-pressed={appFilter === a}
                  data-journey-app-filter={a ?? 'all'}
                  onClick={() => setAppFilter(a)}
                  className={cn(
                    'h-6 rounded px-2.5 text-[11.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40',
                    appFilter === a
                      ? 'bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                      : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
                  )}
                >
                  {a ? appName(a) : 'All apps'}
                </button>
              ))}
            </fieldset>
          ) : (
            <span />
          )}
          {sessions.length > 0 && (
            <p
              className='text-[11.5px] tabular-nums text-slate-500 dark:text-slate-400'
              data-journey-summary
            >
              {sessions.length} session{sessions.length === 1 ? '' : 's'} ·{' '}
              {fmtDuration(totalSeconds) || 'under a minute'}
            </p>
          )}
        </div>
      )}
      {isLoading ? (
        <JourneySkeleton />
      ) : isError ? (
        <ErrorNotice error={error} what='the pages visited' onRetry={() => void refetch()} />
      ) : sessions.length === 0 ? (
        <div className='flex flex-wrap items-center gap-x-2 gap-y-1' data-journey-empty>
          <EmptyLine>
            No pages recorded {date === today ? 'today' : midSentenceDay(date, today, true)}.
          </EmptyLine>
          {latestDay && (
            <button
              type='button'
              onClick={() => setDate(latestDay)}
              className='text-[12px] font-medium text-nvr-navy underline decoration-nvr-navy/30 underline-offset-2 hover:decoration-nvr-navy focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40 dark:text-nvr-cyan dark:decoration-nvr-cyan/40 dark:hover:decoration-nvr-cyan'
            >
              Show {midSentenceDay(latestDay, today)}
            </button>
          )}
        </div>
      ) : (
        <div className='divide-y divide-slate-100 dark:divide-border/60'>
          {sessions.map(({ s, v }) => (
            <JourneySessionBlock
              key={s.session_id}
              app={s.app ?? 'admin'}
              appName={appName(s.app ?? 'admin')}
              view={v}
              showApp={multiApp}
              maxDwell={maxDwell}
            />
          ))}
        </div>
      )}
    </SectionCard>
  )
}

function JourneySkeleton() {
  return (
    <div className='space-y-3' role='status' aria-busy='true' aria-label='Loading pages visited'>
      <SkeletonBar width={160} className='h-3.5' />
      {[72, 54, 64, 46].map((w) => (
        <div key={w} className='flex items-center gap-3'>
          <SkeletonBar width={48} />
          <SkeletonBar width={`${w}%`} />
          <SkeletonBar width={40} className='ml-auto' />
        </div>
      ))}
    </div>
  )
}

function JourneySessionBlock({
  app,
  appName,
  view,
  showApp,
  maxDwell
}: {
  app: string
  appName: string
  view: JourneySessionView
  showApp: boolean
  maxDwell: number
}) {
  const [all, setAll] = useState(false)
  const folded = view.rows.length > SESSION_PREVIEW + 2 && !all
  const rows = folded ? view.rows.slice(0, SESSION_PREVIEW) : view.rows
  return (
    <section className='py-4 first:pt-0 last:pb-0' data-journey-session>
      <header className='mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5'>
        <h4 className='text-[13px] font-semibold tabular-nums text-slate-800 dark:text-slate-100'>
          {fmtSpan(view.start, view.end)}
        </h4>
        <p className='text-[11.5px] tabular-nums text-slate-500 dark:text-slate-400'>
          {fmtDuration(view.seconds) || 'under a minute'} · {view.views} page view
          {view.views === 1 ? '' : 's'}
        </p>
        {showApp && (
          <span
            className='ml-auto rounded bg-slate-100 px-1.5 py-px text-[10.5px] font-medium text-slate-600 dark:bg-muted dark:text-slate-300'
            data-journey-app={app}
          >
            {appName}
          </span>
        )}
      </header>
      <ol className='-mx-2'>
        {rows.map((r) => (
          <JourneyRowItem
            key={`${r.start}-${r.label.key}`}
            row={r}
            maxDwell={maxDwell}
            appName={appName}
          />
        ))}
      </ol>
      {(folded || view.skipped > 0) && (
        <div className='mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]'>
          {folded && (
            <button
              type='button'
              onClick={() => setAll(true)}
              className='font-medium text-nvr-navy hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40 dark:text-nvr-cyan'
            >
              Show {view.rows.length - SESSION_PREVIEW} more
            </button>
          )}
          {view.skipped > 0 && (
            <span className='text-slate-500 dark:text-slate-400' data-journey-skipped>
              {view.skipped === 1
                ? '1 page open for less than a second isn’t shown'
                : `${view.skipped} pages open for less than a second aren’t shown`}
            </span>
          )}
        </div>
      )}
    </section>
  )
}

function JourneyRowItem({
  row,
  maxDwell,
  appName
}: {
  row: JourneyRow
  maxDwell: number
  appName: string
}) {
  const nav = useNavigation()
  const { urlFor, open } = useItemNavigation()
  const personUrl = usePersonUrl()
  const l = row.label
  const consoleHref = (p: string) => (nav.consoleUrl ? nav.consoleUrl(p) : p)

  // Records open in the app the VIEWER is in; queues and admin pages through the console map.
  // A portal page that is not a record has no address here, so it is shown, not linked.
  let href: string | null = null
  let go: (() => void) | null = null
  if (l.record) {
    const target = { collection: l.record.collection, itemId: l.record.id }
    href = urlFor(target)
    go = () => open(target)
  } else if (l.queue_id) {
    href = consoleHref(`/queues/${encodeURIComponent(l.queue_id)}`)
  } else if (l.person_id) {
    href = personUrl(l.person_id)
  } else if (row.app === 'admin' && l.kind !== 'record' && isSafeAdminPath(row.path)) {
    href = consoleHref(row.path)
  }
  // A record's title already names its kind ("Workflow CM26-1"), and a section named like the
  // session's app ("Admin" under an Admin session) says nothing — both are left out.
  const section =
    l.kind === 'record' ||
    l.kind === 'new-record' ||
    l.section?.toLowerCase() === appName.toLowerCase()
      ? null
      : l.section
  const meta = [section, ...row.details, row.visits > 1 ? `${row.visits} visits` : null].filter(
    Boolean
  ) as string[]
  const long = (row.seconds ?? 0) >= LONG_DWELL_S
  // The bar shows where the time went; a stop under a minute gets none (a stub reads as a dash).
  const bar =
    (row.seconds ?? 0) >= 60
      ? Math.max(15, Math.round(Math.sqrt((row.seconds ?? 0) / maxDwell) * 100))
      : 0
  const title = <span className='line-clamp-2 break-words'>{l.title}</span>
  return (
    <li
      className='grid grid-cols-[52px_minmax(0,1fr)_auto] items-start gap-x-2 rounded-md px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-muted/40'
      data-journey-row={l.kind}
    >
      <time
        dateTime={row.start}
        className='pt-px text-[11.5px] tabular-nums text-slate-500 dark:text-slate-400'
      >
        {fmtClock(row.start)}
      </time>
      <div className='min-w-0'>
        {href ? (
          <a
            href={href}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
              e.preventDefault()
              if (go) go()
              else if (href) nav.navigate(href)
            }}
            className='block text-[12.5px] font-medium leading-snug text-slate-800 underline-offset-2 hover:text-nvr-navy hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40 dark:text-slate-100 dark:hover:text-nvr-cyan'
          >
            {title}
          </a>
        ) : (
          <span
            className={cn(
              'block text-[12.5px] leading-snug',
              l.record || l.kind === 'page' || l.kind === 'list' || l.queue_id || l.person_id
                ? 'font-medium text-slate-800 dark:text-slate-100'
                : 'text-slate-600 dark:text-slate-300'
            )}
          >
            {title}
          </span>
        )}
        {meta.length > 0 && (
          <p className='mt-0.5 truncate text-[11px] text-slate-500 dark:text-slate-400'>
            {meta.join(' · ')}
          </p>
        )}
      </div>
      <div className='flex items-center justify-end gap-2 pt-px'>
        <span aria-hidden className='hidden h-1 w-8 justify-end sm:flex'>
          {bar > 0 && (
            <span
              className={cn(
                'h-1 rounded-full',
                long ? 'bg-slate-500 dark:bg-slate-400' : 'bg-slate-300 dark:bg-slate-600'
              )}
              style={{ width: `${bar}%` }}
            />
          )}
        </span>
        <span
          className={cn(
            'min-w-[44px] text-right text-[11.5px] tabular-nums',
            long
              ? 'font-semibold text-slate-800 dark:text-slate-100'
              : 'text-slate-500 dark:text-slate-400'
          )}
        >
          {row.seconds != null ? fmtDuration(row.seconds) : row.open ? 'still open' : ''}
        </span>
      </div>
    </li>
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
