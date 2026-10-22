import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect } from 'react'
import { Link } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { adminRealtime } from '@/lib/socket'
import { cn, formatDateTime } from '@/lib/utils'
import { type ChaosRun, type ChaosRunEvent, chaosKeys, describeTarget, fetchRun } from './api'
import { RunCockpit } from './RunCockpit'
import { RunChip } from './RunsTab'

/**
 * One run (#2843): the cockpit while it runs (#2845), otherwise a summary — verdict, what was
 * armed on what, how it ended, the timeline. The full report page is #2849.
 */
export function RunDetail({ id }: { id: string }) {
  const qc = useQueryClient()
  const { data, isLoading, isError } = useQuery<{ run: ChaosRun; events: ChaosRunEvent[] }>({
    queryKey: chaosKeys.run(id),
    queryFn: () => fetchRun(id),
    refetchInterval: (q) => (q.state.data?.run.status === 'running' ? 5_000 : false)
  })
  // Live: events and run changes land straight in the cache; the 5 s poll is the net under it.
  useEffect(() => {
    const key = chaosKeys.run(id)
    const offEvent = adminRealtime.on(
      'chaos:event',
      (p: { run_id?: string; event?: ChaosRunEvent }) => {
        if (p?.run_id !== id || !p.event) return
        qc.setQueryData<{ run: ChaosRun; events: ChaosRunEvent[] }>(key, (prev) =>
          !prev || prev.events.some((e) => e.id === p.event!.id)
            ? prev
            : { ...prev, events: [...prev.events, p.event!] }
        )
      }
    )
    const offRun = adminRealtime.on('chaos:run', (p: { run?: ChaosRun }) => {
      if (p?.run?.id !== id) return
      qc.setQueryData<{ run: ChaosRun; events: ChaosRunEvent[] }>(key, (prev) =>
        prev ? { ...prev, run: p.run! } : prev
      )
    })
    return () => {
      offEvent()
      offRun()
    }
  }, [id, qc])
  if (isLoading)
    return (
      <div className='space-y-4 p-6'>
        <Skeleton className='h-5 w-64' />
        <Skeleton className='h-24 w-full' />
        <Skeleton className='h-40 w-full' />
      </div>
    )
  if (isError || !data)
    return (
      <p className='p-6 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
        This run could not be read.
      </p>
    )
  const { run, events } = data
  if (run.status === 'running') return <RunCockpit run={run} events={events} />
  return <RunSummary run={run} events={events} />
}

