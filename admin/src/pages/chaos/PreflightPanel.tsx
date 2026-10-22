import { useQuery } from '@tanstack/react-query'
import { Check, RefreshCw, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { chaosKeys, fetchPreflight, type Preflight, type PreflightCheck } from './api'

/**
 * Pre-flight (#2848) beside the Run button: every check with a tick or a reason. Re-read every
 * 15 s while the form is open; the server runs the same checks again when the run starts and
 * `serverChecks` shows what it said when it refused.
 */
export function PreflightPanel({
  serverChecks,
  onResult
}: {
  serverChecks: PreflightCheck[] | null
  onResult?: (ok: boolean, checks: PreflightCheck[]) => void
}) {
  const { data, isLoading, isError, refetch, isFetching } = useQuery<Preflight>({
    queryKey: chaosKeys.preflight,
    queryFn: fetchPreflight,
    refetchInterval: 15_000,
    retry: false
  })
  const checks = serverChecks ?? data?.checks ?? []
  const ok = serverChecks ? serverChecks.every((c) => c.ok) : (data?.ok ?? null)
  // The parent's callback is an inline function; only a new answer should fire it.
  const onResultRef = useRef(onResult)
  onResultRef.current = onResult
  useEffect(() => {
    if (data) onResultRef.current?.(data.ok, data.checks)
  }, [data])

  return (
    <aside
      aria-label='Pre-flight'
      className='min-w-0 rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
    >
      <div className='flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-border'>
        <div className='flex items-center gap-2'>
          <span className='text-[12.5px] font-semibold text-slate-900 dark:text-foreground'>
            Pre-flight
          </span>
          {ok != null && (
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[11px] font-medium',
                // A block is a stop sign, not danger: amber. Red stays for armed faults.
                ok
                  ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
                  : 'bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300'
              )}
            >
              {ok ? 'Clear' : serverChecks ? 'Refused at start' : 'Blocked'}
            </span>
          )}
        </div>
        <button
          type='button'
          onClick={() => void refetch()}
          aria-label='Re-run the checks'
          data-tip='Re-run the checks'
          className='rounded p-1 text-slate-500 transition-colors duration-150 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-muted-foreground dark:hover:bg-muted dark:hover:text-foreground'
        >
          <RefreshCw
            className={cn('h-3.5 w-3.5', isFetching && 'animate-spin motion-reduce:animate-none')}
            aria-hidden
          />
        </button>
      </div>
      {isLoading ? (
        <div className='space-y-2 p-3'>
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className='h-4 w-full' />
          ))}
        </div>
      ) : isError && !serverChecks ? (
        <p className='p-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
          The checks did not answer. The server runs them again when the run starts.
        </p>
      ) : (
        <ul className='divide-y divide-slate-100 dark:divide-border/60'>
          {checks.map((c) => (
            <li key={c.key} className='flex items-start gap-2 px-3 py-2'>
              {c.ok ? (
                <Check
                  className='mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400'
                  aria-label='Passed'
                />
              ) : (
                <X
                  className='mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400'
                  aria-label='Failed'
                />
              )}
              <div className='min-w-0'>
                <div className='text-[12.5px] text-slate-900 dark:text-foreground'>{c.label}</div>
                {!c.ok && c.why && (
                  <div className='mt-0.5 text-[11.5px] text-slate-600 dark:text-muted-foreground'>
                    {c.why}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}
