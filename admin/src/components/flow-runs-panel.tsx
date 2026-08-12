import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, History } from 'lucide-react'
import { Fragment, useState } from 'react'
import { api } from '@/lib/api'
import { cn, formatDate } from '@/lib/utils'

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
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  const { data, isLoading, isError } = useQuery({
    queryKey: ['flow-runs', flowId],
    queryFn: () => api.get(`/flows/${flowId}/runs`).then((r) => r.data),
    refetchInterval: 10000,
    enabled: open
  })

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
          <h2 className='text-[13px] font-semibold text-slate-900'>Run History</h2>
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
                      <span className='shrink-0 text-[10.5px] tabular-nums text-slate-400'>
                        {formatDuration(run.duration_ms)}
                      </span>
                      <StatusBadge status={run.status} />
                    </button>
                    {isExpanded && (
                      <div className='min-w-0 space-y-3 bg-slate-50/70 px-4 py-3 dark:bg-slate-800/40'>
                        <p className='text-[10.5px] text-slate-400'>
                          {formatTimestamp(run.started_at)}
                        </p>
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
                        {!run.error_message && !run.input && !run.output && (
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
