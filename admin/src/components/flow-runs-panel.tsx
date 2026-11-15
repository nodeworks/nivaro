import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, History } from 'lucide-react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { adminRealtime, joinWatchRoom } from '@/lib/socket'
import { cn, formatDate } from '@/lib/utils'
import { applyRunEvent, applyStepEvent, type LiveRuns, liveSummary } from './flow-runs-live'

// ─── Types ────────────────────────────────────────────────────────────────────

interface FlowRun {
  id: string
  flow: string
  trigger: string
  status: 'running' | 'success' | 'error'
  started_at: string
  completed_at: string | null
  duration_ms: number | null
  input: Record<string, unknown> | null
  output: Record<string, unknown> | null
  error_message: string | null
}

const STATUS_CONFIG: Record<FlowRun['status'], string> = {
  success: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  error: 'bg-red-50 text-red-700 border-red-200',
  running: 'bg-amber-50 text-amber-700 border-amber-200'
}

function StatusBadge({ status }: { status: FlowRun['status'] }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold capitalize',
        STATUS_CONFIG[status] ?? 'bg-slate-50 text-slate-600 border-slate-200'
      )}
    >
      {status}
    </span>
  )
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTimestamp(ts: string): string {
  return `${formatDate(ts)} ${new Date(ts).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit'
  })}`
}

// ─── Component ────────────────────────────────────────────────────────────────

