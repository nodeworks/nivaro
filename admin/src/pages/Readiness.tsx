import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, CircleSlash, RefreshCw, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Go-live readiness scorecard. The checks come from the deployment's
 * extension (EFP: legacy writes, takeover flags, sequence margins, UAT
 * hosts…); this page just runs and renders them, grouped, with the blockers
 * spelled out. Refresh re-runs everything live.
 */

interface Check {
  id: string
  label: string
  description?: string
  group?: string
  status: 'pass' | 'warn' | 'fail' | 'skip' | 'error'
  detail?: string
  blockers?: string[]
  duration_ms: number
}

interface Report {
  score: number | null
  counts: Record<string, number>
  checks: Check[]
}

const STATUS_META: Record<
  Check['status'],
  { icon: typeof CheckCircle2; cls: string; label: string }
> = {
  pass: { icon: CheckCircle2, cls: 'text-emerald-600 dark:text-emerald-400', label: 'Pass' },
  warn: { icon: AlertTriangle, cls: 'text-amber-600 dark:text-amber-400', label: 'Warning' },
  fail: { icon: XCircle, cls: 'text-red-600 dark:text-red-400', label: 'Blocking' },
  error: { icon: XCircle, cls: 'text-red-600 dark:text-red-400', label: 'Check failed' },
  skip: { icon: CircleSlash, cls: 'text-slate-400', label: 'Not applicable' }
}

export default function Readiness() {
  const { data, isFetching, refetch, dataUpdatedAt } = useQuery<Report>({
    queryKey: ['readiness'],
    queryFn: () => api.get<{ data: Report }>('/readiness').then((r) => r.data.data),
    staleTime: 60_000,
    retry: false
  })

  const groups = new Map<string, Check[]>()
  for (const c of data?.checks ?? []) {
    const g = c.group ?? 'General'
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)?.push(c)
  }

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between'>
          <div>
            <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
              Go-Live Readiness
            </h1>
            <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              Continuously answerable: can we cut over? Every check runs live against the current
              state — nothing here is a cached opinion.
            </p>
          </div>
          <div className='flex items-center gap-3'>
            {dataUpdatedAt > 0 && (
              <span className='text-[11.5px] text-slate-400'>
                checked {new Date(dataUpdatedAt).toLocaleTimeString()}
              </span>
            )}
            <Button size='sm' variant='outline' disabled={isFetching} onClick={() => refetch()}>
              <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} /> Re-run
              checks
            </Button>
          </div>
        </div>
      </header>

      <div className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
        <div className='max-w-[880px] space-y-4'>
          {!data && isFetching && (
            <p className='text-[12.5px] text-slate-400'>Running checks…</p>
          )}
          {data && data.checks.length === 0 && (
            <div className='rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
              <p className='text-[13px] text-slate-600 dark:text-muted-foreground'>
                No readiness checks are registered on this deployment. Extensions add them via{' '}
                <code className='font-mono text-[12px]'>ctx.readiness.registerCheck(…)</code>.
              </p>
            </div>
          )}

          {data && data.checks.length > 0 && (
            <div className='flex items-center gap-5 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
              <ScoreRing score={data.score} />
              <div>
                <p className='text-[15px] font-semibold text-slate-900 dark:text-foreground'>
                  {data.score == null
                    ? 'No scoreable checks'
                    : data.score === 100
                      ? 'Ready to cut over'
                      : `${data.score}% ready`}
                </p>
                <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
                  {data.counts.pass ?? 0} passing · {data.counts.warn ?? 0} warning
                  {(data.counts.warn ?? 0) === 1 ? '' : 's'} ·{' '}
                  {(data.counts.fail ?? 0) + (data.counts.error ?? 0)} blocking
                </p>
              </div>
            </div>
          )}

          {[...groups.entries()].map(([group, checks]) => (
            <div key={group}>
              <p className='mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-muted-foreground'>
                {group}
              </p>
              <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
                {checks.map((c, i) => {
                  const meta = STATUS_META[c.status]
                  const Icon = meta.icon
                  return (
                    <div
                      key={c.id}
                      className={cn(
                        'px-4 py-3',
                        i > 0 && 'border-t border-slate-100 dark:border-border/60'
                      )}
                    >
                      <div className='flex items-start gap-2.5'>
                        <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', meta.cls)} />
                        <div className='min-w-0 flex-1'>
                          <p className='text-[13px] font-medium text-slate-800 dark:text-foreground'>
                            {c.label}
                            <span className={cn('ml-2 text-[11px] font-normal', meta.cls)}>
                              {meta.label}
                            </span>
                          </p>
                          {c.detail && (
                            <p className='mt-0.5 text-[12px] text-slate-600 dark:text-muted-foreground'>
                              {c.detail}
                            </p>
                          )}
                          {c.description && (
                            <p className='mt-0.5 text-[11.5px] leading-snug text-slate-400'>
                              {c.description}
                            </p>
                          )}
                          {c.blockers && c.blockers.length > 0 && (
                            <ul className='mt-1.5 space-y-0.5'>
                              {c.blockers.map((b) => (
                                <li
                                  key={b}
                                  className='flex items-baseline gap-1.5 text-[12px] text-slate-700 dark:text-slate-300'
                                >
                                  <span
                                    className={cn(
                                      'text-[10px]',
                                      c.status === 'fail' || c.status === 'error'
                                        ? 'text-red-500'
                                        : 'text-amber-500'
                                    )}
                                  >
                                    ●
                                  </span>
                                  <span className='min-w-0 font-mono text-[11.5px]'>{b}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function ScoreRing({ score }: { score: number | null }) {
  const pct = score ?? 0
  const r = 26
  const c = 2 * Math.PI * r
  const tone =
    score == null
      ? 'stroke-slate-300'
      : score >= 90
        ? 'stroke-emerald-500'
        : score >= 60
          ? 'stroke-amber-500'
          : 'stroke-red-500'
  return (
    <svg width='68' height='68' viewBox='0 0 68 68' className='shrink-0 -rotate-90'>
      <circle cx='34' cy='34' r={r} strokeWidth='6' fill='none' className='stroke-slate-100 dark:stroke-border' />
      <circle
        cx='34'
        cy='34'
        r={r}
        strokeWidth='6'
        fill='none'
        strokeLinecap='round'
        strokeDasharray={`${(pct / 100) * c} ${c}`}
        className={cn('transition-all duration-700', tone)}
      />
      <text
        x='34'
        y='34'
        textAnchor='middle'
        dominantBaseline='central'
        className='rotate-90 fill-slate-800 text-[15px] font-semibold dark:fill-slate-100'
        transform='rotate(90 34 34)'
      >
        {score == null ? '—' : score}
      </text>
    </svg>
  )
}
