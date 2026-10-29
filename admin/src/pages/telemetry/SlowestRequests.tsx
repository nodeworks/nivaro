import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight, Gauge } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { ExplainButton } from '@/components/explain-button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { requestStoryPath } from '@/lib/recent-requests'
import { cn, formatRelative } from '@/lib/utils'
import { fmtMs, grafanaTraceUrl } from './links'
import { PartError, TONE } from './ui'

/**
 * Slowest (or failed) traced requests from the traces store (#2544), each with Explain (the
 * `trace` explain kind reads the stored trace) and Open in Grafana. GET /api/telemetry/traces.
 */

interface TraceRow {
  trace_id: string
  route: string
  status: number
  total_ms: number
  at: string | null
  reason: string | null
}

const WINDOWS = [
  { minutes: 60, label: '1 h' },
  { minutes: 1440, label: '24 h' },
  { minutes: 10_080, label: '7 d' }
]

const REASON_LABEL: Record<string, string> = {
  kept: 'Marked to keep',
  sampled: 'Sampled'
}

export function SlowestRequests({ grafanaUrl }: { grafanaUrl: string | null }) {
  const [minutes, setMinutes] = useState(60)
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const q = useQuery({
    queryKey: ['telemetry', 'traces', minutes, errorsOnly],
    queryFn: () =>
      api
        .get<{ data: { traces: TraceRow[] } }>('/telemetry/traces', {
          params: { minutes, errors_only: errorsOnly, limit: 10 }
        })
        .then((r) => r.data.data.traces),
    // An open explanation keeps its row where it is.
    refetchInterval: open ? false : 60_000
  })
  const serverErr = (q.error as { response?: { data?: { error?: string } } } | null)?.response?.data
    ?.error

  const seg = (on: boolean) =>
    cn(
      'px-2.5 py-[3px] text-[12px] font-medium first:rounded-l-md last:rounded-r-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
      on ? 'bg-nvr-cyan/10 text-foreground' : 'text-muted-foreground hover:bg-muted'
    )

  return (
    <section className='min-w-0 rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <header className='flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2.5 dark:border-border'>
        <Gauge className='h-4 w-4 shrink-0 text-muted-foreground' aria-hidden='true' />
        <h2 className='m-0 text-[13px] font-semibold'>Slowest requests</h2>
        <div className='ml-auto flex flex-wrap items-center gap-2'>
          <fieldset className='m-0 inline-flex min-w-0 rounded-md border border-slate-200 p-0 dark:border-border'>
            <legend className='sr-only'>Window</legend>
            {WINDOWS.map((w) => (
              <button
                key={w.minutes}
                type='button'
                aria-pressed={minutes === w.minutes}
                onClick={() => setMinutes(w.minutes)}
                className={seg(minutes === w.minutes)}
              >
                {w.label}
              </button>
            ))}
          </fieldset>
          <fieldset className='m-0 inline-flex min-w-0 rounded-md border border-slate-200 p-0 dark:border-border'>
            <legend className='sr-only'>Which requests</legend>
            <button
              type='button'
              aria-pressed={!errorsOnly}
              onClick={() => setErrorsOnly(false)}
              className={seg(!errorsOnly)}
            >
              All
            </button>
            <button
              type='button'
              aria-pressed={errorsOnly}
              onClick={() => setErrorsOnly(true)}
              className={seg(errorsOnly)}
            >
              Server errors
            </button>
          </fieldset>
        </div>
      </header>
      <div className='p-4'>
        {q.isLoading ? (
          <div className='grid gap-2' role='status' aria-label='Loading'>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className='h-7 rounded-md' />
            ))}
          </div>
        ) : q.isError ? (
          <PartError error={serverErr ?? 'Couldn’t read the traces. Try again in a moment.'} />
        ) : !q.data?.length ? (
          <p className='m-0 text-[12.5px] text-muted-foreground'>
            No traced requests in this window. Slow, failed, kept and a small sample of other
            requests are traced.
          </p>
        ) : (
          <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
            {q.data.map((t) => {
              const isOpen = open === t.trace_id
              const href = grafanaTraceUrl(grafanaUrl, t.trace_id)
              const panel = `slow-${t.trace_id}`
              const tone = t.total_ms >= 5000 ? 'bad' : t.total_ms >= 1000 ? 'warn' : null
              // The badge already says "server error" and the colour already says "slow".
              const reason = t.reason ? REASON_LABEL[t.reason] : undefined
              return (
                <li key={t.trace_id} className='min-w-0 py-2 first:pt-0 last:pb-0'>
                  <div className='flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]'>
                    <span
                      className={cn(
                        'w-[64px] shrink-0 text-right font-semibold tabular-nums',
                        tone ? TONE[tone].text : 'text-foreground'
                      )}
                    >
                      {fmtMs(t.total_ms)}
                    </span>
                    <span className='min-w-0 flex-1 basis-[calc(100%-76px)] truncate font-mono text-[12px] sm:basis-0'>
                      {t.route}
                    </span>
                    <span className='ml-[76px] flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 sm:ml-0 sm:flex-none sm:shrink-0'>
                      {t.status >= 500 && (
                        <span className='shrink-0 rounded bg-red-100 px-1.5 py-px text-[10.5px] font-semibold text-red-700 dark:bg-red-500/15 dark:text-red-400'>
                          {t.status}
                        </span>
                      )}
                      <span className='min-w-0 truncate text-[11.5px] text-muted-foreground'>
                        {[reason, t.at ? formatRelative(t.at) : null].filter(Boolean).join(' · ')}
                      </span>
                      <span className='ml-auto flex shrink-0 items-center gap-1'>
                        <button
                          type='button'
                          aria-expanded={isOpen}
                          aria-controls={panel}
                          aria-label={`${isOpen ? 'Hide explanation for' : 'Explain'} ${t.route}`}
                          onClick={() => setOpen(isOpen ? null : t.trace_id)}
                          className={cn(
                            'rounded px-1.5 py-0.5 text-[12px] font-medium text-nvr-navy hover:bg-nvr-cyan/10 dark:text-nvr-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
                            isOpen && 'bg-nvr-cyan/10'
                          )}
                        >
                          {isOpen ? 'Hide' : 'Explain'}
                        </button>
                        {/* #19 — the trace id is the request id without dashes. */}
                        <Link
                          to={requestStoryPath(t.trace_id)}
                          aria-label={`Request story of ${t.route}`}
                          className='rounded px-1.5 py-0.5 text-[12px] font-medium text-nvr-navy hover:bg-nvr-cyan/10 dark:text-nvr-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                        >
                          Story
                        </Link>
                        {href && (
                          <a
                            href={href}
                            target='_blank'
                            rel='noopener noreferrer'
                            aria-label={`Open ${t.route} in Grafana`}
                            className='inline-flex items-center rounded px-1 py-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                          >
                            <ArrowUpRight className='h-3.5 w-3.5' aria-hidden='true' />
                          </a>
                        )}
                      </span>
                    </span>
                  </div>
                  {isOpen && (
                    <div id={panel} className='mt-2 sm:pl-[76px]'>
                      <ExplainButton kind='trace' params={{ id: t.trace_id }} autoRun />
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
