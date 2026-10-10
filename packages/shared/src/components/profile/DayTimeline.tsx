import { useQuery } from '@tanstack/react-query'
import { CalendarClock, ChevronLeft, ChevronRight } from 'lucide-react'
import type { MouseEvent, ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { useItemNavigation, useNavigation, useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn } from '../../lib/utils'
import {
  activeSpan,
  binRequests,
  hourTicks,
  isSafeAdminPath,
  localDateKey,
  localDayOffset,
  type MinuteCount,
  packRows,
  pct,
  recordingAt,
  segmentBox,
  shiftDate,
  type TimeView
} from './dayTimelineLayout'
import { fetchJourneyDays, fmtDuration, pageLabel } from './PersonActivity'
import { EmptyLine, SectionCard } from './primitives'

// ─── One day of one person (#1367) ───────────────────────────────────────────
//
// The Activity tab's Day view: recordings, pages, requests per minute,
// transitions and tasks for one date on one horizontal timeline, in the
// viewer's own hours. Every segment opens its own thing. Administrators only
// (GET /journeys/day/:id is requireAdmin), and the API logs each read.

interface DayRecording {
  id: string
  app: string | null
  start: string
  end: string
  live: boolean
}
interface DayPage {
  path: string
  session_id: string
  start: string
  end: string
  duration_seconds: number | null
  /** #1391 — 'admin' or the portal's app label. */
  app?: string
}
interface DayTransition {
  id: number
  at: string
  collection: string
  item: string
  from: string | null
  to: string | null
  label: string | null
}
interface DayTask {
  id: number
  at: string
  kind: 'created' | 'completed'
  title: string
  collection: string | null
  item: string | null
}
interface PersonDay {
  date: string
  tz_offset: number
  day_start: string
  day_end: string
  /** null = that lane's source is unavailable on this instance. */
  recordings: DayRecording[] | null
  pages: DayPage[] | null
  requests: MinuteCount[] | null
  transitions: DayTransition[] | null
  tasks: DayTask[] | null
  /** #1388 — the day's worst frustration score (0–100); null/absent when none was scored. */
  frustration?: {
    score: number
    sessions: number
    worst: {
      top_route: string | null
      recording_id: string | null
      session_start: string | null
      components: { counts?: Record<string, number> }
    }
  } | null
  capped: string[]
}

const ROW_H = 10
const ROW_GAP = 3
const LANE_PAD = 6
const REQUEST_LANE_H = 34

const fmtTime = (t: number | string) =>
  new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
const fmtHour = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric' })
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`
function fmtZone(tzOffset: number): string {
  const east = -tzOffset
  const a = Math.abs(east)
  return `UTC${east < 0 ? '−' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`
}

const FRUSTRATION_LABELS: Record<string, string> = {
  rage_clicks: 'rage click',
  dead_clicks: 'dead click',
  client_errors: 'client error',
  loops: 'back-and-forth',
  slow_actions: 'slow call',
  abandoned_forms: 'abandoned form'
}

/** #1388 — the day's frustration score; links to the worst session's replay when one exists. */
function FrustrationChip({
  f,
  href,
  onGo
}: {
  f: NonNullable<PersonDay['frustration']>
  href: string | null
  onGo: (href: string) => void
}) {
  const why = Object.entries(f.worst.components.counts ?? {})
    .filter(([, n]) => n > 0)
    .map(([k, n]) => plural(n, FRUSTRATION_LABELS[k] ?? k))
    .join(', ')
  const title = `Frustration ${f.score}/100 — worst of ${plural(f.sessions, 'session')}${
    f.worst.top_route ? ` (mostly ${f.worst.top_route})` : ''
  }${why ? `: ${why}` : ''}${href ? '. Click to watch it.' : ''}`
  const cls = cn(
    'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] tabular-nums',
    f.score >= 50
      ? 'border-rose-300 text-rose-700 dark:border-rose-500/50 dark:text-rose-300'
      : 'border-slate-200 text-slate-600 dark:border-border dark:text-slate-300'
  )
  return href ? (
    <a
      href={href}
      title={title}
      data-day-frustration={f.score}
      className={cls}
      onClick={routed(() => onGo(href))}
    >
      Frustration {f.score}
    </a>
  ) : (
    <span title={title} data-day-frustration={f.score} className={cls}>
      Frustration {f.score}
    </span>
  )
}

/** Keeps a plain click inside the host router; ⌘/Ctrl-click opens a new tab. */
function routed(go: () => void) {
  return (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return
    e.preventDefault()
    go()
  }
}

export function DayTimelineCard({ userId, initialDate }: { userId: string; initialDate?: string }) {
  const client = useNivaroClient()
  const nav = useNavigation()
  const { urlFor, open } = useItemNavigation()
  const today = localDateKey(new Date())
  const [date, setDate] = useState(initialDate ?? today)
  const [wholeDay, setWholeDay] = useState(false)
  // #1391 — null = pages from every front end.
  const [app, setApp] = useState<string | null>(null)
  const tzOffset = localDayOffset(date)

  // Same key and source as the Pages visited card's chips — one fetch for both.
  const { data: dayData } = useQuery({
    queryKey: ['nvr-journey-days', userId, null],
    queryFn: () => fetchJourneyDays(client, userId, null)
  })
  const days = dayData?.days ?? []
  const apps = dayData?.apps ?? []
  // Each fetch is an audited read, so no refetch on focus: a day is read when
  // it is opened, or when the reader asks again.
  const { data, isLoading, isError } = useQuery<PersonDay>({
    queryKey: ['nvr-person-day', userId, date, tzOffset, app],
    queryFn: () =>
      client
        .request<{ data: PersonDay }>(
          get(`/journeys/day/${userId}`, {
            date,
            tz_offset: tzOffset,
            ...(app ? { app } : {})
          })
        )
        .then((r) => r.data),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false
  })

  const adminHref = (path: string) => (nav.consoleUrl ? nav.consoleUrl(path) : path)
  const replayHref = (id: string, offsetMs?: number) =>
    adminHref(
      `/session-replays?recording=${encodeURIComponent(id)}${
        offsetMs != null ? `&t=${Math.round(offsetMs)}` : ''
      }`
    )

  const layout = useMemo(() => (data ? layoutDay(data, wholeDay) : null), [data, wholeDay])

  const dateControls = (
    <div className='flex items-center gap-1'>
      <button
        type='button'
        aria-label='Previous day'
        onClick={() => setDate((d) => shiftDate(d, -1))}
        className='inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-50 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-muted'
      >
        <ChevronLeft className='h-3.5 w-3.5' />
      </button>
      <input
        type='date'
        aria-label='Day'
        value={date}
        max={today}
        onChange={(e) => e.target.value && setDate(e.target.value)}
        className='h-7 rounded-md border border-slate-200 bg-white px-1.5 text-[11.5px] text-slate-700 dark:border-border dark:bg-card dark:text-slate-200'
      />
      <button
        type='button'
        aria-label='Next day'
        disabled={date >= today}
        onClick={() => setDate((d) => shiftDate(d, 1))}
        className='inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-50 hover:text-slate-800 disabled:opacity-30 dark:text-slate-400 dark:hover:bg-muted'
      >
        <ChevronRight className='h-3.5 w-3.5' />
      </button>
    </div>
  )

  return (
    <SectionCard
      icon={<CalendarClock className='h-4 w-4' />}
      title='One day'
      hint='Recordings, pages, requests, transitions and tasks on one timeline, in your time'
      testId='day-timeline'
      actions={dateControls}
    >
      {(apps.length > 1 || (apps.length === 1 && apps[0] !== 'admin')) && (
        <div className='mb-2 flex flex-wrap items-center gap-1.5' data-day-apps>
          {[null, ...apps].map((a) => (
            <button
              key={a ?? '__all'}
              type='button'
              aria-pressed={app === a}
              data-day-app-filter={a ?? 'all'}
              onClick={() => setApp(a)}
              className={cn(
                'rounded-md border px-2 py-0.5 text-[11px]',
                app === a
                  ? 'border-nvr-cyan bg-accent text-nvr-navy dark:text-nvr-cyan'
                  : 'border-slate-200 text-slate-500 dark:border-border dark:text-slate-400'
              )}
            >
              {a ?? 'All apps'}
            </button>
          ))}
        </div>
      )}
      {days.length > 0 && (
        <div className='mb-3 flex flex-wrap gap-1.5' data-day-chips>
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
      ) : isError || !data || !layout ? (
        <EmptyLine>This day could not be loaded.</EmptyLine>
      ) : layout.empty ? (
        <EmptyLine>Nothing recorded {date === today ? 'today' : `on ${date}`}.</EmptyLine>
      ) : (
        <div data-day-timeline={data.date}>
          <div className='mb-2 flex flex-wrap items-center gap-x-3 gap-y-1'>
            <p className='text-[11.5px] text-slate-500 dark:text-slate-400' data-day-summary>
              {layout.summary.join(' · ')}
            </p>
            {data.frustration && (
              <FrustrationChip
                f={data.frustration}
                href={
                  data.frustration.worst.recording_id
                    ? replayHref(data.frustration.worst.recording_id)
                    : null
                }
                onGo={(href) => nav.navigate(href)}
              />
            )}
            <button
              type='button'
              aria-pressed={wholeDay}
              onClick={() => setWholeDay((w) => !w)}
              className='ml-auto inline-flex h-6 items-center rounded-md border border-slate-200 px-2 text-[11px] text-slate-600 hover:bg-slate-50 dark:border-border dark:text-slate-300 dark:hover:bg-muted'
            >
              {wholeDay ? 'Active hours' : 'Whole day'}
            </button>
          </div>

          <div className='flex'>
            {/* Lane labels */}
            <div className='w-[92px] shrink-0 pr-2' aria-hidden>
              <div className='h-5' />
              {layout.lanes.map((l) => (
                <div
                  key={l.key}
                  className='flex flex-col justify-center border-t border-slate-100 dark:border-border/60'
                  style={{ height: l.height }}
                >
                  <span className='text-[11px] font-medium text-slate-600 dark:text-slate-300'>
                    {l.label}
                  </span>
                  <span className='text-[10px] tabular-nums text-slate-400'>{l.count}</span>
                </div>
              ))}
            </div>

            {/* Track */}
            <div className='relative min-w-0 flex-1'>
              <div className='relative h-5'>
                {layout.ticks.map((t, i) => (
                  <span
                    key={t}
                    className='absolute top-0 whitespace-nowrap text-[10px] tabular-nums text-slate-400'
                    style={{
                      left: `${pct(t, layout.view)}%`,
                      transform:
                        i === 0 && pct(t, layout.view) < 2
                          ? undefined
                          : pct(t, layout.view) > 96
                            ? 'translateX(-100%)'
                            : 'translateX(-50%)'
                    }}
                  >
                    {fmtHour(t)}
                  </span>
                ))}
              </div>
              <div className='pointer-events-none absolute inset-x-0 bottom-0 top-5' aria-hidden>
                {layout.ticks.map((t) => (
                  <span
                    key={t}
                    className='absolute inset-y-0 w-px bg-slate-100 dark:bg-border/60'
                    style={{ left: `${pct(t, layout.view)}%` }}
                  />
                ))}
                {layout.now != null && (
                  <span
                    className='absolute inset-y-0 w-px bg-red-400/70'
                    style={{ left: `${pct(layout.now, layout.view)}%` }}
                    title='Now'
                  />
                )}
              </div>

              {layout.lanes.map((l) => (
                <ul
                  key={l.key}
                  aria-label={`${l.label}: ${l.count}`}
                  data-day-lane={l.key}
                  className='relative border-t border-slate-100 dark:border-border/60'
                  style={{ height: l.height }}
                >
                  {l.key === 'recordings' &&
                    layout.recordings.map(({ r, box, row }) => {
                      const href = replayHref(r.id)
                      const text = `Recording${r.app ? ` · ${r.app}` : ''} · ${fmtTime(r.start)}–${fmtTime(r.end)}${r.live ? ' · live now' : ''}`
                      return (
                        <Seg key={r.id} box={box} row={row}>
                          <SegLink
                            href={href}
                            label={`Watch ${text}`}
                            onGo={() => href && nav.navigate(href)}
                            className={cn(
                              'bg-violet-400/80 hover:bg-violet-500 dark:bg-violet-500/70 dark:hover:bg-violet-400',
                              r.live && 'ring-1 ring-red-400'
                            )}
                          />
                        </Seg>
                      )
                    })}
                  {l.key === 'pages' &&
                    layout.pages.map(({ p, box, row }) => {
                      // A portal page is not an admin route — show it, don't link it.
                      const portal = (p.app ?? 'admin') !== 'admin'
                      const href = !portal && isSafeAdminPath(p.path) ? adminHref(p.path) : null
                      const text = `${portal ? `${p.app} · ` : ''}${pageLabel(p.path)} · ${fmtTime(p.start)}${
                        p.duration_seconds != null ? ` · ${fmtDuration(p.duration_seconds)}` : ''
                      }`
                      return (
                        <Seg key={`${p.session_id}-${p.start}-${p.path}`} box={box} row={row}>
                          <SegLink
                            href={href}
                            label={href ? `Open ${text}` : text}
                            onGo={() => href && nav.navigate(href)}
                            className='bg-nvr-cyan/70 hover:bg-nvr-cyan'
                          />
                        </Seg>
                      )
                    })}
                  {l.key === 'requests' &&
                    layout.requests.map((b) => {
                      const box = segmentBox(b.start, b.end, layout.view, 0.25)
                      if (!box) return null
                      const h = Math.max(
                        2,
                        Math.round((b.count / layout.requestMax) * (REQUEST_LANE_H - 6))
                      )
                      const errH = b.errors ? Math.max(2, Math.round((b.errors / b.count) * h)) : 0
                      // The recording running at the bar's start, else one that
                      // began inside the bar (played from its first moment).
                      const recs = data.recordings ?? []
                      const later = recordingAt(recs, b.end - 1)
                      const covering =
                        recordingAt(recs, b.start) ?? (later && { ...later, offsetMs: 0 })
                      const href = covering
                        ? replayHref(covering.recording.id, covering.offsetMs)
                        : null
                      const text = `${fmtTime(b.start)}${
                        layout.binMinutes > 1 ? `–${fmtTime(b.end)}` : ''
                      } · ${plural(b.count, 'request')}${b.errors ? ` · ${plural(b.errors, 'error')}` : ''}`
                      return (
                        <li
                          key={b.start}
                          className='absolute bottom-0.5 flex flex-col justify-end'
                          style={{ left: `${box.left}%`, width: `${box.width}%`, height: h }}
                        >
                          <SegLink
                            href={href}
                            label={href ? `Watch the recording at ${text}` : text}
                            onGo={() => href && nav.navigate(href)}
                            className={cn(
                              'flex h-full flex-col justify-end overflow-hidden rounded-[1px] bg-slate-300 dark:bg-slate-600',
                              href && 'hover:bg-slate-400 dark:hover:bg-slate-500'
                            )}
                          >
                            {errH > 0 && (
                              <span className='block w-full bg-red-500' style={{ height: errH }} />
                            )}
                          </SegLink>
                        </li>
                      )
                    })}
                  {l.key === 'transitions' &&
                    layout.transitions.map(({ t, x, row }) => {
                      const target = { collection: t.collection, itemId: t.item }
                      const text = `${t.label ?? 'Transition'}${
                        t.from || t.to ? ` (${t.from ?? '—'} → ${t.to ?? '—'})` : ''
                      } · ${t.collection} #${t.item} · ${fmtTime(t.at)}`
                      return (
                        <Tick key={t.id} x={x} row={row}>
                          <SegLink
                            href={urlFor(target)}
                            label={`Open ${text}`}
                            onGo={() => open(target)}
                            className='rounded-full bg-emerald-500 hover:bg-emerald-600 dark:bg-emerald-400'
                          />
                        </Tick>
                      )
                    })}
                  {l.key === 'tasks' &&
                    layout.tasks.map(({ t, x, row }) => {
                      const target =
                        t.collection && t.item ? { collection: t.collection, itemId: t.item } : null
                      const href = target ? urlFor(target) : adminHref('/tasks')
                      const text = `Task ${t.kind} · ${t.title} · ${fmtTime(t.at)}`
                      return (
                        <Tick key={`${t.kind}-${t.id}`} x={x} row={row}>
                          <SegLink
                            href={href}
                            label={`Open ${text}`}
                            onGo={() => (target ? open(target) : href && nav.navigate(href))}
                            className={cn(
                              'rotate-45 rounded-[1px]',
                              t.kind === 'completed'
                                ? 'bg-amber-500 hover:bg-amber-600'
                                : 'border border-amber-500 bg-white hover:bg-amber-100 dark:bg-card'
                            )}
                          />
                        </Tick>
                      )
                    })}
                </ul>
              ))}
            </div>
          </div>

          <p className='mt-2 text-[10.5px] text-slate-400'>
            Times in your zone ({fmtZone(data.tz_offset)}). Opening a day is recorded in the
            activity log.
            {data.capped.length > 0 &&
              ` Some lanes show only their first entries (${data.capped.join(', ')}).`}
          </p>
        </div>
      )}
    </SectionCard>
  )
}