function RunSummary({ run, events }: { run: ChaosRun; events: ChaosRunEvent[] }) {
  const seconds =
    run.started_at && run.ended_at
      ? Math.round((new Date(run.ended_at).getTime() - new Date(run.started_at).getTime()) / 1000)
      : null
  const detail = run.verdict_detail ?? {}
  return (
    <div className='space-y-5 p-4 sm:p-6'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='min-w-0'>
          <div className='flex flex-wrap items-center gap-2'>
            <h2 className='text-[15px] font-semibold text-slate-900 dark:text-foreground'>
              {run.label}
            </h2>
            <RunChip run={run} />
            <span className='rounded bg-slate-100 px-1.5 py-0.5 text-[10.5px] font-medium capitalize text-slate-600 dark:bg-muted dark:text-muted-foreground'>
              {run.kind}
            </span>
          </div>
          <p className='mt-1 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
            {run.started_at ? formatDateTime(run.started_at) : formatDateTime(run.created_at)}
            {typeof run.meta.started_by_name === 'string' ? ` · ${run.meta.started_by_name}` : ''}
            {typeof run.meta.note === 'string' && run.meta.note ? ` · ${run.meta.note}` : ''}
          </p>
        </div>
        <div className='flex items-center gap-3'>
          <span className='font-mono text-[11px] text-slate-400 dark:text-muted-foreground/70'>
            {run.id}
          </span>
          {/* #2849 — the full report: charts, timings, errors people saw, postmortem export */}
          <Link
            to={`/chaos/runs/${run.id}`}
            className='inline-flex h-7 items-center rounded-md border border-slate-200 bg-white px-2.5 text-[12px] font-medium text-slate-700 transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-muted'
          >
            Full report
          </Link>
        </div>
      </div>

      <VerdictLine run={run} />

      <div className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-3 lg:grid-cols-6 dark:border-border dark:bg-border'>
        <Cell
          label='Fault'
          value={<span className='font-mono text-[11.5px]'>{run.fault_key ?? '—'}</span>}
        />
        <Cell label='Target' value={describeTarget(run.target)} />
        <Cell
          label='Strength'
          value={
            Object.keys(run.params).length
              ? Object.entries(run.params)
                  .map(([k, v]) => `${k} ${String(v)}`)
                  .join(', ')
              : '—'
          }
        />
        <Cell label='Ran for' value={seconds != null ? `${seconds}s` : '—'} />
        <Cell label='Ended' value={run.ended_at ? formatDateTime(run.ended_at) : '—'} />
        <Cell
          label='Replica'
          value={
            <span className='font-mono text-[11px]'>
              {typeof run.meta.node === 'string' ? run.meta.node : '—'}
            </span>
          }
        />
      </div>

      {run.hypothesis.length > 0 && (
        <section>
          <h3 className='mb-2 text-[12.5px] font-semibold text-slate-900 dark:text-foreground'>
            What should have stayed true
          </h3>
          <ul className='divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-border/60 dark:border-border dark:bg-card'>
            {run.hypothesis.map((h, i) => {
              const breach = (detail.breaches as Array<{ sampler: string }> | undefined)?.find(
                (b) => b.sampler === h.sampler
              )
              return (
                <li
                  key={`${h.sampler}-${i}`}
                  className='flex items-center justify-between gap-3 px-3 py-2 text-[12.5px]'
                >
                  <span className='font-mono text-[11.5px] text-slate-700 dark:text-foreground'>
                    {h.sampler} {h.op} {h.limit}
                    {h.tolerance ? ` ± ${h.tolerance}` : ''}
                  </span>
                  <span
                    className={cn(
                      'text-[11.5px] font-medium',
                      breach
                        ? 'text-red-700 dark:text-red-300'
                        : 'text-emerald-700 dark:text-emerald-300'
                    )}
                  >
                    {breach ? 'crossed' : 'held'}
                  </span>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      <Timeline events={events} />
    </div>
  )
}

function VerdictLine({ run }: { run: ChaosRun }) {
  const d = run.verdict_detail ?? {}
  const reason = typeof d.reason === 'string' ? d.reason : null
  const text =
    run.status === 'refused'
      ? 'Pre-flight refused this run before anything was armed.'
      : run.verdict === 'held'
        ? 'Every limit held for the whole window.'
        : run.verdict === 'broke'
          ? 'A limit was crossed while the fault ran; it was not stopped early.'
          : run.verdict === 'aborted'
            ? 'A limit was crossed past its tolerance and the fault was stopped by itself.'
            : 'No verdict was recorded.'
  const tone =
    run.verdict === 'held'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200'
      : run.verdict === 'broke' || run.status === 'refused'
        ? 'border-red-200 bg-red-50 text-red-900 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200'
        : run.verdict === 'aborted'
          ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200'
          : 'border-slate-200 bg-white text-slate-700 dark:border-border dark:bg-card dark:text-foreground'
  return (
    <p className={cn('rounded-lg border px-3 py-2.5 text-[12.5px]', tone)}>
      {text}
      {reason ? ` ${reason}` : ''}
    </p>
  )
}

function Cell({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className='min-w-0 bg-white px-3 py-2 dark:bg-card'>
      <div className='text-[11px] font-medium text-slate-500 dark:text-muted-foreground'>
        {label}
      </div>
      <div className='mt-0.5 truncate text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
        {value}
      </div>
    </div>
  )
}

const EVENT_TONE: Record<ChaosRunEvent['kind'], string> = {
  armed: 'text-red-700 dark:text-red-300',
  disarmed: 'text-slate-700 dark:text-foreground',
  sample: 'text-slate-500 dark:text-muted-foreground',
  alert: 'text-amber-700 dark:text-amber-300',
  readiness: 'text-amber-700 dark:text-amber-300',
  note: 'text-slate-700 dark:text-foreground',
  abort: 'text-red-700 dark:text-red-300',
  stop: 'text-slate-700 dark:text-foreground',
  step: 'text-slate-700 dark:text-foreground'
}

/** One line per event: what and when. Samples that crossed nothing are folded away. */
export function Timeline({
  events,
  compact = false
}: {
  events: ChaosRunEvent[]
  compact?: boolean
}) {
  const shown = events.filter((e) => e.kind !== 'sample' || e.data.breach)
  const hidden = events.length - shown.length
  return (
    <section>
      <h3 className='mb-2 flex items-baseline gap-2 text-[12.5px] font-semibold text-slate-900 dark:text-foreground'>
        Timeline
        {hidden > 0 && (
          <span className='text-[11px] font-normal text-slate-500 dark:text-muted-foreground'>
            {hidden} quiet sample{hidden === 1 ? '' : 's'} folded
          </span>
        )}
      </h3>
      {shown.length === 0 ? (
        <p className='rounded-lg border border-slate-200 bg-white px-3 py-4 text-[12.5px] text-slate-500 dark:border-border dark:bg-card dark:text-muted-foreground'>
          Nothing recorded yet.
        </p>
      ) : (
        <ol
          className={cn(
            'divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-border/60 dark:border-border dark:bg-card',
            compact && 'max-h-72 overflow-y-auto'
          )}
        >
          {shown.map((e) => (
            <li key={e.id} className='flex items-start gap-3 px-3 py-1.5 text-[12px]'>
              <time className='w-[72px] shrink-0 font-mono text-[11px] tabular-nums text-slate-400 dark:text-muted-foreground/70'>
                {new Date(e.at).toLocaleTimeString([], {
                  hour: 'numeric',
                  minute: '2-digit',
                  second: '2-digit'
                })}
              </time>
              <span className={cn('w-16 shrink-0 font-medium', EVENT_TONE[e.kind])}>{e.kind}</span>
              <span
                className='min-w-0 flex-1 truncate text-slate-700 dark:text-foreground'
                title={eventText(e)}
              >
                {eventText(e)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

export function eventText(e: ChaosRunEvent): string {
  const d = e.data
  switch (e.kind) {
    case 'armed':
      return `${String(d.fault_key ?? '')} on ${String(d.target ?? 'everything')} for ${String(d.seconds ?? '?')}s`
    case 'sample':
      return d.breach
        ? `${String(d.sampler)} = ${String(d.value)} crossed ${String(d.op)} ${String(d.limit)}`
        : 'sample'
    case 'abort':
      return `aborted: ${String(d.reason ?? '')}`
    case 'stop':
      return `${String(d.reason ?? 'stopped')} · verdict ${String(d.verdict ?? '')}`
    case 'disarmed':
      return `${String(d.reason ?? 'window ended')} · verdict ${String(d.verdict ?? '')}`
    case 'alert':
    case 'readiness':
      return String(d.label ?? d.title ?? d.text ?? JSON.stringify(d))
    case 'note':
      return String(d.text ?? d.refusal ?? d.apply_failed ?? JSON.stringify(d))
    default:
      return typeof d.text === 'string' ? d.text : JSON.stringify(d)
  }
}
