import { ConfirmButton, ErrorNotice, toastError, WhenText } from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, ExternalLink, Play } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn, formatDateTime, formatNumber } from '@/lib/utils'
import type { TodayCtx } from './TodaySheet'

/**
 * "Failed jobs, 24 h" → the failed runs the figure counts (GET /job-runs?status=error over the
 * figure's own 24 hours), then one run: what it said, its log lines, and Run now for a
 * scheduled job (the Jobs page's own action, with the same warning that a run repeats its
 * effects).
 */

export interface JobRunRow {
  id: number
  kind: string
  job_id: string
  label: string | null
  status: string
  started_at: string
  finished_at: string | null
  duration_ms: number | null
  outcome: string | null
  error: string | null
  triggered_by_name: string | null
  sentence?: string
}

function dur(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.round(ms / 60_000)} min`
}

function jobsWindow(ctx: TodayCtx) {
  const to = ctx.stats.computed_at
  return { since: new Date(new Date(to).getTime() - 86_400_000).toISOString(), until: to }
}

export function useFailedRuns(ctx: TodayCtx) {
  const w = jobsWindow(ctx)
  return useQuery({
    queryKey: ['overview', 'today', 'failed-runs', w],
    queryFn: () =>
      api
        .get<{ data: JobRunRow[]; total: number }>('/job-runs', {
          params: { status: 'error', since: w.since, until: w.until, limit: 200 }
        })
        .then((r) => r.data),
    staleTime: 30_000
  })
}

export function JobsRoot({ ctx }: { ctx: TodayCtx }) {
  const q = useFailedRuns(ctx)
  const navigate = useNavigate()
  if (q.isLoading)
    return (
      <div className='space-y-2 p-4' aria-busy>
        {Array.from({ length: 5 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: skeleton
          <div key={i} className='h-14 animate-pulse rounded-lg bg-white dark:bg-card' />
        ))}
      </div>
    )
  if (q.error || !q.data)
    return (
      <div className='p-4'>
        <ErrorNotice error={q.error} what='failed job runs' onRetry={() => void q.refetch()} />
      </div>
    )
  const rows = q.data.data
  // Failures per job, so a job failing every run reads as one problem.
  const byJob = new Map<string, number>()
  for (const r of rows) byJob.set(r.job_id, (byJob.get(r.job_id) ?? 0) + 1)
  return (
    <div className='flex flex-col gap-3 p-4'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <p className='text-[13px] text-slate-600 dark:text-slate-300'>
          <span className='font-semibold tabular-nums text-slate-900 dark:text-slate-50'>
            {formatNumber(q.data.total)}
          </span>{' '}
          {q.data.total === 1 ? 'run' : 'runs'} failed in the 24 hours before{' '}
          {new Date(ctx.stats.computed_at).toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit'
          })}
          {byJob.size > 0 && ` · ${formatNumber(byJob.size)} ${byJob.size === 1 ? 'job' : 'jobs'}`}
        </p>
        <button
          type='button'
          onClick={() => navigate('/jobs')}
          className='inline-flex items-center gap-1 text-[12px] font-medium text-nvr-cyan hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60'
        >
          Open Jobs <ExternalLink className='h-3 w-3' aria-hidden />
        </button>
      </div>
      {rows.length === 0 ? (
        <p className='rounded-lg border border-slate-200 bg-white px-4 py-10 text-center text-[12.5px] text-slate-500 dark:border-border dark:bg-card'>
          Nothing failed in these 24 hours.
        </p>
      ) : (
        <ul className='divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-border dark:border-border dark:bg-card'>
          {rows.map((r) => (
            <li key={r.id}>
              <button
                type='button'
                onClick={() => ctx.go({ ...ctx.drill, run: r.id })}
                className='group flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none dark:hover:bg-white/[0.03]'
                data-today-run={r.id}
              >
                <span
                  className='mt-1.5 h-2 w-2 shrink-0 rounded-full bg-rose-500 dark:bg-rose-400'
                  aria-hidden
                />
                <span className='min-w-0 flex-1'>
                  <span className='flex items-baseline gap-2'>
                    <span className='truncate text-[13px] font-medium text-slate-900 dark:text-slate-50'>
                      {r.label?.trim() || r.job_id}
                    </span>
                    {(byJob.get(r.job_id) ?? 0) > 1 && (
                      <span className='shrink-0 text-[11px] text-slate-500'>
                        failed {byJob.get(r.job_id)}× today
                      </span>
                    )}
                  </span>
                  <span className='line-clamp-2 text-[12px] text-rose-700 dark:text-rose-300'>
                    {(r.error ?? r.sentence ?? 'Failed').split('\n')[0]}
                  </span>
                </span>
                <span className='shrink-0 text-right text-[11.5px] text-slate-500 dark:text-slate-400'>
                  <WhenText at={r.started_at} />
                  <span className='block tabular-nums'>{dur(r.duration_ms)}</span>
                </span>
                <ChevronRight
                  className='mt-1 h-4 w-4 shrink-0 text-slate-300 group-hover:text-slate-500'
                  aria-hidden
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function RunLevel({ ctx }: { ctx: TodayCtx }) {
  const id = ctx.drill.run as number
  const navigate = useNavigate()
  const list = useQuery({
    queryKey: ['overview', 'today', 'run', id],
    queryFn: () =>
      api.get<{ data: JobRunRow[] }>('/job-runs', { params: { id, limit: 1 } }).then((r) => r.data),
    staleTime: 30_000
  })
  const fromList = list.data?.data.find((r) => r.id === id)
  const log = useQuery({
    queryKey: ['job-run-log', id],
    queryFn: () =>
      api
        .get<{
          data: {
            run: { id: number; status: string; outcome: string | null; error: string | null }
            lines: Array<{ seq: number; at?: string; level?: string; line?: string }>
          }
        }>(`/job-runs/${id}/log`)
        .then((r) => r.data.data),
    staleTime: 30_000,
    retry: false
  })
  const [running, setRunning] = useState(false)
  const run = fromList
  const runNow = async () => {
    if (!run) return
    setRunning(true)
    try {
      const r = await api.post(`/cron/${encodeURIComponent(run.job_id)}/run`)
      toast.success(`${run.label?.trim() || run.job_id} ran in ${dur(r.data?.data?.duration_ms)}`)
      void list.refetch()
    } catch (err) {
      toastError(err, 'The job did not run')
    } finally {
      setRunning(false)
    }
  }
  if (list.isLoading || log.isLoading)
    return <div className='m-4 h-48 animate-pulse rounded-lg bg-white dark:bg-card' aria-busy />
  if (!run && !log.data)
    return (
      <div className='p-4'>
        <ErrorNotice error={log.error} what='this run' onRetry={() => void log.refetch()} />
      </div>
    )
  const error = run?.error ?? log.data?.run.error ?? null
  return (
    <div className='flex flex-col gap-3 p-4'>
      <section className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
        <div className='flex flex-wrap items-start justify-between gap-3'>
          <div className='min-w-0'>
            <h3 className='text-[15px] font-semibold text-slate-900 dark:text-slate-50'>
              {run?.label?.trim() || run?.job_id || `Run #${id}`}
            </h3>
            <p className='text-[12px] text-slate-500 dark:text-slate-400'>
              {run ? (
                <>
                  {run.kind} · {run.job_id} · started {formatDateTime(run.started_at)} · took{' '}
                  {dur(run.duration_ms)}
                  {run.triggered_by_name ? ` · started by ${run.triggered_by_name}` : ''}
                </>
              ) : (
                `Run #${id}`
              )}
            </p>
          </div>
          <div className='flex items-center gap-2'>
            {run?.kind === 'cron' && (
              <ConfirmButton
                onConfirm={() => void runNow()}
                disabled={running}
                title='Run this job now — it repeats its effects (mail, writes)'
                confirmLabel='Run it again?'
                className='inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 px-3 text-[12px] font-medium hover:bg-slate-50 dark:border-border dark:hover:bg-white/[0.04]'
                armedClassName='border-amber-400 bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200'
              >
                <Play className='h-3.5 w-3.5' aria-hidden />
                {running ? 'Running…' : 'Run now'}
              </ConfirmButton>
            )}
            <button
              type='button'
              onClick={() => navigate('/jobs')}
              className='inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-nvr-cyan hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60'
            >
              Open in Jobs <ExternalLink className='h-3 w-3' aria-hidden />
            </button>
          </div>
        </div>
        {error && (
          <div className='mt-3 rounded-md bg-rose-50 px-3 py-2 dark:bg-rose-500/10'>
            <p className='text-[11px] font-medium text-rose-700 dark:text-rose-300'>What it said</p>
            <p className='mt-0.5 whitespace-pre-wrap break-words font-mono text-[11.5px] text-rose-900 dark:text-rose-100'>
              {error}
            </p>
          </div>
        )}
        {run?.outcome && (
          <p className='mt-3 text-[12.5px] text-slate-700 dark:text-slate-200'>
            <span className='text-slate-500'>Outcome: </span>
            {run.outcome}
          </p>
        )}
      </section>
      <section className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
        <h3 className='border-b border-slate-100 px-4 py-2 text-[12px] font-semibold text-slate-700 dark:border-border dark:text-slate-200'>
          Log
        </h3>
        {log.error ? (
          <div className='p-4'>
            <ErrorNotice
              error={log.error}
              what='the run’s log'
              onRetry={() => void log.refetch()}
            />
          </div>
        ) : (log.data?.lines.length ?? 0) === 0 ? (
          <p className='px-4 py-6 text-center text-[12px] text-slate-500'>
            This run kept no log lines.
          </p>
        ) : (
          <ol className='max-h-[50vh] overflow-auto py-1 font-mono text-[11.5px]'>
            {log.data?.lines.map((l) => (
              <li
                key={l.seq}
                className={cn(
                  'flex gap-3 px-4 py-0.5',
                  l.level === 'error'
                    ? 'text-rose-700 dark:text-rose-300'
                    : 'text-slate-700 dark:text-slate-300'
                )}
              >
                {l.at && (
                  <span className='shrink-0 text-slate-400'>
                    {new Date(l.at).toLocaleTimeString([], {
                      hour: 'numeric',
                      minute: '2-digit',
                      second: '2-digit'
                    })}
                  </span>
                )}
                <span className='whitespace-pre-wrap break-words'>{l.line ?? ''}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}