/** A span segment: absolutely placed in its row. */
function Seg({
  box,
  row,
  children
}: {
  box: { left: number; width: number }
  row: number
  children: ReactNode
}) {
  return (
    <li
      className='absolute'
      style={{
        left: `${box.left}%`,
        width: `${box.width}%`,
        top: LANE_PAD / 2 + row * (ROW_H + ROW_GAP),
        height: ROW_H
      }}
    >
      {children}
    </li>
  )
}

/** A point event: a small mark centred on its instant. */
function Tick({ x, row, children }: { x: number; row: number; children: ReactNode }) {
  return (
    <li
      className='absolute -translate-x-1/2'
      style={{
        left: `${x}%`,
        top: LANE_PAD / 2 + row * (ROW_H + ROW_GAP) + 1,
        width: ROW_H - 2,
        height: ROW_H - 2
      }}
    >
      {children}
    </li>
  )
}

/** The clickable body of a segment, or an inert one with the same label. */
function SegLink({
  href,
  label,
  onGo,
  className,
  children
}: {
  href: string | null
  label: string
  onGo: () => void
  className?: string
  children?: ReactNode
}) {
  const cls = cn(
    'block h-full w-full rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
    className
  )
  if (!href) {
    return (
      <span role='img' aria-label={label} title={label} className={cls}>
        {children}
      </span>
    )
  }
  return (
    <a href={href} aria-label={label} title={label} onClick={routed(onGo)} className={cls}>
      {children}
    </a>
  )
}

