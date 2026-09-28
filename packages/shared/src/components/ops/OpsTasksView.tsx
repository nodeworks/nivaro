import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useNivaroClient } from '../../context.js'
import { get, post } from '../../lib/commands.js'
import { formatRelative } from '../../lib/utils.js'

/**
 * Operational tasks (#827): every repair / backfill / migration core or an
 * extension registered, run from the console — dry run by default, one run
 * at a time per task, output tail while it runs, last runs underneath.
 */

export interface OpsTaskRow {
  key: string
  owner: string
  label: string
  description: string
  group: string | null
  leaves_behind: string | null
  follow_up: string | null
  cli: string | null
  has_dry_run: boolean
  available: boolean
  unavailable_reason: string | null
  running: {
    id: number
    mode: 'dry' | 'execute'
    started_at: string
    progress: { done: number; total: number | null } | null
  } | null
  runs: Array<{
    id: number
    label: string | null
    status: string
    started_at: string
    finished_at: string | null
    duration_ms: number | null
    outcome: string | null
    error: string | null
    by: string | null
  }>
}

export interface OpsTaskRun {
  id: number
  key: string
  mode: 'dry' | 'execute'
  status: 'running' | 'completed' | 'error' | 'cancelled'
  started_at: string
  finished_at: string | null
  progress: { done: number; total: number | null } | null
  outcome: {
    summary: string
    counts?: Record<string, number>
    backup_tables?: string[]
    follow_up?: string | null
  } | null
  error: string | null
  output: string[]
}

const STATUS_CLS: Record<string, string> = {
  running: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
  completed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  error: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
  cancelled: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
}