export function FlowRunsPanel({ flowId }: { flowId: string }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  const { data, isLoading, isError } = useQuery({
    queryKey: ['flow-runs', flowId],
    queryFn: () => api.get(`/flows/${flowId}/runs`).then((r) => r.data),
    refetchInterval: 10000,
    enabled: open
  })

  // Live flow runs (#287; rt4 #16 step by step): each step lands under its run as it finishes.
  // The list itself is re-read only when a run starts or ends (one read per ~1 s at most), never
  // per step — the steps live here, in this page, for the runs watched while it was open.
  const [live, setLive] = useState<LiveRuns>({})
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: qc is stable
  useEffect(() => {
    setLive({})
    const leave = joinWatchRoom('flows')
    const refetchSoon = () => {
      if (refetchTimer.current) return
      refetchTimer.current = setTimeout(() => {
        refetchTimer.current = null
        void qc.invalidateQueries({ queryKey: ['flow-runs', flowId] })
      }, 800)
    }
    const offStep = adminRealtime.on('flow:step', (p: Record<string, unknown>) => {
      if (p?.flow_id !== flowId) return
      setLive((cur) => applyStepEvent(cur, p))
    })
    const offRun = adminRealtime.on('flow:run', (p: Record<string, unknown>) => {
      if (p?.flow_id !== flowId) return
      setLive((cur) => applyRunEvent(cur, p))
      refetchSoon()
    })
    return () => {
      offStep()
      offRun()
      leave()
      if (refetchTimer.current) clearTimeout(refetchTimer.current)
      refetchTimer.current = null
    }
  }, [flowId])
  const liveStep = liveSummary(live)

  const runs: FlowRun[] = data?.data ?? []

  return (
    <div className='overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex w-full items-center justify-between px-6 py-4'
      >
        <div className='flex items-center gap-2'>
          <History className='h-4 w-4 text-slate-400' />
          <h2 className='whitespace-nowrap text-[13px] font-semibold text-slate-900 dark:text-foreground'>
            Run History
          </h2>
          {liveStep && (
            <span className='inline-flex min-w-0 max-w-[160px] items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-[10.5px] font-medium text-violet-700 dark:bg-violet-500/15 dark:text-violet-300'>
              <span className='h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-violet-500 motion-reduce:animate-none' />
              <span className='truncate'>{liveStep}</span>
            </span>
          )}
          {open && data && (
            <span className='inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500'>
              {runs.length}
            </span>
          )}
        </div>
        {open ? (
          <ChevronDown className='h-4 w-4 text-slate-400' />
        ) : (
          <ChevronRight className='h-4 w-4 text-slate-400' />
        )}
      </button>

      {open && (
        <div className='border-t border-slate-100'>
          {isLoading ? (
            <div className='divide-y divide-slate-100'>
              {(['a', 'b', 'c'] as const).map((k) => (
                <div key={k} className='flex items-center gap-4 px-6 py-3'>
                  <div className='h-3 w-16 animate-pulse rounded bg-slate-100' />
                  <div className='h-3 w-12 animate-pulse rounded-full bg-slate-100' />
                  <div className='ml-auto h-3 w-24 animate-pulse rounded bg-slate-100' />
                </div>
              ))}
            </div>
          ) : isError ? (
            <p className='py-8 text-center text-[12px] text-red-500'>Failed to load runs.</p>
          ) : runs.length === 0 ? (
            <p className='py-8 text-center text-[12px] text-slate-400'>No runs yet.</p>
          ) : (
            <div className='divide-y divide-slate-100 dark:divide-border'>
              {runs.map((run) => {
                const isExpanded = expanded === run.id
                return (
                  <Fragment key={run.id}>
                    <button
                      type='button'
                      onClick={() => setExpanded(isExpanded ? null : run.id)}
                      className='flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50'
                    >
                      {isExpanded ? (
                        <ChevronDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
                      ) : (
                        <ChevronRight className='h-3.5 w-3.5 shrink-0 text-slate-400' />
                      )}
                      <span className='min-w-0 flex-1 truncate font-mono text-[11px] text-slate-500'>
                        {run.trigger}
                      </span>
                      {live[run.id]?.steps.length ? (
                        <span className='shrink-0 text-[10.5px] tabular-nums text-slate-400'>
                          {live[run.id].steps.length}{' '}
                          {live[run.id].steps.length === 1 ? 'step' : 'steps'}
                        </span>
                      ) : null}
                      <span className='shrink-0 text-[10.5px] tabular-nums text-slate-400'>
                        {run.status === 'running' && live[run.id]?.status !== 'running'
                          ? formatDuration(live[run.id]?.ms ?? null)
                          : formatDuration(run.duration_ms)}
                      </span>
                      <StatusBadge
                        status={
                          run.status === 'running' &&
                          live[run.id] &&
                          live[run.id].status !== 'running'
                            ? live[run.id].status
                            : run.status
                        }
                      />
                    </button>
                    {isExpanded && (
                      <div className='min-w-0 space-y-3 bg-slate-50/70 px-4 py-3 dark:bg-slate-800/40'>
                        <p className='text-[10.5px] text-slate-400'>
                          {formatTimestamp(run.started_at)}
                        </p>
                        {live[run.id]?.steps.length ? (
                          <LiveSteps
                            steps={live[run.id].steps}
                            running={live[run.id].status === 'running'}
                          />
                        ) : null}
                        {run.error_message && (
                          <div>
                            <p className='mb-1 text-[11px] font-semibold text-red-600'>Error</p>
                            <pre className='max-w-full overflow-auto rounded-lg bg-red-50 p-2.5 font-mono text-[10.5px] text-red-700'>
                              {run.error_message}
                            </pre>
                          </div>
                        )}
                        {run.input && (
                          <div>
                            <p className='mb-1 text-[11px] font-semibold text-slate-500'>Input</p>
                            <pre className='max-h-48 max-w-full overflow-auto rounded-lg bg-slate-900 p-2.5 font-mono text-[10.5px] text-slate-100'>
                              {JSON.stringify(run.input, null, 2)}
                            </pre>
                          </div>
                        )}
                        {run.output && (
                          <div>
                            <p className='mb-1 text-[11px] font-semibold text-slate-500'>Output</p>
                            <pre className='max-h-48 max-w-full overflow-auto rounded-lg bg-slate-900 p-2.5 font-mono text-[10.5px] text-slate-100'>
                              {JSON.stringify(run.output, null, 2)}
                            </pre>
                          </div>
                        )}
                        {!run.error_message &&
                          !run.input &&
                          !run.output &&
                          !live[run.id]?.steps.length && (
                            <p className='text-[12px] text-slate-400'>No details available.</p>
                          )}
                      </div>
                    )}
                  </Fragment>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** The steps of a run watched live, in the order they finished (rt4 #16). */
function LiveSteps({ steps, running }: { steps: LiveRuns[string]['steps']; running: boolean }) {
  return (
    <div>
      <p className='mb-1 text-[11px] font-semibold text-slate-500 dark:text-slate-400'>Steps</p>
      <ol className='space-y-0.5' aria-live='polite'>
        {steps.map((s, i) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: steps only append; a step may run twice
            key={i}
            className='flex animate-[nvr-fade-in_240ms_ease-out_backwards] items-center gap-2 text-[11px] motion-reduce:animate-none'
          >
            <span
              className={cn(
                'h-1.5 w-1.5 shrink-0 rounded-full',
                s.status === 'reject'
                  ? 'bg-red-500'
                  : s.status === 'async'
                    ? 'bg-slate-400'
                    : 'bg-emerald-500'
              )}
              aria-hidden
            />
            <span className='min-w-0 flex-1 truncate font-mono text-slate-700 dark:text-slate-200'>
              {s.op}
            </span>
            <span className='shrink-0 text-slate-400'>{s.type}</span>
            <span className='w-12 shrink-0 text-right tabular-nums text-slate-400'>
              {s.ms != null ? formatDuration(s.ms) : ''}
            </span>
          </li>
        ))}
        {running && (
          <li className='flex items-center gap-2 text-[11px] text-slate-400'>
            <span className='h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-violet-500 motion-reduce:animate-none' />
            Running…
          </li>
        )}
      </ol>
    </div>
  )
}
