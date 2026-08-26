import { useQuery } from '@tanstack/react-query'
import { CalendarClock, RotateCw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

// ─── Cron overlap timeline (#654) ────────────────────────────────────────────
// One lane per registered cron across the chosen window: faint ticks are the
// SCHEDULE (croner-expanded occurrences), solid bars are what ACTUALLY ran
// (nivaro_job_runs, colored by status), and red bands mark wall-clock spans
// where two or more HEAVY jobs were running at once — the pile-ups the heavy
// serialization chain exists to prevent.

interface CronRun {
  status: string
  started_at: string
  finished_at: string | null
  duration_ms: number | null
}

interface CronJob {
  id: string
  expression: string
  extension_id: string | null
  heavy: boolean
  idempotent: string
  paused: boolean
  next_run: string | null
  occurrences: string[]
  occurrences_truncated: boolean
  runs: CronRun[]
}

interface TimelinePayload {
  window_hours: number
  from: string
  to: string
  jobs: CronJob[]
}

interface OverlapSpan {
  start: number
  end: number
  jobs: string[]
}

const WINDOW_CHOICES = [6, 12, 24, 48] as const

const STATUS_COLOR: Record<string, string> = {
  completed: 'bg-emerald-500',
  error: 'bg-red-500',
  running: 'bg-sky-500',
  interrupted: 'bg-slate-400'
}

function runEnd(run: CronRun, now: number): number {
  const start = new Date(run.started_at).getTime()
  if (run.finished_at) return new Date(run.finished_at).getTime()
  if (run.duration_ms != null) return start + run.duration_ms
  // still running (or bookkeeping lost the finish) — draw to "now"
  return run.status === 'running' ? now : start + 5_000
}

/** Pairwise intersections between heavy jobs' actual-run intervals. */
function heavyOverlaps(jobs: CronJob[], now: number): OverlapSpan[] {
  const intervals: { job: string; start: number; end: number }[] = []
  for (const job of jobs) {
    if (!job.heavy) continue
    for (const run of job.runs) {
      const start = new Date(run.started_at).getTime()
      intervals.push({ job: job.id, start, end: Math.max(start, runEnd(run, now)) })
    }
  }
  intervals.sort((a, b) => a.start - b.start)
  const spans: OverlapSpan[] = []
  for (let i = 0; i < intervals.length; i++) {
    for (let j = i + 1; j < intervals.length; j++) {
      const a = intervals[i]
      const b = intervals[j]
      if (b.start >= a.end) break
      if (a.job === b.job) continue
      spans.push({ start: b.start, end: Math.min(a.end, b.end), jobs: [a.job, b.job] })
      if (spans.length >= 100) return spans
    }
  }
  return spans
}

function fmtTime(t: number, windowHours: number): string {
  const d = new Date(t)
  return windowHours > 24
    ? d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric' })
    : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.round(ms / 60_000)}m`
}

export function CronTimelinePage() {
  const [hours, setHours] = useState<number>(24)

  const { data, isLoading, isFetching, refetch } = useQuery<TimelinePayload>({
    queryKey: ['cron-timeline', hours],
    queryFn: () =>
      api
        .get<{ data: TimelinePayload }>('/cron-timeline', { params: { hours } })
        .then((r) => r.data.data),
    refetchInterval: 60_000
  })

  const now = Date.now()
  const from = data ? new Date(data.from).getTime() : now - hours * 3_600_000
  const to = data ? new Date(data.to).getTime() : now
  const span = Math.max(1, to - from)
  const pct = (t: number) => Math.min(100, Math.max(0, ((t - from) / span) * 100))

  const overlaps = useMemo(() => (data ? heavyOverlaps(data.jobs, now) : []), [data, now])
  const overlappedJobs = useMemo(() => new Set(overlaps.flatMap((o) => o.jobs)), [overlaps])

  const jobs = useMemo(() => {
    if (!data) return []
    // Busiest lanes first: jobs with runs in the window, then heavy, then name.
    return [...data.jobs].sort((a, b) => {
      const aHot = a.runs.length > 0 ? 1 : 0
      const bHot = b.runs.length > 0 ? 1 : 0
      if (aHot !== bHot) return bHot - aHot
      if (a.heavy !== b.heavy) return a.heavy ? -1 : 1
      return a.id.localeCompare(b.id)
    })
  }, [data])

  const gridlines = useMemo(() => {
    const lines: number[] = []
    for (let i = 1; i < 6; i++) lines.push(from + (span * i) / 6)
    return lines
  }, [from, span])

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-8 py-5 dark:border-border dark:bg-background'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2.5'>
            <CalendarClock className='h-5 w-5 text-muted-foreground' />
            <h1 className='text-[15px] font-semibold text-slate-900 dark:text-slate-100'>
              Cron Timeline
            </h1>
          </div>
          <div className='flex items-center gap-2'>
            <div className='flex overflow-hidden rounded-lg border border-slate-200 dark:border-border'>
              {WINDOW_CHOICES.map((h) => (
                <button
                  key={h}
                  type='button'
                  onClick={() => setHours(h)}
                  className={cn(
                    'px-2.5 py-1 text-[12px] tabular-nums',
                    hours === h
                      ? 'bg-[#00ceff]/10 font-semibold text-slate-900 dark:text-slate-100'
                      : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-900'
                  )}
                >
                  {h}h
                </button>
              ))}
            </div>
            <Button
              variant='outline'
              size='sm'
              className='h-7 gap-1.5 text-[12px]'
              onClick={() => refetch()}
            >
              <RotateCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
              Refresh
            </Button>
          </div>
        </div>
        <p className='mt-1 max-w-[80ch] text-[12px] text-slate-500'>
          Faint ticks mark the schedule, solid bars what actually ran. Red bands are wall-clock
          spans where two heavy jobs ran at once.
        </p>
      </header>

      <div className='flex-1 overflow-auto bg-slate-50 p-6 dark:bg-background'>
        {isLoading || !data ? (
          <div className='space-y-2'>
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className='h-9 animate-pulse rounded bg-muted' />
            ))}
          </div>
        ) : (
          <div className='min-w-[720px] rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
            {/* Time axis */}
            <div className='flex border-b border-slate-200 dark:border-border'>
              <div className='w-[240px] shrink-0 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400'>
                Job · {data.jobs.length} scheduled
              </div>
              <div className='relative flex-1'>
                {gridlines.map((t) => (
                  <span
                    key={t}
                    className='absolute top-1/2 -translate-x-1/2 -translate-y-1/2 text-[10px] tabular-nums text-slate-400'
                    style={{ left: `${pct(t)}%` }}
                  >
                    {fmtTime(t, data.window_hours)}
                  </span>
                ))}
              </div>
            </div>

            {/* Lanes */}
            <div className='relative'>
              {/* Gridlines across all lanes */}
              <div className='pointer-events-none absolute inset-y-0 left-[240px] right-0'>
                {gridlines.map((t) => (
                  <div
                    key={t}
                    className='absolute inset-y-0 w-px bg-slate-100 dark:bg-border/50'
                    style={{ left: `${pct(t)}%` }}
                  />
                ))}
                {/* Heavy-overlap bands */}
                {overlaps.map((o) => (
                  <div
                    key={`${o.start}-${o.end}-${o.jobs.join('|')}`}
                    className='absolute inset-y-0 bg-red-500/10'
                    style={{
                      left: `${pct(o.start)}%`,
                      width: `${Math.max(0.15, pct(o.end) - pct(o.start))}%`
                    }}
                    title={`Heavy overlap: ${o.jobs.join(' × ')}`}
                  />
                ))}
              </div>

              {jobs.map((job) => (
                <div
                  key={job.id}
                  className='flex border-b border-slate-100 last:border-0 dark:border-border/50'
                >
                  <div className='flex w-[240px] shrink-0 items-center gap-1.5 overflow-hidden px-3 py-2'>
                    <code
                      className='truncate font-mono text-[11.5px] text-slate-700 dark:text-slate-200'
                      title={`${job.id} — ${job.expression}${job.next_run ? ` · next ${new Date(job.next_run).toLocaleString()}` : ''}`}
                    >
                      {job.id}
                    </code>
                    {job.heavy && (
                      <Badge
                        className={cn(
                          'h-4 shrink-0 px-1 text-[9px]',
                          overlappedJobs.has(job.id)
                            ? 'bg-red-500/15 text-red-600 dark:text-red-300'
                            : 'bg-amber-500/15 text-amber-600 dark:text-amber-300'
                        )}
                      >
                        heavy
                      </Badge>
                    )}
                    {job.paused && (
                      <Badge variant='outline' className='h-4 shrink-0 px-1 text-[9px] text-slate-400'>
                        paused
                      </Badge>
                    )}
                  </div>

                  <div className='relative min-h-[34px] flex-1'>
                    {/* Scheduled occurrence ticks (top half) */}
                    {job.occurrences.map((occ) => {
                      const t = new Date(occ).getTime()
                      return (
                        <div
                          key={occ}
                          className='absolute top-[6px] h-[8px] w-px bg-slate-300 dark:bg-slate-600'
                          style={{ left: `${pct(t)}%` }}
                        />
                      )
                    })}
                    {/* Actual run bars (bottom half) */}
                    {job.runs.map((run) => {
                      const start = new Date(run.started_at).getTime()
                      const end = Math.max(start, runEnd(run, now))
                      const left = pct(start)
                      const width = Math.max(0.2, pct(end) - left)
                      return (
                        <div
                          key={`${run.started_at}-${run.status}`}
                          className={cn(
                            'absolute bottom-[6px] h-[9px] rounded-sm',
                            STATUS_COLOR[run.status] ?? 'bg-slate-400',
                            overlappedJobs.has(job.id) && job.heavy && 'ring-1 ring-red-400'
                          )}
                          style={{ left: `${left}%`, width: `${width}%` }}
                          title={`${job.id} · ${run.status} · ${new Date(run.started_at).toLocaleString()} · ${fmtDuration(run.duration_ms)}`}
                        />
                      )
                    })}
                    {job.occurrences_truncated && (
                      <span className='absolute right-1 top-[2px] text-[9px] text-slate-300 dark:text-slate-600'>
                        first 200 ticks
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Legend + overlap summary */}
        {data && (
          <div className='mt-4 space-y-3'>
            <div className='flex flex-wrap items-center gap-4 text-[11px] text-slate-500'>
              <span className='flex items-center gap-1.5'>
                <span className='inline-block h-[8px] w-px bg-slate-300 dark:bg-slate-600' />
                scheduled tick
              </span>
              {Object.entries(STATUS_COLOR).map(([status, color]) => (
                <span key={status} className='flex items-center gap-1.5'>
                  <span className={cn('inline-block h-2 w-4 rounded-sm', color)} />
                  {status}
                </span>
              ))}
              <span className='flex items-center gap-1.5'>
                <span className='inline-block h-3 w-4 bg-red-500/10 ring-1 ring-red-200 dark:ring-red-900' />
                heavy overlap
              </span>
            </div>

            {overlaps.length > 0 && (
              <div className='rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900/50 dark:bg-red-950/30'>
                <p className='mb-1.5 text-[12px] font-semibold text-red-600 dark:text-red-300'>
                  {overlaps.length} heavy-job overlap{overlaps.length === 1 ? '' : 's'} in this
                  window
                </p>
                <ul className='space-y-0.5'>
                  {overlaps.slice(0, 8).map((o) => (
                    <li
                      key={`${o.start}-${o.jobs.join('|')}`}
                      className='text-[11.5px] text-red-600/80 dark:text-red-300/80'
                    >
                      <code className='font-mono'>{o.jobs.join(' × ')}</code> ·{' '}
                      {new Date(o.start).toLocaleTimeString()} for{' '}
                      {fmtDuration(Math.round(o.end - o.start))}
                    </li>
                  ))}
                  {overlaps.length > 8 && (
                    <li className='text-[11.5px] text-red-600/60 dark:text-red-300/60'>
                      +{overlaps.length - 8} more
                    </li>
                  )}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