// ─── Layout ──────────────────────────────────────────────────────────────────

type LaneKey = 'recordings' | 'pages' | 'requests' | 'transitions' | 'tasks'

function layoutDay(d: PersonDay, wholeDay: boolean) {
  const day: TimeView = { start: Date.parse(d.day_start), end: Date.parse(d.day_end) }
  const recs = d.recordings ?? []
  const pages = d.pages ?? []
  const reqs = d.requests ?? []
  const trans = d.transitions ?? []
  const tasks = d.tasks ?? []

  const times: number[] = [
    ...recs.flatMap((r) => [Date.parse(r.start), Date.parse(r.end) - 1]),
    ...pages.flatMap((p) => [Date.parse(p.start), Date.parse(p.end) - 1]),
    ...reqs.map((m) => Date.parse(m.minute)),
    ...trans.map((t) => Date.parse(t.at)),
    ...tasks.map((t) => Date.parse(t.at))
  ]
  const view = wholeDay ? day : activeSpan(times, day)
  const span = view.end - view.start
  const ms = (iso: string) => Date.parse(iso)

  const recPack = packRows(recs.map((r) => ({ start: ms(r.start), end: ms(r.end) })))
  const pagePack = packRows(pages.map((p) => ({ start: ms(p.start), end: ms(p.end) })))
  // Point events stack when their marks (≈1.4% of the track) would touch.
  const pointW = span * 0.014
  const pointRows = <T extends { at: string }>(list: T[]) =>
    packRows(list.map((t) => ({ start: ms(t.at), end: ms(t.at) + pointW })))
  const transPack = pointRows(trans)
  const taskPack = pointRows(tasks)

  const { bins, binMinutes } = binRequests(reqs, view)
  const requestMax = Math.max(1, ...bins.map((b) => b.count))
  const reqTotal = reqs.reduce((n, m) => n + m.count, 0)
  const errTotal = reqs.reduce((n, m) => n + m.errors, 0)

  const rowsH = (rows: number) => LANE_PAD + rows * ROW_H + (rows - 1) * ROW_GAP
  const lanes: Array<{ key: LaneKey; label: string; count: string; height: number }> = []
  if (d.recordings)
    lanes.push({
      key: 'recordings',
      label: 'Recordings',
      count: String(recs.length),
      height: rowsH(recPack.count)
    })
  if (d.pages)
    lanes.push({
      key: 'pages',
      label: 'Pages',
      count: String(pages.length),
      height: rowsH(pagePack.count)
    })
  if (d.requests)
    lanes.push({
      key: 'requests',
      label: 'Requests',
      count: errTotal
        ? `${reqTotal.toLocaleString()} · ${errTotal} err`
        : reqTotal.toLocaleString(),
      height: REQUEST_LANE_H
    })
  if (d.transitions)
    lanes.push({
      key: 'transitions',
      label: 'Transitions',
      count: String(trans.length),
      height: rowsH(transPack.count)
    })
  if (d.tasks)
    lanes.push({
      key: 'tasks',
      label: 'Tasks',
      count: String(tasks.length),
      height: rowsH(taskPack.count)
    })

  const summary = [
    d.recordings && plural(recs.length, 'recording'),
    d.pages && plural(pages.length, 'page'),
    d.requests &&
      `${plural(reqTotal, 'request')}${errTotal ? ` (${plural(errTotal, 'error')})` : ''}`,
    d.transitions && plural(trans.length, 'transition'),
    d.tasks && plural(tasks.length, 'task')
  ].filter((s): s is string => !!s)

  const now = Date.now()
  return {
    view,
    ticks: hourTicks(view, day.start),
    now: now >= view.start && now < view.end ? now : null,
    lanes,
    summary,
    empty: times.length === 0,
    recordings: recs.flatMap((r, i) => {
      const box = segmentBox(ms(r.start), ms(r.end), view)
      return box ? [{ r, box, row: recPack.rows[i] }] : []
    }),
    pages: pages.flatMap((p, i) => {
      const box = segmentBox(ms(p.start), ms(p.end), view)
      return box ? [{ p, box, row: pagePack.rows[i] }] : []
    }),
    requests: bins,
    binMinutes,
    requestMax,
    transitions: trans.map((t, i) => ({ t, x: pct(ms(t.at), view), row: transPack.rows[i] })),
    tasks: tasks.map((t, i) => ({ t, x: pct(ms(t.at), view), row: taskPack.rows[i] }))
  }
}