function RunTail({ id, onDone }: { id: number; onDone: () => void }) {
  const client = useNivaroClient()
  const q = useQuery({
    queryKey: ['ops-task-run', id],
    queryFn: () =>
      client.request(get<{ data: OpsTaskRun }>(`/ops-tasks/runs/${id}`)).then((r) => r.data),
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 1500 : false)
  })
  const run = q.data
  useEffect(() => {
    if (run && run.status !== 'running') onDone()
  }, [run?.status]) // eslint-disable-line react-hooks/exhaustive-deps
  const cancel = useMutation({
    mutationFn: () => client.request(post(`/ops-tasks/runs/${id}/cancel`, {})),
    onSuccess: () => q.refetch()
  })
  if (!run) return <div className='text-[12px] text-slate-500'>Loading run…</div>
  return (
    <div
      className='mt-2 rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-900/40'
      data-ops-task-run={run.id}
      data-ops-task-run-status={run.status}
    >
      <div className='flex flex-wrap items-center gap-2 text-[12px]'>
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_CLS[run.status] ?? ''}`}
        >
          {run.status}
        </span>
        <span className='text-slate-600 dark:text-slate-300'>
          {run.mode === 'dry' ? 'Dry run' : 'Real run'} · started {formatRelative(run.started_at)}
        </span>
        {run.progress && (
          <span className='text-slate-500'>
            {run.progress.done}
            {run.progress.total != null ? ` of ${run.progress.total}` : ''}
          </span>
        )}
        {run.status === 'running' && (
          <button
            type='button'
            className='ml-auto text-[11px] text-rose-600 underline-offset-2 hover:underline dark:text-rose-300'
            onClick={() => cancel.mutate()}
            data-ops-task-cancel
          >
            Cancel
          </button>
        )}
      </div>
      {run.outcome && (
        <div className='mt-2 text-[12px] text-slate-800 dark:text-slate-100' data-ops-task-outcome>
          <div className='font-medium'>{run.outcome.summary}</div>
          {run.outcome.counts && (
            <div className='mt-1 flex flex-wrap gap-2'>
              {Object.entries(run.outcome.counts).map(([k, v]) => (
                <span
                  key={k}
                  className='rounded bg-white px-2 py-0.5 text-[11px] text-slate-700 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700'
                >
                  <span className='font-semibold tabular-nums'>{v.toLocaleString()}</span>{' '}
                  {k.replace(/_/g, ' ')}
                </span>
              ))}
            </div>
          )}
          {run.outcome.backup_tables && run.outcome.backup_tables.length > 0 && (
            <div className='mt-1 text-[11px] text-slate-500'>
              Backups: {run.outcome.backup_tables.join(', ')}
            </div>
          )}
          {run.outcome.follow_up && (
            <div className='mt-1 text-[11px] text-amber-700 dark:text-amber-300'>
              Next: {run.outcome.follow_up}
            </div>
          )}
        </div>
      )}
      {run.error && (
        <div className='mt-2 text-[12px] text-rose-700 dark:text-rose-300'>{run.error}</div>
      )}
      {run.output.length > 0 && (
        <pre
          className='mt-2 max-h-72 overflow-auto rounded bg-[#0f172a] p-2 font-mono text-[11px] leading-5 text-slate-100'
          data-ops-task-output
        >
          {run.output.join('\n')}
        </pre>
      )}
    </div>
  )
}

function TaskCard({ task, onNotice }: { task: OpsTaskRow; onNotice?: (m: string) => void }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [openRun, setOpenRun] = useState<number | null>(task.running?.id ?? null)
  const [confirm, setConfirm] = useState(false)
  useEffect(() => {
    if (task.running?.id) setOpenRun(task.running.id)
  }, [task.running?.id])
  const start = useMutation({
    mutationFn: (execute: boolean) =>
      client
        .request(
          post<{ data: OpsTaskRun }>(`/ops-tasks/${encodeURIComponent(task.key)}/run`, { execute })
        )
        .then((r) => r.data),
    onSuccess: (run) => {
      setOpenRun(run.id)
      setConfirm(false)
      qc.invalidateQueries({ queryKey: ['ops-tasks'] })
    },
    onError: (err) => onNotice?.((err as Error)?.message ?? 'The task could not start')
  })
  const busy = !!task.running || start.isPending
  return (
    <section
      className='rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900'
      data-ops-task={task.key}
      data-ops-task-available={task.available ? '1' : '0'}
    >
      <div className='flex flex-wrap items-start gap-3'>
        <div className='min-w-0 flex-1'>
          <div className='flex flex-wrap items-baseline gap-2'>
            <h3 className='text-[14px] font-semibold text-slate-900 dark:text-slate-50'>
              {task.label}
            </h3>
            <span className='font-mono text-[10px] text-slate-400'>{task.key}</span>
          </div>
          <p className='mt-1 max-w-[72ch] text-[12px] leading-5 text-slate-600 dark:text-slate-300'>
            {task.description}
          </p>
          {task.leaves_behind && (
            <p className='mt-1 text-[11px] text-slate-500'>Leaves behind: {task.leaves_behind}</p>
          )}
          {task.follow_up && (
            <p className='mt-0.5 text-[11px] text-slate-500'>After a real run: {task.follow_up}</p>
          )}
          {!task.available && (
            <p
              className='mt-2 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:bg-amber-900/30 dark:text-amber-200'
              data-ops-task-unavailable
            >
              Not available on this host
              {task.unavailable_reason ? ` — ${task.unavailable_reason}` : ''}
              {task.cli && (
                <>
                  {' '}
                  · run it from a shell: <code className='font-mono'>{task.cli}</code>
                </>
              )}
            </p>
          )}
        </div>
        <div className='flex shrink-0 items-center gap-2'>
          {task.has_dry_run && (
            <button
              type='button'
              disabled={!task.available || busy}
              onClick={() => start.mutate(false)}
              className='h-8 rounded-md border border-slate-200 bg-white px-3 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700'
              data-ops-task-dry
            >
              Dry run
            </button>
          )}
          {confirm ? (
            <>
              <button
                type='button'
                disabled={busy}
                onClick={() => start.mutate(true)}
                className='h-8 rounded-md bg-rose-600 px-3 text-[12px] font-semibold text-white hover:bg-rose-700 disabled:opacity-50'
                data-ops-task-execute-confirm
              >
                Yes, run it for real
              </button>
              <button
                type='button'
                onClick={() => setConfirm(false)}
                className='h-8 px-2 text-[12px] text-slate-500 hover:underline'
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type='button'
              disabled={!task.available || busy}
              onClick={() => setConfirm(true)}
              className='h-8 rounded-md bg-nvr-cyan px-3 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-50'
              data-ops-task-execute
            >
              Run
            </button>
          )}
        </div>
      </div>
      {openRun != null && (
        <RunTail id={openRun} onDone={() => qc.invalidateQueries({ queryKey: ['ops-tasks'] })} />
      )}
      {task.runs.length > 0 && (
        <details className='mt-3'>
          <summary className='cursor-pointer text-[11px] text-slate-500'>
            Last {task.runs.length} run{task.runs.length === 1 ? '' : 's'}
          </summary>
          <ul className='mt-1 space-y-1' data-ops-task-history>
            {task.runs.map((r) => (
              <li key={r.id} className='flex flex-wrap items-baseline gap-x-2 text-[11px]'>
                <button
                  type='button'
                  className='text-slate-700 underline-offset-2 hover:underline dark:text-slate-200'
                  onClick={() => setOpenRun(r.id)}
                >
                  {formatRelative(r.started_at)}
                </button>
                <span
                  className={`rounded px-1 text-[10px] font-semibold uppercase ${STATUS_CLS[r.status] ?? ''}`}
                >
                  {r.status}
                </span>
                <span className='text-slate-500'>
                  {/dry run/.test(r.label ?? '') ? 'dry' : 'real'}
                </span>
                {r.by && <span className='text-slate-500'>by {r.by}</span>}
                {r.duration_ms != null && (
                  <span className='text-slate-400'>{Math.round(r.duration_ms / 1000)}s</span>
                )}
                {r.outcome && (
                  <span className='text-slate-600 dark:text-slate-300'>· {r.outcome}</span>
                )}
                {r.error && <span className='text-rose-600 dark:text-rose-300'>· {r.error}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

export function OpsTasksView({ onNotice }: { onNotice?: (message: string) => void }) {
  const client = useNivaroClient()
  const q = useQuery({
    queryKey: ['ops-tasks'],
    queryFn: () => client.request(get<{ data: OpsTaskRow[] }>('/ops-tasks')).then((r) => r.data),
    refetchInterval: (query) => (query.state.data?.some((t) => t.running) ? 3000 : false)
  })
  const groups = useMemo(() => {
    const m = new Map<string, OpsTaskRow[]>()
    for (const t of q.data ?? []) {
      const g = t.group ?? 'Tasks'
      m.set(g, [...(m.get(g) ?? []), t])
    }
    return [...m.entries()]
  }, [q.data])
  if (q.isLoading) return <div className='p-6 text-[12px] text-slate-500'>Loading tasks…</div>
  if (!q.data?.length)
    return (
      <div className='p-6 text-[13px] text-slate-600 dark:text-slate-300' data-ops-tasks-empty>
        No operational tasks are registered. An extension registers one with{' '}
        <code className='font-mono'>ctx.tasks.register(…)</code>.
      </div>
    )
  return (
    <div className='space-y-6 p-6' data-ops-tasks={q.data.length}>
      {groups.map(([group, list]) => (
        <div key={group}>
          <h2 className='mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500'>
            {group}
          </h2>
          <div className='space-y-3'>
            {list.map((t) => (
              <TaskCard key={t.key} task={t} onNotice={onNotice} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
