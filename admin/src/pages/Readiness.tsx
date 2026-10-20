import { useLiveOps } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, CircleSlash, Loader2, RefreshCw, XCircle } from 'lucide-react'
import { useRef } from 'react'
import { toast } from 'sonner'
import { ExplainButton } from '@/components/explain-button'
import { Button } from '@/components/ui/button'
import { WeeklySummaryToggle } from '@/components/weekly-summary-toggle'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

/**
 * Go-live readiness scorecard. The checks come from the deployment's
 * extension (e.g. legacy-system writes, cron takeover flags, id-sequence
 * margins, non-production hosts…); this page renders them, grouped, with the blockers
 * spelled out. A plain read is the server's stored results (each with the time it
 * ran; stale ones refresh in the background and arrive over the live-ops socket);
 * Re-run checks asks for `fresh=1`, which runs everything live.
 */

interface Check {
  id: string
  label: string
  description?: string
  group?: string
  status: 'pass' | 'warn' | 'fail' | 'skip' | 'error' | 'pending'
  detail?: string
  blockers?: string[]
  remediation_label?: string
  duration_ms: number
  /** When the server evaluated it; null while pending. */
  computed_at?: string | null
  stale?: boolean
}

interface RemediationJob {
  check_id: string
  status: 'running' | 'completed' | 'error'
  detail?: string
  finished_at?: string
}

interface Report {
  score: number | null
  counts: Record<string, number>
  checks: Check[]
  /** The oldest result in the report. */
  computed_at?: string | null
  stale?: boolean
  refreshing?: boolean
}

const STATUS_META: Record<
  Check['status'],
  { icon: typeof CheckCircle2; cls: string; label: string }
> = {
  pass: { icon: CheckCircle2, cls: 'text-emerald-600 dark:text-emerald-400', label: 'Pass' },
  warn: { icon: AlertTriangle, cls: 'text-amber-600 dark:text-amber-400', label: 'Warning' },
  fail: { icon: XCircle, cls: 'text-red-600 dark:text-red-400', label: 'Blocking' },
  error: { icon: XCircle, cls: 'text-red-600 dark:text-red-400', label: 'Check failed' },
  skip: { icon: CircleSlash, cls: 'text-slate-400', label: 'Not applicable' },
  pending: { icon: Loader2, cls: 'text-slate-400', label: 'Checking' }
}

