import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

// Shared with /quality-checks (the page imports these, never the reverse, so
// the Environments chunk does not pull in the whole page).

export type QualityStatus = 'green' | 'amber' | 'red' | 'error'

export interface QualityRun {
  id: string
  target: string
  status: 'capturing' | 'captured' | 'verifying' | 'done' | 'error'
  started_at: string
  captured_at: string | null
  verified_at: string | null
  totals: Partial<Record<QualityStatus, number>> | null
  runbook_run: string | null
  error: string | null
}

export const QUALITY_TARGET = 'EFP_Staging'

export const STATUS_TEXT: Record<QualityStatus, string> = {
  green: 'text-emerald-600 dark:text-emerald-400',
  amber: 'text-amber-600 dark:text-amber-400',
  red: 'text-rose-600 dark:text-rose-400',
  error: 'text-slate-500'
}

const STATUS_DOT: Record<QualityStatus, string> = {
  green: 'bg-emerald-500 dark:bg-emerald-400',
  amber: 'bg-amber-500 dark:bg-amber-400',
  red: 'bg-rose-500 dark:bg-rose-400',
  error: 'bg-slate-400 dark:bg-slate-500'
}

/** Pure: a run's totals, falling back to counting its results. */
export function runTotals(
  run: QualityRun | null | undefined,
  results?: Array<{ status: QualityStatus }>
): Record<QualityStatus, number> {
  const t = { green: 0, amber: 0, red: 0, error: 0 }
  if (results?.length) {
    for (const r of results) t[r.status] = (t[r.status] ?? 0) + 1
    return t
  }
  for (const k of Object.keys(t) as QualityStatus[]) t[k] = Number(run?.totals?.[k] ?? 0)
  return t
}

export function StatusDot({ status, className }: { status: QualityStatus; className?: string }) {
  return (
    <span
      className={cn('inline-block h-2 w-2 shrink-0 rounded-full', STATUS_DOT[status], className)}
      aria-hidden
    />
  )
}

/** "N red · N amber · N green · N error" with coloured numbers. */
export function TotalsLine({ totals }: { totals: Record<QualityStatus, number> }) {
  const order: QualityStatus[] = ['red', 'amber', 'green', 'error']
  return (
    <span className='inline-flex flex-wrap items-center gap-x-1'>
      {order.map((s, i) => (
        <span key={s} className='inline-flex items-center gap-1'>
          {i > 0 && <span className='text-slate-300 dark:text-slate-600'>·</span>}
          <span className={cn('font-semibold tabular-nums', STATUS_TEXT[s])}>
            {totals[s].toLocaleString('en-US')}
          </span>
          <span className='text-slate-500 dark:text-muted-foreground'>{s}</span>
        </span>
      ))}
    </span>
  )
}

/**
 * Environments → Quality checks: the latest quality run of the EFP_Staging
 * rebuild in one line, with a link to the full page. Renders nothing when
 * the quality routes are not available on this instance.
 */
export function QualityChecksCard() {
  const q = useQuery({
    queryKey: ['quality-runs', QUALITY_TARGET],
    queryFn: () =>
      api
        .get<{ data: QualityRun[] }>('/quality-checks/runs', { params: { target: QUALITY_TARGET } })
        .then((r) => r.data.data),
    refetchInterval: 60_000,
    retry: false
  })
  if (q.isLoading || q.isError) return null
  const latest = q.data?.[0] ?? null
  const totals = runTotals(latest)
  const when = latest?.verified_at ?? latest?.captured_at ?? latest?.started_at
  return (
    <section
      data-quality-card
      className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'
    >
      <div className='flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1'>
        <h2 className='text-[13.5px] font-semibold text-slate-900 dark:text-foreground'>
          Quality checks
        </h2>
        <Link
          to='/quality-checks'
          data-quality-card-link
          className='text-[12px] font-medium text-nvr-navy underline-offset-2 hover:underline dark:text-nvr-cyan'
        >
          Open quality checks
        </Link>
      </div>
      {!latest ? (
        <p className='mt-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
          No quality run yet — run Rebuild {QUALITY_TARGET}
        </p>
      ) : latest.status === 'done' ? (
        <p className='mt-1 flex flex-wrap items-center gap-x-1.5 text-[12px] text-slate-600 dark:text-slate-300'>
          <StatusDot
            status={totals.red ? 'red' : totals.error ? 'error' : totals.amber ? 'amber' : 'green'}
          />
          <span>Checked {when ? formatRelative(when) : '—'}</span>
          <span className='text-slate-300 dark:text-slate-600'>·</span>
          <TotalsLine totals={totals} />
        </p>
      ) : latest.status === 'error' ? (
        <p className='mt-1 text-[12px] text-rose-600 dark:text-rose-400'>
          The last quality run failed{when ? ` (${formatRelative(when)})` : ''}
          {latest.error ? `: ${latest.error}` : ''}
        </p>
      ) : (
        <p className='mt-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
          {latest.status === 'verifying'
            ? 'Checking the converted database now'
            : latest.status === 'capturing'
              ? 'Capturing production figures now'
              : 'Production figures captured — the check runs once the conversions finish'}
          {when ? ` · started ${formatRelative(latest.started_at)}` : ''}
        </p>
      )}
    </section>
  )
}
