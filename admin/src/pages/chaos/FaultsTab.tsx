import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ExternalLink, Play } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { cn, formatRelative } from '@/lib/utils'
import {
  type Catalog,
  type CatalogFault,
  type ChaosStatus,
  chaosKeys,
  fetchCatalog,
  fetchStatus,
  VERDICT_TONE
} from './api'
import { StartForm } from './StartForm'

/**
 * Faults (#2843): every fault in the catalog as a row — what it proves, where it acts, its last
 * run and verdict, Run. Run opens the start form inline under the row (no dialog); the socket
 * drill row links to the Realtime page's own drill form instead of repeating it.
 */

const DANGER: Record<CatalogFault['danger'], { label: string; cls: string }> = {
  low: {
    label: 'Low blast',
    cls: 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground'
  },
  medium: {
    label: 'Medium blast',
    cls: 'bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300'
  },
  // Orange, not red: red on this page means "armed now" and Stop all.
  high: {
    label: 'High blast',
    cls: 'bg-orange-50 text-orange-800 dark:bg-orange-950/50 dark:text-orange-300'
  }
}

export function FaultsTab() {
  const { data, isLoading, isError } = useQuery<Catalog>({
    queryKey: chaosKeys.catalog,
    queryFn: fetchCatalog
  })
  const { data: status } = useQuery<ChaosStatus>({
    queryKey: chaosKeys.status,
    queryFn: fetchStatus
  })
  // #2851 deep link: ?fault=<key>&target=… (the Traffic Map's "Inject fault here") opens that
  // fault's start form, aimed at the target, and scrolls it into view.
  const [search] = useSearchParams()
  const linked = search.get('fault')
  const [open, setOpen] = useState<string | null>(linked)
  useEffect(() => {
    if (!linked || !data) return
    setOpen(linked)
    document
      .querySelector(`[data-chaos-fault="${CSS.escape(linked)}"]`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [linked, data])
  const allowed = status?.allowed ?? true
  const armedByFault = new Map((status?.armed ?? []).map((a) => [a.fault_key, a]))

  return (
    <div className='flex-1 overflow-y-auto px-4 py-5 sm:p-6'>
      <div className='mb-4 flex flex-wrap items-end justify-between gap-3'>
        <div className='min-w-0'>
          <h2 className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>Faults</h2>
          <p className='mt-0.5 max-w-[75ch] text-[12.5px] text-slate-500 dark:text-muted-foreground'>
            Each fault proves one claim about how Nivaro degrades. A run is time-boxed, reaches
            every replica, and stops by itself when the limits you set are crossed.
          </p>
        </div>
        {data && (
          <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            {data.faults.length} faults · runs stored in{' '}
            {data.store === 'db'
              ? 'the database'
              : data.store === 'redis'
                ? 'Redis (7 days)'
                : 'memory only'}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className='space-y-px overflow-hidden rounded-lg border border-slate-200 dark:border-border'>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className='flex items-center gap-4 bg-white px-4 py-3.5 dark:bg-card'>
              <Skeleton className='h-4 w-40' />
              <Skeleton className='h-3.5 flex-1' />
              <Skeleton className='h-7 w-16' />
            </div>
          ))}
        </div>
      ) : isError || !data ? (
        <p className='rounded-lg border border-slate-200 bg-white px-4 py-6 text-center text-[12.5px] text-slate-500 dark:border-border dark:bg-card dark:text-muted-foreground'>
          The catalog did not answer. Reload, or check /api/chaos/catalog.
        </p>
      ) : data.faults.length === 0 ? (
        <p className='rounded-lg border border-slate-200 bg-white px-4 py-6 text-center text-[12.5px] text-slate-500 dark:border-border dark:bg-card dark:text-muted-foreground'>
          No faults registered. Fault areas register themselves in{' '}
          <span className='font-mono text-[11.5px]'>api/src/services/chaos/faults/</span>.
        </p>
      ) : (
        <ul className='divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-border dark:border-border dark:bg-card'>
          {data.faults.map((f) => {
            const armed = armedByFault.get(f.key)
            const expanded = open === f.key
            return (
              <li key={f.key} data-chaos-fault={f.key}>
                <div className='flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3.5'>
                  <div className='min-w-0 flex-1 basis-64'>
                    <div className='flex flex-wrap items-center gap-2'>
                      <span className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
                        {f.label}
                      </span>
                      <span className='font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
                        {f.key}
                      </span>
                      <span
                        className={cn(
                          'rounded px-1.5 py-0.5 text-[10.5px] font-medium',
                          DANGER[f.danger].cls
                        )}
                      >
                        {DANGER[f.danger].label}
                      </span>
                      {armed && (
                        <Link
                          to={
                            armed.run_id ? `/chaos?tab=runs&run=${armed.run_id}` : '/chaos?tab=runs'
                          }
                          className='rounded bg-red-50 px-1.5 py-0.5 text-[10.5px] font-medium text-red-800 hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 dark:bg-red-950/50 dark:text-red-300 dark:hover:bg-red-950/70'
                        >
                          Armed now
                        </Link>
                      )}
                    </div>
                    <p className='mt-1 max-w-[80ch] text-[12.5px] text-slate-600 dark:text-muted-foreground'>
                      {f.proves}
                    </p>
                    {f.points.length > 0 && (
                      <p className='mt-1 text-[11px] text-slate-500 dark:text-muted-foreground'>
                        acts at <span className='font-mono'>{f.points.join(', ')}</span> · up to{' '}
                        {f.max_seconds}s
                      </p>
                    )}
                  </div>
                  <div className='flex shrink-0 items-center gap-3 self-center'>
                    <LastRun f={f} />
                    {f.console_href ? (
                      <Link
                        to={f.console_href}
                        className='inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-[12.5px] font-medium text-slate-800 transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-border dark:bg-card dark:text-foreground'
                      >
                        Open drills
                        <ExternalLink className='h-3.5 w-3.5' aria-hidden />
                      </Link>
                    ) : (
                      // The wrapper carries the refusal tip: a disabled button gets no pointer events.
                      <span data-tip={allowed ? undefined : (status?.reason ?? 'Refused here')}>
                        <button
                          type='button'
                          disabled={!allowed}
                          aria-expanded={expanded}
                          onClick={() => setOpen(expanded ? null : f.key)}
                          className={cn(
                            'inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-[12.5px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-40 dark:focus-visible:ring-offset-card',
                            // One solid accent per screen: the form's own Run button.
                            expanded
                              ? 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-muted dark:border-border dark:bg-muted dark:text-foreground'
                              : 'border-slate-200 bg-white text-slate-800 hover:border-nvr-cyan/60 hover:bg-nvr-cyan/10 dark:border-border dark:bg-card dark:text-foreground dark:hover:border-nvr-cyan/50'
                          )}
                        >
                          {expanded ? (
                            <ChevronDown className='h-3.5 w-3.5' aria-hidden />
                          ) : (
                            <Play className='h-3.5 w-3.5' aria-hidden />
                          )}
                          {expanded ? 'Close' : 'Run'}
                        </button>
                      </span>
                    )}
                  </div>
                </div>
                {expanded && <StartForm fault={f} onClose={() => setOpen(null)} />}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function LastRun({ f }: { f: CatalogFault }) {
  const r = f.last_run
  if (!r)
    return (
      <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>Never run</span>
    )
  return (
    <Link
      to={`/chaos?tab=runs&run=${r.id}`}
      data-tip='Open this run'
      className='flex items-center gap-2 rounded px-1 py-0.5 text-[11.5px] text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-muted-foreground dark:hover:bg-muted'
    >
      {r.verdict ? (
        <span
          className={cn(
            'rounded px-1.5 py-0.5 text-[10.5px] font-medium capitalize',
            VERDICT_TONE[r.verdict]
          )}
        >
          {r.verdict}
        </span>
      ) : (
        <span className='rounded bg-slate-100 px-1.5 py-0.5 text-[10.5px] font-medium capitalize text-slate-600 dark:bg-muted dark:text-muted-foreground'>
          {r.status}
        </span>
      )}
      <span className='tabular-nums'>
        {formatRelative(r.ended_at ?? r.started_at ?? new Date())}
      </span>
    </Link>
  )
}
