import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { cn, formatRelative } from '@/lib/utils'
import { type ChaosRun, chaosKeys, fetchRuns, STATUS_LABEL, VERDICT_TONE } from './api'
import { RunDetail } from './RunDetail'

/**
 * Runs (#2843): the list of every run (running first) and, on the right, the selected run — the
 * live cockpit while it runs (#2845), a plain summary afterwards. `?run=<id>` deep-links.
 */
export function RunsTab() {
  const [params, setParams] = useSearchParams()
  const selected = params.get('run')
  const {
    data: runs,
    isLoading,
    isError
  } = useQuery<ChaosRun[]>({
    queryKey: chaosKeys.runs(),
    queryFn: () => fetchRuns({ limit: 100 }),
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'running') ? 5_000 : 60_000)
  })
  const select = (id: string | null) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p)
        if (id) next.set('run', id)
        else next.delete('run')
        return next
      },
      { replace: true }
    )
  const ordered = [...(runs ?? [])].sort((a, b) => {
    const ra = a.status === 'running' ? 0 : 1
    const rb = b.status === 'running' ? 0 : 1
    return ra - rb || b.created_at.localeCompare(a.created_at)
  })

  return (
    <div className='flex flex-1 min-h-0 overflow-hidden'>
      <aside
        aria-label='Runs'
        className='w-[272px] shrink-0 overflow-y-auto border-r border-slate-200 bg-white dark:border-border dark:bg-card'
      >
        {isLoading ? (
          <div className='space-y-3 p-3'>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className='space-y-1.5'>
                <Skeleton className='h-3.5 w-36' />
                <Skeleton className='h-3 w-24' />
              </div>
            ))}
          </div>
        ) : isError ? (
          <p className='p-4 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
            The runs did not load.
          </p>
        ) : ordered.length === 0 ? (
          <div className='p-4 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
            <p className='font-medium text-slate-700 dark:text-foreground'>No runs yet</p>
            <p className='mt-1'>
              Start one from the Faults tab. Every run lands here with its verdict.
            </p>
          </div>
        ) : (
          <ul className='divide-y divide-slate-100 dark:divide-border/60'>
            {ordered.map((r) => {
              const on = r.id === selected
              return (
                <li key={r.id}>
                  <button
                    type='button'
                    onClick={() => select(r.id)}
                    aria-current={on ? 'true' : undefined}
                    className={cn(
                      'block w-full px-3 py-2.5 text-left transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan dark:hover:bg-muted',
                      on && 'bg-nvr-cyan/10 hover:bg-nvr-cyan/10 dark:bg-nvr-cyan/15'
                    )}
                  >
                    <div className='flex items-center gap-2'>
                      {r.status === 'running' && (
                        <span className='relative flex h-2 w-2 shrink-0' aria-hidden>
                          <span className='absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75 motion-reduce:animate-none' />
                          <span className='relative inline-flex h-2 w-2 rounded-full bg-red-500' />
                        </span>
                      )}
                      <span className='min-w-0 flex-1 truncate text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
                        {r.label}
                      </span>
                      <RunChip run={r} />
                    </div>
                    <div className='mt-0.5 flex items-center gap-2 text-[11px] text-slate-500 dark:text-muted-foreground'>
                      <span className='capitalize'>{r.kind}</span>
                      <span aria-hidden>·</span>
                      <span className='tabular-nums'>
                        {formatRelative(r.started_at ?? r.created_at)}
                      </span>
                      {typeof r.meta.started_by_name === 'string' && (
                        <>
                          <span aria-hidden>·</span>
                          <span className='truncate'>{r.meta.started_by_name}</span>
                        </>
                      )}
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </aside>
      <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
        {selected ? (
          <RunDetail id={selected} />
        ) : (
          <div className='flex h-full items-center justify-center p-8'>
            <p className='max-w-[44ch] text-center text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              {ordered.length
                ? 'Pick a run on the left. A running one opens its cockpit.'
                : 'Runs appear here as soon as a fault is armed.'}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

export function RunChip({ run }: { run: ChaosRun }) {
  if (run.verdict)
    return (
      <span
        className={cn(
          'rounded px-1.5 py-0.5 text-[10.5px] font-medium capitalize',
          VERDICT_TONE[run.verdict]
        )}
      >
        {run.verdict}
      </span>
    )
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[10.5px] font-medium',
        run.status === 'running'
          ? 'bg-red-50 text-red-800 dark:bg-red-950/50 dark:text-red-300'
          : 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground'
      )}
    >
      {STATUS_LABEL[run.status]}
    </span>
  )
}
