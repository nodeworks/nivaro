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
  verify_started_at?: string | null
  totals: Partial<Record<QualityStatus, number>> | null
  runbook_run: string | null
  error: string | null
}

/** What GET /quality-checks/config answers. */
export interface QualityConfig {
  /** The host runbook an extension declared to re-run its checks, if any. */
  rerun: { extension: string; key: string } | null
  /** Databases the runs name, newest first. */
  targets: string[]
}

/** Accepted as `?run=`: a run id is a uuid, nothing else reaches a request path. */
export const RUN_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A run left 'verifying' over two hours has lost its runner (mirrors the server). */
const STALE_VERIFY_MS = 2 * 60 * 60 * 1000

/** Pure: a run still 'verifying' more than two hours after its verify began. */
export function isStaleVerifying(
  run: Pick<QualityRun, 'status' | 'verify_started_at' | 'captured_at' | 'started_at'>,
  now = Date.now()
): boolean {
  if (run.status !== 'verifying') return false
  const since = run.verify_started_at ?? run.captured_at ?? run.started_at
  const t = since ? Date.parse(since) : Number.NaN
  return !Number.isNaN(t) && now - t > STALE_VERIFY_MS
}

/** The quality console's config; `available` false = the tables are not on this database. */
export function useQualityConfig() {
  return useQuery({
    queryKey: ['quality-config'],
    queryFn: () =>
      api
        .get<{ data: QualityConfig; available?: boolean }>('/quality-checks/config')
        .then((r) => ({ ...r.data.data, available: r.data.available !== false })),
    staleTime: 60_000,
    retry: false
  })
}

/** Pure: the target the page shows — the asked one if the runs name it (any case), else the newest. */
export function pickTarget(targets: string[], asked: string | null): string | null {
  if (asked) {
    const hit = targets.find((t) => t.toLowerCase() === asked.toLowerCase())
    if (hit) return hit
  }
  return targets[0] ?? null
}

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
 * Environments → Quality checks: the latest quality run of the newest
 * target in one line, with a link to the full page. Renders nothing when
 * the quality routes are not available here or the tables are not set up.
 */
export function QualityChecksCard() {
  const cfg = useQualityConfig()
  const target = cfg.data ? pickTarget(cfg.data.targets, null) : null
  const q = useQuery({
    queryKey: ['quality-runs', target],
    enabled: !!target,
    queryFn: () =>
      api
        .get<{ data: QualityRun[] }>('/quality-checks/runs', { params: { target } })
        .then((r) => r.data.data),
    refetchInterval: 60_000,
    retry: false
  })
  if (cfg.isLoading || cfg.isError || !cfg.data?.available) return null
  if (target && (q.isLoading || q.isError)) return null
  const latest = q.data?.[0] ?? null
  const stale = !!latest && isStaleVerifying(latest)
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
          No quality run yet — they run inside a real rebuild
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
      ) : stale ? (
        <p className='mt-1 text-[12px] text-amber-700 dark:text-amber-300' data-quality-card-stale>
          The last check stopped without finishing (started {formatRelative(latest.started_at)}) —
          re-run it from the quality checks page
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