export default function Readiness() {
  // Re-run checks sets this for the one read it triggers: fresh=1 runs every
  // check live; every other read (mount, refocus, polling) takes the stored results.
  const freshNext = useRef(false)
  const { data, isFetching, refetch } = useQuery<Report>({
    queryKey: ['readiness'],
    queryFn: () => {
      const fresh = freshNext.current
      freshNext.current = false
      return api
        .get<{ data: Report }>('/readiness', { params: fresh ? { fresh: 1 } : undefined })
        .then((r) => r.data.data)
    },
    staleTime: 60_000,
    retry: false,
    // A background refresh lands over the socket; polling covers a page without one.
    refetchInterval: (q) => (q.state.data?.refreshing ? 5_000 : false)
  })
  const rerun = () => {
    freshNext.current = true
    void refetch()
  }

  const qc = useQueryClient()
  // Server-held remediation jobs — polling survives navigation, so a fix
  // started here keeps reporting after the admin wanders off and back.
  const { data: remediations = [] } = useQuery<RemediationJob[]>({
    queryKey: ['readiness-remediations'],
    queryFn: () =>
      api.get<{ data: RemediationJob[] }>('/readiness/remediations').then((r) => r.data.data),
    refetchInterval: (q) => (q.state.data?.some((j) => j.status === 'running') ? 2_500 : false),
    retry: false
  })
  const startedHere = useRef(new Set<string>())
  // Live: another admin's re-run lands here as the finished report (set, never refetched —
  // a refetch would re-run every check and the two pages would trigger each other), and a
  // fix finishing anywhere refreshes the job list.
  useLiveOps('readiness', (d) => {
    if (d.report) qc.setQueryData(['readiness'], d.report as Report)
    if (d.remediation) {
      void qc.invalidateQueries({ queryKey: ['readiness-remediations'] })
      // Only the tab that started the fix re-runs the checks to show its effect; the run
      // is broadcast, so every other open page picks the new results up from it.
      const id = String(d.remediation.check_id)
      if (d.remediation.status !== 'running' && startedHere.current.delete(id)) void refetch()
    }
  })
  const remediate = useMutation({
    mutationFn: (checkId: string) => api.post(`/readiness/${checkId}/remediate`, {}),
    onSuccess: (_r, checkId) => {
      startedHere.current.add(checkId)
      toast.success('Fix started — running in the background')
      void qc.invalidateQueries({ queryKey: ['readiness-remediations'] })
    },
    onError: (err: Error) => toast.error(err.message)
  })

  const { data: trend = [] } = useQuery<Array<{ snapshot_date: string; score: number | null }>>({
    queryKey: ['readiness-trend'],
    queryFn: () =>
      api
        .get<{ data: Array<{ snapshot_date: string; score: number | null }> }>('/readiness/trend')
        .then((r) => r.data.data),
    staleTime: 5 * 60_000,
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
              Continuously answerable: can we cut over? Each check shows when it last ran; a result
              past its window re-runs in the background, and Re-run checks runs them all live now.
            </p>
          </div>
          <div className='flex items-center gap-3'>
            <WeeklySummaryToggle />
            {data?.computed_at && (
              <span
                className='text-[11.5px] text-slate-400'
                data-tip={`Oldest result: ${new Date(data.computed_at).toLocaleString()}`}
              >
                checked {formatRelative(data.computed_at)}
                {data.refreshing ? ' · refreshing…' : ''}
              </span>
            )}
            <Button size='sm' variant='outline' disabled={isFetching} onClick={rerun}>
              <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} /> Re-run
              checks
            </Button>
          </div>
        </div>
      </header>

      <div className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
        <div className='max-w-[880px] space-y-4'>
          {!data && isFetching && <p className='text-[12.5px] text-slate-400'>Running checks…</p>}
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
                  {data.score == null && (data.counts.pending ?? 0) > 0
                    ? 'Checking…'
                    : data.score == null
                      ? 'No scoreable checks'
                      : data.score === 100
                        ? 'Ready to cut over'
                        : `${data.score}% ready`}
                </p>
                <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
                  {data.counts.pass ?? 0} passing · {data.counts.warn ?? 0} warning
                  {(data.counts.warn ?? 0) === 1 ? '' : 's'} ·{' '}
                  {(data.counts.fail ?? 0) + (data.counts.error ?? 0)} blocking
                  {(data.counts.pending ?? 0) > 0 && ` · ${data.counts.pending} still running`}
                </p>
              </div>
              {trend.length >= 2 && (
                <div className='ml-auto text-right'>
                  <TrendLine points={trend} />
                  <p className='mt-1 text-[10.5px] text-slate-400'>
                    daily score · {trend.length} snapshot{trend.length === 1 ? '' : 's'}
                  </p>
                </div>
              )}
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
                        <Icon
                          className={cn(
                            'mt-0.5 h-4 w-4 shrink-0',
                            meta.cls,
                            c.status === 'pending' && 'animate-spin'
                          )}
                        />
                        <div className='min-w-0 flex-1'>
                          <p className='text-[13px] font-medium text-slate-800 dark:text-foreground'>
                            {c.label}
                            <span className={cn('ml-2 text-[11px] font-normal', meta.cls)}>
                              {meta.label}
                            </span>
                            {c.stale && c.computed_at && (
                              <span className='ml-2 text-[11px] font-normal text-slate-400'>
                                as of {formatRelative(c.computed_at)} · refreshing
                              </span>
                            )}
                          </p>
                          {c.detail && (
                            <p className='mt-0.5 text-[12px] text-slate-600 dark:text-muted-foreground'>
                              {c.detail}
                            </p>
                          )}
                          {(c.status === 'warn' || c.status === 'fail') && (
                            <div className='mt-2'>
                              <ExplainButton
                                kind='readiness'
                                params={{ id: c.id }}
                                label='How to fix this'
                              />
                            </div>
                          )}
                          {c.description && (
                            <p className='mt-0.5 text-[11.5px] leading-snug text-slate-400'>
                              {c.description}
                            </p>
                          )}
                          {(() => {
                            const job = remediations.find((j) => j.check_id === c.id)
                            if (!c.remediation_label && !job) return null
                            return (
                              <div className='mt-2 flex flex-wrap items-center gap-2'>
                                {c.remediation_label && c.status !== 'pass' && (
                                  <Button
                                    size='sm'
                                    variant='outline'
                                    className='h-6 px-2 text-[11.5px]'
                                    disabled={job?.status === 'running' || remediate.isPending}
                                    onClick={() => remediate.mutate(c.id)}
                                  >
                                    {job?.status === 'running' ? (
                                      <>
                                        <RefreshCw className='h-3 w-3 animate-spin' /> Fixing…
                                      </>
                                    ) : (
                                      c.remediation_label
                                    )}
                                  </Button>
                                )}
                                {job && job.status !== 'running' && (
                                  <span
                                    className={cn(
                                      'text-[11.5px]',
                                      job.status === 'completed'
                                        ? 'text-emerald-600 dark:text-emerald-400'
                                        : 'text-red-600 dark:text-red-400'
                                    )}
                                  >
                                    {job.detail}
                                    {job.status === 'completed' && (
                                      <button
                                        type='button'
                                        onClick={() => refetch()}
                                        className='ml-1.5 underline decoration-dotted underline-offset-2'
                                      >
                                        re-check
                                      </button>
                                    )}
                                  </span>
                                )}
                              </div>
                            )
                          })()}
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
      <circle
        cx='34'
        cy='34'
        r={r}
        strokeWidth='6'
        fill='none'
        className='stroke-slate-100 dark:stroke-border'
      />
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

/** Daily readiness score, oldest → newest — the line that should climb
 *  toward 100 as cutover approaches. */
function TrendLine({ points }: { points: Array<{ snapshot_date: string; score: number | null }> }) {
  const pts = points.filter((p) => p.score != null).slice(-30)
  if (pts.length < 2) return null
  const w = 160
  const h = 40
  const line = pts
    .map(
      (p, i) =>
        `${(i / (pts.length - 1)) * (w - 4) + 2},${h - 3 - ((p.score ?? 0) / 100) * (h - 6)}`
    )
    .join(' ')
  const last = pts[pts.length - 1]
  return (
    <svg width={w} height={h} className='overflow-visible'>
      <title>
        {pts[0].snapshot_date}: {pts[0].score} → {last.snapshot_date}: {last.score}
      </title>
      <polyline
        points={line}
        fill='none'
        strokeWidth='2'
        strokeLinecap='round'
        className={
          (last.score ?? 0) >= (pts[0].score ?? 0) ? 'stroke-emerald-500' : 'stroke-amber-500'
        }
      />
    </svg>
  )
}
