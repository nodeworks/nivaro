import { useQuery, useQueryClient } from '@tanstack/react-query'
import { adminRealtime, joinWatchRoom } from '@/lib/socket'
import { Activity, Play, RotateCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

/**
 * Background Jobs — the one console for everything that runs behind the
 * scenes: cron ticks, readiness remediations, materialization backfills,
 * rollup recalcs. Roster + latest outcomes from the live registry; history
 * from nivaro_job_runs.
 */

interface CronEntry {
  id: string
  expression: string
  extension_id: string | null
  next_run: string | null
  errors_7d: number
  last: {
    status: string
    started_at: string
    duration_ms: number | null
    outcome: string | null
    error: string | null
  } | null
}

interface JobRun {
  id: number
  kind: string
  job_id: string
  label: string | null
  extension_id: string | null
  status: string
  started_at: string
  finished_at: string | null
  duration_ms: number | null
  outcome: string | null
  error: string | null
  progress: string | null
  triggered_by_name: string | null
}

const KINDS = ['', 'cron', 'remediation', 'backfill', 'recalc', 'monitor'] as const

function fmtDur(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

function relFuture(ts: string | null | undefined): string {
  if (!ts) return '—'
  const diff = new Date(ts).getTime() - Date.now()
  if (diff <= 0) return 'due now'
  if (diff < 60_000) return 'in <1m'
  if (diff < 3_600_000) return `in ${Math.round(diff / 60_000)}m`
  if (diff < 86_400_000) return `in ${Math.floor(diff / 3_600_000)}h ${Math.round((diff % 3_600_000) / 60_000)}m`
  return `in ${Math.floor(diff / 86_400_000)}d`
}

function rel(ts: string | null | undefined): string {
  if (!ts) return '—'
  const diff = Date.now() - new Date(ts).getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function StatusPill({ status, staleRunning }: { status: string; staleRunning?: boolean }) {
  const cls =
    status === 'completed'
      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
      : status === 'error'
        ? 'bg-red-500/10 text-red-700 dark:text-red-400'
        : staleRunning
          ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
          : 'bg-sky-500/10 text-sky-700 dark:text-sky-400'
  return (
    <span className={cn('rounded px-1.5 py-px text-[10.5px] font-medium uppercase', cls)}>
      {staleRunning ? 'stale' : status}
    </span>
  )
}

export default function BackgroundJobs() {
  const qc = useQueryClient()
  const [kind, setKind] = useState('')
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [running, setRunning] = useState<string | null>(null)

  const registry = useQuery({
    queryKey: ['job-registry'],
    queryFn: () => api.get('/job-runs/registry').then((r) => r.data.data),
    refetchInterval: 10_000
  })
  const runs = useQuery({
    queryKey: ['job-runs', kind, status, search, page],
    queryFn: () =>
      api
        .get('/job-runs', {
          params: {
            kind: kind || undefined,
            status: status || undefined,
            job_id: search || undefined,
            page
          }
        })
        .then((r) => r.data),
    refetchInterval: 15_000
  })

  // Live job progress (#271): while this page is open, join the jobs watch
  // room — every run start/progress/finish refreshes the lists immediately.
  useEffect(() => {
    const leave = joinWatchRoom('jobs')
    const off = adminRealtime.on('job:update', () => {
      void qc.invalidateQueries({ queryKey: ['job-runs'] })
      void qc.invalidateQueries({ queryKey: ['job-registry'] })
    })
    return () => {
      off()
      leave()
    }
  }, [qc])

  const crons: CronEntry[] = registry.data?.crons ?? []
  const activeRuns: JobRun[] = (registry.data?.running ?? []).filter(
    // A run stuck 'running' for over an hour is a dead process's orphan, not
    // active work — it belongs in history with a stale badge, not up here.
    (r: JobRun) => Date.now() - new Date(r.started_at).getTime() < 3_600_000
  )
  const erroring = crons.filter((c) => c.errors_7d > 0).length
  const cronGroups = useMemo(() => {
    const core = crons.filter((c) => !c.extension_id)
    const byExt = new Map<string, CronEntry[]>()
    for (const c of crons) {
      if (!c.extension_id) continue
      byExt.set(c.extension_id, [...(byExt.get(c.extension_id) ?? []), c])
    }
    return { core, byExt }
  }, [crons])

  const runNow = async (id: string) => {
    setRunning(id)
    try {
      const r = await api.post(`/cron/${id}/run`)
      toast.success(`${id} ran in ${fmtDur(r.data.data?.duration_ms)}`)
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Run failed'
      toast.error(msg, { duration: 10000 })
    } finally {
      setRunning(null)
      void registry.refetch()
      void runs.refetch()
    }
  }

  const rows: JobRun[] = runs.data?.data ?? []
  const total = runs.data?.total ?? 0

  const cronTable = (list: CronEntry[]) => (
    <table className="w-full text-[12px]">
      <thead>
        <tr className="text-left text-[10.5px] uppercase tracking-wide text-slate-400">
          <th className="py-1 pr-3 font-semibold">Job</th>
          <th className="py-1 pr-3 font-semibold">Schedule</th>
          <th className="py-1 pr-3 font-semibold">Last run</th>
          <th className="py-1 pr-3 font-semibold">Duration</th>
          <th className="py-1 pr-3 font-semibold">Next</th>
          <th className="py-1 pr-3 font-semibold">7d errors</th>
          <th className="py-1 font-semibold" />
        </tr>
      </thead>
      <tbody>
        {list.map((c) => (
          <tr key={c.id} className="border-t border-slate-100 dark:border-border">
            <td className="py-1.5 pr-3 font-mono text-[11.5px] text-slate-700 dark:text-foreground">
              {c.id}
            </td>
            <td className="py-1.5 pr-3 font-mono text-[11px] text-slate-400">{c.expression}</td>
            <td className="py-1.5 pr-3">
              {c.last ? (
                <span className="flex items-center gap-1.5" title={c.last.error ?? c.last.outcome ?? ''}>
                  <StatusPill status={c.last.status} />
                  <span className="text-slate-500 dark:text-muted-foreground">
                    {rel(c.last.started_at)}
                  </span>
                </span>
              ) : (
                <span className="text-slate-300">never recorded</span>
              )}
            </td>
            <td className="py-1.5 pr-3 text-slate-500 dark:text-muted-foreground">
              {fmtDur(c.last?.duration_ms)}
            </td>
            <td
              className="py-1.5 pr-3 text-slate-500 dark:text-muted-foreground"
              title={c.next_run ? new Date(c.next_run).toLocaleString() : ''}
            >
              {relFuture(c.next_run)}
            </td>
            <td className="py-1.5 pr-3">
              {c.errors_7d > 0 ? (
                <span className="font-medium text-red-600 dark:text-red-400">{c.errors_7d}</span>
              ) : (
                <span className="text-slate-300">0</span>
              )}
            </td>
            <td className="py-1.5 text-right">
              <button
                type="button"
                disabled={running === c.id}
                onClick={() => runNow(c.id)}
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 hover:border-slate-300 hover:text-slate-800 disabled:opacity-50 dark:border-border dark:text-muted-foreground"
              >
                <Play className="h-3 w-3" strokeWidth={2} />
                {running === c.id ? 'Running…' : 'Run now'}
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <header className="shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card">
        <div className="flex items-center gap-2.5">
          <Activity className="h-5 w-5 text-muted-foreground" />
          <div>
            <h1 className="text-[17px] font-semibold text-slate-900 dark:text-foreground">
              Background Jobs
            </h1>
            <p className="mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground">
              Everything running behind the scenes — cron jobs, remediations, backfills, recalcs —
              with outcomes, durations, and history in one place.
            </p>
          </div>
        </div>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto p-6">
        {/* stat strip */}
        <div className="flex flex-wrap gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border">
          {[
            { label: 'Running now', value: activeRuns.length },
            { label: 'Scheduled jobs', value: crons.length },
            { label: 'Jobs with 7-day errors', value: erroring, warn: erroring > 0 },
            { label: 'Runs recorded', value: total }
          ].map((s) => (
            <div key={s.label} className="min-w-[150px] flex-1 bg-white px-4 py-3 dark:bg-card">
              <p className="text-[10.5px] font-semibold uppercase tracking-wide text-slate-400">
                {s.label}
              </p>
              <p
                className={cn(
                  'mt-0.5 text-[20px] font-semibold tabular-nums',
                  s.warn ? 'text-red-600 dark:text-red-400' : 'text-slate-800 dark:text-foreground'
                )}
              >
                {s.value}
              </p>
            </div>
          ))}
        </div>

        {/* active */}
        {activeRuns.length > 0 && (
          <div className="rounded-lg border border-sky-200 bg-sky-50/50 p-4 dark:border-sky-500/30 dark:bg-sky-500/5">
            <p className="text-[12.5px] font-semibold text-slate-800 dark:text-foreground">
              Running now
            </p>
            {activeRuns.map((r) => {
              const prog = r.progress ? (JSON.parse(r.progress) as Record<string, unknown>) : null
              return (
                <p key={r.id} className="mt-1 text-[12px] text-slate-600 dark:text-muted-foreground">
                  <span className="font-mono text-[11.5px]">{r.job_id}</span>
                  {r.label && ` · ${r.label}`} · started {rel(r.started_at)}
                  {prog && ` · ${Object.entries(prog).map(([k, v]) => `${k} ${v}`).join(', ')}`}
                </p>
              )
            })}
          </div>
        )}

        {/* cron roster */}
        <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card">
          <p className="text-[13px] font-semibold text-slate-800 dark:text-foreground">Core jobs</p>
          <div className="mt-2 overflow-x-auto">{cronTable(cronGroups.core)}</div>
          {[...cronGroups.byExt.entries()].map(([ext, list]) => (
            <div key={ext} className="mt-4">
              <p className="text-[13px] font-semibold text-slate-800 dark:text-foreground">
                Extension: <span className="font-mono text-[12px]">{ext}</span>
              </p>
              <div className="mt-2 overflow-x-auto">{cronTable(list)}</div>
            </div>
          ))}
        </div>

        {/* history */}
        <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card">
          <div className="flex flex-wrap items-center gap-2">
            <p className="mr-auto text-[13px] font-semibold text-slate-800 dark:text-foreground">
              Run history
            </p>
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(1)
              }}
              placeholder="Filter by job id…"
              className="h-7 w-[180px] rounded-md border border-slate-200 bg-background px-2 text-[12px] dark:border-border"
            />
            <span className="flex rounded-md border border-slate-200 p-0.5 dark:border-border">
              {KINDS.map((k) => (
                <button
                  key={k || 'all'}
                  type="button"
                  onClick={() => {
                    setKind(k)
                    setPage(1)
                  }}
                  className={cn(
                    'rounded px-2 py-0.5 text-[11px] font-medium capitalize',
                    kind === k
                      ? 'bg-nvr-cyan/10 text-slate-800 dark:text-foreground'
                      : 'text-slate-400 hover:text-slate-600'
                  )}
                >
                  {k || 'All'}
                </button>
              ))}
            </span>
            <span className="flex rounded-md border border-slate-200 p-0.5 dark:border-border">
              {['', 'completed', 'error', 'running'].map((st) => (
                <button
                  key={st || 'all'}
                  type="button"
                  onClick={() => {
                    setStatus(st)
                    setPage(1)
                  }}
                  className={cn(
                    'rounded px-2 py-0.5 text-[11px] font-medium capitalize',
                    status === st
                      ? 'bg-nvr-cyan/10 text-slate-800 dark:text-foreground'
                      : 'text-slate-400 hover:text-slate-600'
                  )}
                >
                  {st || 'Any status'}
                </button>
              ))}
            </span>
            <button
              type="button"
              onClick={() => void runs.refetch()}
              className="rounded-md border border-slate-200 p-1 text-slate-400 hover:text-slate-600 dark:border-border"
              title="Refresh"
            >
              <RotateCw className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          </div>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-[10.5px] uppercase tracking-wide text-slate-400">
                  <th className="py-1 pr-3 font-semibold">Job</th>
                  <th className="py-1 pr-3 font-semibold">Kind</th>
                  <th className="py-1 pr-3 font-semibold">Status</th>
                  <th className="py-1 pr-3 font-semibold">Started</th>
                  <th className="py-1 pr-3 font-semibold">Duration</th>
                  <th className="py-1 pr-3 font-semibold">By</th>
                  <th className="py-1 font-semibold">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const staleRunning =
                    r.status === 'running' &&
                    Date.now() - new Date(r.started_at).getTime() > 3_600_000
                  return (
                    <tr key={r.id} className="border-t border-slate-100 align-top dark:border-border">
                      <td className="py-1.5 pr-3 font-mono text-[11.5px] text-slate-700 dark:text-foreground">
                        {r.job_id}
                      </td>
                      <td className="py-1.5 pr-3 text-slate-500 dark:text-muted-foreground">
                        {r.kind}
                        {r.extension_id && (
                          <span className="ml-1 text-[10.5px] text-slate-400">({r.extension_id})</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3">
                        <StatusPill status={r.status} staleRunning={staleRunning} />
                      </td>
                      <td
                        className="py-1.5 pr-3 text-slate-500 dark:text-muted-foreground"
                        title={new Date(r.started_at).toLocaleString()}
                      >
                        {rel(r.started_at)}
                      </td>
                      <td className="py-1.5 pr-3 tabular-nums text-slate-500 dark:text-muted-foreground">
                        {fmtDur(r.duration_ms)}
                      </td>
                      <td className="py-1.5 pr-3 text-slate-500 dark:text-muted-foreground">
                        {r.triggered_by_name || 'schedule'}
                      </td>
                      <td className="max-w-[380px] py-1.5">
                        {r.error ? (
                          <span className="break-words text-[11.5px] text-red-600 dark:text-red-400">
                            {r.error.split('\n')[0].slice(0, 300)}
                          </span>
                        ) : (
                          <span className="break-words text-[11.5px] text-slate-500 dark:text-muted-foreground">
                            {r.outcome ?? '—'}
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-6 text-center text-[12px] text-slate-400">
                      {runs.isLoading ? 'Loading…' : 'No runs match.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {total > 50 && (
            <div className="mt-2 flex items-center justify-end gap-2 text-[12px] text-slate-500">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className="rounded border border-slate-200 px-2 py-0.5 disabled:opacity-40 dark:border-border"
              >
                Prev
              </button>
              <span>
                {page} / {Math.max(1, Math.ceil(total / 50))}
              </span>
              <button
                type="button"
                disabled={page >= Math.ceil(total / 50)}
                onClick={() => setPage((p) => p + 1)}
                className="rounded border border-slate-200 px-2 py-0.5 disabled:opacity-40 dark:border-border"
              >
                Next
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
