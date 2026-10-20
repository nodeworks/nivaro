import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn, formatDate, formatDateTime, formatNumber } from '@/lib/utils'
import {
  CHECK_LABEL,
  Clip,
  DiffView,
  errorText,
  type FixRow,
  fmtMs,
  objectLabel,
  type PageFixDetail,
  type RunRow,
  type Summary,
  TYPE_LABEL,
  useChartColors,
  useTwoClick
} from './shared'

const PAGE = 25

function Card({
  title,
  children,
  className
}: {
  title: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <section
      className={cn(
        'min-w-0 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card',
        className
      )}
    >
      <h2 className='m-0 mb-3 text-[13px] font-semibold'>{title}</h2>
      {children}
    </section>
  )
}

const tick = { fontSize: 11, fill: 'currentColor' }
const TOOLTIP = {
  fontSize: 12,
  borderRadius: 6,
  background: 'hsl(var(--card))',
  color: 'hsl(var(--foreground))',
  border: '1px solid hsl(var(--border))'
}

// ─── Trends ─────────────────────────────────────────────────────────────────

export function TrendsTab({
  summary,
  onObject
}: {
  summary: Summary
  onObject: (name: string) => void
}) {
  const colors = useChartColors()
  const trend = (summary.trend ?? []).map((t) => ({
    run: `#${t.id}`,
    when: formatDate(t.started_at),
    Critical: t.critical_open,
    Warning: t.warning_open,
    Info: t.info_open,
    New: t.findings_new,
    Resolved: t.findings_resolved
  }))
  const byCheck = Object.entries(summary.by_check ?? {}).sort((a, b) => b[1] - a[1])
  if (!trend.length)
    return (
      <p className='m-0 p-6 text-[12.5px] text-muted-foreground'>
        Trends appear after the first finished run.
      </p>
    )
  const label = `Open findings over the last ${trend.length} runs: from ${
    trend[0].Critical + trend[0].Warning + trend[0].Info
  } to ${trend[trend.length - 1].Critical + trend[trend.length - 1].Warning + trend[trend.length - 1].Info}`
  return (
    <div className='grid gap-4 p-4 sm:p-6 xl:grid-cols-2'>
      <Card title='Open findings per run' className='xl:col-span-2'>
        <div role='img' aria-label={label} className='h-56 text-muted-foreground'>
          <ResponsiveContainer width='100%' height='100%'>
            <AreaChart data={trend} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray='3 3' stroke='currentColor' strokeOpacity={0.12} />
              <XAxis dataKey='when' tick={tick} />
              <YAxis allowDecimals={false} tick={tick} />
              <Tooltip
                contentStyle={TOOLTIP}
                labelFormatter={(_l, p) =>
                  p?.[0]?.payload ? `${p[0].payload.run} · ${p[0].payload.when}` : ''
                }
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area
                type='monotone'
                dataKey='Critical'
                stackId='1'
                stroke={colors.critical}
                fill={colors.critical}
                fillOpacity={0.35}
              />
              <Area
                type='monotone'
                dataKey='Warning'
                stackId='1'
                stroke={colors.warning}
                fill={colors.warning}
                fillOpacity={0.3}
              />
              <Area
                type='monotone'
                dataKey='Info'
                stackId='1'
                stroke={colors.info}
                fill={colors.info}
                fillOpacity={0.25}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <Card title='New and resolved per run'>
        <div
          role='img'
          aria-label={`New and resolved findings per run, last ${trend.length} runs`}
          className='h-48 text-muted-foreground'
        >
          <ResponsiveContainer width='100%' height='100%'>
            <BarChart data={trend} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray='3 3' stroke='currentColor' strokeOpacity={0.12} />
              <XAxis dataKey='when' tick={tick} />
              <YAxis allowDecimals={false} tick={tick} />
              <Tooltip contentStyle={TOOLTIP} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey='New' fill={colors.new} radius={[3, 3, 0, 0]} />
              <Bar dataKey='Resolved' fill={colors.resolved} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <Card title='Open findings by check'>
        {byCheck.length === 0 ? (
          <p className='m-0 text-[12.5px] text-muted-foreground'>None open.</p>
        ) : (
          <ul className='m-0 grid list-none gap-1.5 p-0 text-[12.5px]'>
            {byCheck.map(([k, n]) => (
              <li key={k} className='flex items-center justify-between gap-3'>
                <Clip text={CHECK_LABEL[k] ?? k} />
                <span className='shrink-0 font-semibold tabular-nums'>{formatNumber(n)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title='Objects with the most open findings' className='xl:col-span-2'>
        {(summary.top_objects ?? []).length === 0 ? (
          <p className='m-0 text-[12.5px] text-muted-foreground'>None open.</p>
        ) : (
          <ul className='m-0 grid list-none gap-1 p-0 text-[12.5px]'>
            {(summary.top_objects ?? []).map((o) => (
              <li key={`${o.object_type}:${o.object_schema}:${o.object_name}`}>
                <button
                  type='button'
                  onClick={() => onObject(o.object_name)}
                  className='flex w-full min-w-0 items-center gap-3 rounded px-1 py-0.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                >
                  <span className='w-28 shrink-0 text-[11.5px] text-muted-foreground'>
                    {TYPE_LABEL[o.object_type]}
                  </span>
                  <Clip text={objectLabel(o)} className='flex-1 font-mono' />
                  <span className='shrink-0 font-semibold tabular-nums'>{o.n}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

// ─── shared table shell ─────────────────────────────────────────────────────

function Pager({
  page,
  total,
  onPage
}: {
  page: number
  total: number
  onPage: (p: number) => void
}) {
  const pages = Math.max(1, Math.ceil(total / PAGE))
  if (pages <= 1) return null
  return (
    <div className='flex items-center justify-end gap-2 pt-3 text-[12px]'>
      <span className='text-muted-foreground'>
        Page {page} of {pages}
      </span>
      <Button
        size='sm'
        variant='outline'
        className='h-7 px-2 text-[12px]'
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        Previous
      </Button>
      <Button
        size='sm'
        variant='outline'
        className='h-7 px-2 text-[12px]'
        disabled={page >= pages}
        onClick={() => onPage(page + 1)}
      >
        Next
      </Button>
    </div>
  )
}

const th =
  'px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground'
const td = 'px-3 py-2 align-top'

// ─── Fixes ──────────────────────────────────────────────────────────────────

/** Outcome, diff and Revert for a procedure fix applied from the SQL checks page (#2563). */
function PageFix({ row }: { row: FixRow }) {
  const qc = useQueryClient()
  const d = (row.detail ?? {}) as PageFixDetail
  const [showDiff, setShowDiff] = useState(false)
  const [armed, setArmed] = useTwoClick()
  const [status, setStatus] = useState('')
  const revert = useMutation({
    mutationFn: () =>
      api
        .post<{ data: { reverted: boolean; skipped_import_bodies?: string[] } }>(
          `/sql-checks/fixes/${row.id}/revert`
        )
        .then((r) => r.data.data),
    onSuccess: (r) => {
      const n = r.skipped_import_bodies?.length ?? 0
      const msg = n
        ? `Previous version restored. ${n} import definition ${n === 1 ? 'body was' : 'bodies were'} edited since and ${n === 1 ? 'was' : 'were'} left as ${n === 1 ? 'it is' : 'they are'}.`
        : 'Previous version restored'
      setStatus(msg)
      toast.success(msg)
      void qc.invalidateQueries({ queryKey: ['sql-checks'] })
    },
    onError: (err) => {
      const msg = errorText(err, 'Couldn’t revert this fix.')
      setStatus(msg)
      toast.error(msg)
    }
  })
  const state = d.reverted
    ? `Reverted${d.reverted_by ? ` by ${d.reverted_by}` : ''}`
    : d.applied
      ? d.deployed
        ? 'Applied and checked'
        : 'Stored body saved (not deployed)'
      : d.rolled_back
        ? `Put back automatically: ${d.rollback_reason ?? 'the re-check was not clean'}`
        : d.error
          ? `Failed: ${d.error}`
          : d.rollback_error
            ? `Rollback failed: ${d.rollback_error}`
            : 'Not applied'
  return (
    <div className='mt-1 grid gap-1 font-sans'>
      <span
        className={cn(
          'text-[11.5px]',
          d.applied && !d.reverted
            ? 'text-emerald-700 dark:text-emerald-400'
            : d.rollback_error || d.error
              ? 'text-red-600 dark:text-red-400'
              : 'text-muted-foreground'
        )}
      >
        {state}
      </span>
      <span className='sr-only' role='status' aria-live='polite'>
        {status}
      </span>
      <div className='flex flex-wrap items-center gap-2'>
        {(d.diff?.length ?? 0) > 0 && (
          <button
            type='button'
            aria-expanded={showDiff}
            onClick={() => setShowDiff((v) => !v)}
            className='rounded text-[11.5px] text-nvr-cyan hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
          >
            {showDiff ? 'Hide diff' : 'View diff'}
          </button>
        )}
        {(d.applied || !!d.rollback_error) && !d.reverted && !!d.applied_definition_hash && (
          <Button
            size='sm'
            variant='outline'
            className={cn(
              'h-6 px-2 text-[11.5px]',
              armed && 'border-amber-500 text-amber-700 dark:text-amber-300'
            )}
            disabled={revert.isPending}
            onClick={() => {
              if (!armed) return setArmed(true)
              setArmed(false)
              revert.mutate()
            }}
          >
            {revert.isPending
              ? 'Restoring…'
              : armed
                ? d.applied
                  ? 'Click again to revert'
                  : 'Click again to restore'
                : d.applied
                  ? 'Revert'
                  : 'Restore previous version'}
          </Button>
        )}
      </div>
      {showDiff && d.diff && (
        <div className='max-w-[640px]'>
          <DiffView hunks={d.diff} label={`Change made by fix ${row.id}`} />
        </div>
      )}
    </div>
  )
}

const ACTION_LABEL: Record<FixRow['action'], string> = {
  cleanup: 'Cleanup',
  proc_fix: 'Procedure changed',
  guard_index: 'Guard index',
  other: 'Other'
}

export function FixesTab() {
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState<number | null>(null)
  const q = useQuery({
    queryKey: ['sql-checks', 'fixes', page],
    queryFn: () =>
      api
        .get<{ data: FixRow[]; meta: { total: number } }>('/sql-checks/fixes', {
          params: { page, limit: PAGE }
        })
        .then((r) => r.data),
    placeholderData: (p) => p
  })
  if (q.isLoading)
    return (
      <div className='p-6' role='status' aria-label='Loading fixes'>
        <Skeleton className='h-24' />
      </div>
    )
  if (q.isError)
    return (
      <p className='m-0 p-6 text-[12.5px] text-red-600 dark:text-red-400'>
        {errorText(q.error, 'Couldn’t load the fixes.')}
      </p>
    )
  const rows = q.data?.data ?? []
  return (
    <div className='p-4 sm:p-6'>
      <p className='m-0 mb-3 max-w-[80ch] text-[12.5px] text-muted-foreground'>
        Cleanups and guard indexes are logged by the fix scripts that apply them. “Procedure
        changed” is logged when a fix is applied from a finding (with its diff and a Revert), or
        when a run finds that findings went away because their procedure or query was edited.
      </p>
      {rows.length === 0 ? (
        <p className='m-0 text-[12.5px] text-muted-foreground'>No fixes recorded yet.</p>
      ) : (
        <div className='overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
          <table className='w-full min-w-[720px] text-[12px]'>
            <thead className='border-b border-slate-200 dark:border-border'>
              <tr>
                <th className={th}>When</th>
                <th className={th}>Action</th>
                <th className={th}>Target</th>
                <th className={cn(th, 'text-right')}>Rows</th>
                <th className={th}>Backup</th>
                <th className={th}>By</th>
              </tr>
            </thead>
            <tbody className='divide-y divide-slate-100 dark:divide-border'>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className={cn(td, 'whitespace-nowrap')}>{formatDateTime(r.created_at)}</td>
                  <td className={td}>
                    {ACTION_LABEL[r.action]}
                    {r.check_key && (
                      <div className='text-[11px] text-muted-foreground'>
                        {CHECK_LABEL[r.check_key] ?? r.check_key}
                      </div>
                    )}
                  </td>
                  <td className={cn(td, 'font-mono')}>
                    {r.target_table ?? r.target_object ?? '—'}
                    {(r.detail as PageFixDetail | null)?.source === 'sql-checks-page' ? (
                      <PageFix row={r} />
                    ) : (
                      r.detail && (
                        <div>
                          <button
                            type='button'
                            aria-expanded={open === r.id}
                            onClick={() => setOpen(open === r.id ? null : r.id)}
                            className='mt-1 rounded font-sans text-[11.5px] text-nvr-cyan hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                          >
                            {open === r.id ? 'Hide details' : 'Details'}
                          </button>
                          {open === r.id && (
                            <pre className='m-0 mt-1 max-h-60 max-w-[480px] overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-[11px] dark:bg-muted'>
                              {JSON.stringify(r.detail, null, 2)}
                            </pre>
                          )}
                        </div>
                      )
                    )}
                  </td>
                  <td className={cn(td, 'text-right tabular-nums')}>
                    {r.rows_affected == null ? '—' : formatNumber(r.rows_affected)}
                  </td>
                  <td className={cn(td, 'font-mono text-[11.5px]')}>{r.backup_table ?? '—'}</td>
                  <td className={td}>{r.run_by ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager page={page} total={q.data?.meta.total ?? 0} onPage={setPage} />
    </div>
  )
}

// ─── Runs ───────────────────────────────────────────────────────────────────

const RUN_STATUS: Record<RunRow['status'], string> = {
  running: 'text-nvr-cyan',
  ok: 'text-emerald-700 dark:text-emerald-400',
  failed: 'text-red-600 dark:text-red-400'
}

export function RunsTab() {
  const [page, setPage] = useState(1)
  const q = useQuery({
    queryKey: ['sql-checks', 'runs', page],
    queryFn: () =>
      api
        .get<{ data: RunRow[]; meta: { total: number } }>('/sql-checks/runs', {
          params: { page, limit: PAGE }
        })
        .then((r) => r.data),
    placeholderData: (p) => p,
    refetchInterval: (query) =>
      query.state.data?.data.some((r) => r.status === 'running') ? 5000 : false
  })
  if (q.isLoading)
    return (
      <div className='p-6' role='status' aria-label='Loading runs'>
        <Skeleton className='h-24' />
      </div>
    )
  if (q.isError)
    return (
      <p className='m-0 p-6 text-[12.5px] text-red-600 dark:text-red-400'>
        {errorText(q.error, 'Couldn’t load the runs.')}
      </p>
    )
  const rows = q.data?.data ?? []
  return (
    <div className='p-4 sm:p-6'>
      {rows.length === 0 ? (
        <p className='m-0 text-[12.5px] text-muted-foreground'>No runs yet.</p>
      ) : (
        <div className='overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
          <table className='w-full min-w-[760px] text-[12px]'>
            <thead className='border-b border-slate-200 dark:border-border'>
              <tr>
                <th className={th}>Run</th>
                <th className={th}>Started</th>
                <th className={th}>Status</th>
                <th className={cn(th, 'text-right')}>Took</th>
                <th className={cn(th, 'text-right')}>Objects</th>
                <th className={cn(th, 'text-right')}>Findings</th>
                <th className={cn(th, 'text-right')}>New</th>
                <th className={cn(th, 'text-right')}>Resolved</th>
                <th className={th}>SQLFluff</th>
              </tr>
            </thead>
            <tbody className='divide-y divide-slate-100 dark:divide-border'>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className={cn(td, 'tabular-nums')}>
                    #{r.id}
                    <div className='text-[11px] text-muted-foreground'>
                      {r.trigger === 'cron' ? 'Nightly' : 'Manual'}
                    </div>
                  </td>
                  <td className={cn(td, 'whitespace-nowrap')}>{formatDateTime(r.started_at)}</td>
                  <td className={td}>
                    <span className={cn('font-medium capitalize', RUN_STATUS[r.status])}>
                      {r.status === 'ok' ? 'Finished' : r.status}
                    </span>
                    {r.error && (
                      <div className='max-w-[320px] break-words text-[11.5px] text-red-600 dark:text-red-400'>
                        {r.error}
                      </div>
                    )}
                    {(r.stats?.skipped_tables?.length ?? 0) > 0 && (
                      <div
                        className='text-[11px] text-muted-foreground'
                        data-tip={r.stats?.skipped_tables?.join('\n')}
                      >
                        Counts skipped on {r.stats?.skipped_tables?.length} large tables
                      </div>
                    )}
                  </td>
                  <td className={cn(td, 'text-right tabular-nums')}>{fmtMs(r.duration_ms)}</td>
                  <td className={cn(td, 'text-right tabular-nums')}>
                    {formatNumber(r.objects_scanned)}
                  </td>
                  <td className={cn(td, 'text-right tabular-nums')}>
                    {formatNumber(r.findings_total)}
                  </td>
                  <td className={cn(td, 'text-right tabular-nums')}>
                    {formatNumber(r.findings_new)}
                  </td>
                  <td className={cn(td, 'text-right tabular-nums')}>
                    {formatNumber(r.findings_resolved)}
                  </td>
                  <td className={td}>
                    {r.sqlfluff === 'on'
                      ? 'Ran'
                      : r.sqlfluff === 'unavailable'
                        ? 'Unavailable'
                        : 'Off'}
                    {r.sqlfluff === 'on' && r.stats?.sqlfluff && (
                      <div className='text-[11px] text-muted-foreground'>
                        {r.stats.sqlfluff.linted} linted
                        {r.stats.sqlfluff.timeouts
                          ? `, ${r.stats.sqlfluff.timeouts} timed out`
                          : ''}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager page={page} total={q.data?.meta.total ?? 0} onPage={setPage} />
    </div>
  )
}
