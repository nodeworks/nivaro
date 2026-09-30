import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

/**
 * Runbooks (#720) — long operator scripts an extension declared (EFP's
 * go-live chain), run from this machine as detached processes and watched
 * here: per-step status, duration and the lines each step said, the log
 * tail, cancel, resume at the failed step. A real run needs a finished dry
 * run of the same target in the last 24 hours and the target typed back.
 * Local development only — the section is absent elsewhere.
 */

type State = 'running' | 'done' | 'failed' | 'cancelled' | 'lost'
interface RunbookRun {
  id: string
  extension: string
  runbook: string
  mode: 'dry' | 'go'
  target: string | null
  started_at: string
  finished_at?: string
  state: State
  failed_step?: string
  summary?: string
}
interface Runbook {
  extension: string
  key: string
  label: string
  description: string | null
  target_env: string | null
  refuse_targets: string[]
  resumable: boolean
  dry_runs: Array<{ id: string; target: string | null; finished_at: string; summary?: string }>
}
interface StepState {
  step: string
  status: 'pending' | 'running' | 'ok' | 'failed' | 'skipped' | 'refused' | 'cancelled'
  started_at?: string
  secs?: number
  lines?: string[]
}
type ApiError = { response?: { data?: { error?: string } } }

const DAY = 24 * 3600_000

/** Pure: seconds as `Ns`, `NmSSs` or `Nh Nm`. */
export function fmtSecs(secs?: number): string {
  if (secs == null) return ''
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  if (m < 60) return `${m}m${String(secs % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Pure: the fresh dry run that unlocks a real run against `target`, if any. */
export function freshDryRun(rb: Runbook, target: string | null, now = Date.now()) {
  return (
    rb.dry_runs.find(
      (d) => (d.target ?? null) === (target || null) && now - Date.parse(d.finished_at) < DAY
    ) ?? null
  )
}

export function RunbooksCard() {
  const q = useQuery({
    queryKey: ['runbooks'],
    queryFn: () =>
      api
        .get<{
          available: boolean
          runbooks: Runbook[]
          runs: RunbookRun[]
          current: RunbookRun | null
        }>('/runbooks')
        .then((r) => r.data),
    refetchInterval: (x) => (x.state.data?.current ? 5_000 : 60_000)
  })
  const [openId, setOpenId] = useState<string | null>(null)
  const current = q.data?.current ?? null
  useEffect(() => {
    if (current && !openId) setOpenId(current.id)
  }, [current, openId])
  if (!q.data?.available || q.data.runbooks.length === 0) return null
  return (
    <section
      data-runbooks-card
      className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'
    >
      <h2 className='text-[13.5px] font-semibold text-slate-900 dark:text-foreground'>Runbooks</h2>
      <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
        Long operator scripts from extensions, run from this machine and watched here — local
        development only. Each needs its dry-run report before a real run.
      </p>
      <div className='mt-3 space-y-3'>
        {q.data.runbooks.map((rb) => (
          <RunbookRow
            key={`${rb.extension}:${rb.key}`}
            rb={rb}
            runs={q.data.runs.filter((r) => r.extension === rb.extension && r.runbook === rb.key)}
            busy={!!current}
            onOpen={setOpenId}
          />
        ))}
      </div>
      {openId && <RunbookRunView key={openId} id={openId} />}
    </section>
  )
}

function RunbookRow({
  rb,
  runs,
  busy,
  onOpen
}: {
  rb: Runbook
  runs: RunbookRun[]
  busy: boolean
  onOpen: (id: string) => void
}) {
  const qc = useQueryClient()
  const [target, setTarget] = useState('')
  const [confirm, setConfirm] = useState('')
  const [asking, setAsking] = useState<'go' | 'resume' | null>(null)
  const t = rb.target_env ? target.trim() : ''
  const refused = rb.refuse_targets.some((x) => x.toLowerCase() === t.toLowerCase())
  const needsTarget = !!rb.target_env && !t
  const dry = freshDryRun(rb, t || null)
  const newestGo = runs.find((r) => r.mode === 'go' && (r.target ?? '') === t)
  const canResume = rb.resumable && newestGo?.state === 'failed' && !!newestGo.failed_step
  const expected = t || rb.key
  const start = useMutation({
    mutationFn: (body: { mode: 'dry' | 'go'; resume?: boolean }) =>
      api
        .post<{ run: RunbookRun }>(`/runbooks/${rb.extension}/${rb.key}/runs`, {
          ...body,
          target: t || undefined,
          confirm: body.mode === 'go' ? confirm : undefined
        })
        .then((r) => r.data.run),
    onSuccess: (run) => {
      setAsking(null)
      setConfirm('')
      onOpen(run.id)
      void qc.invalidateQueries({ queryKey: ['runbooks'] })
    },
    onError: (e: ApiError) => toast.error(e.response?.data?.error ?? 'Could not start the runbook')
  })
  return (
    <div
      className='rounded-lg border border-slate-200 p-3 text-[12px] dark:border-border'
      data-runbook={`${rb.extension}:${rb.key}`}
    >
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='min-w-0 flex-1'>
          <p className='text-[12.5px] font-medium text-slate-800 dark:text-slate-100'>
            {rb.label} <span className='font-normal text-slate-400'>· {rb.extension}</span>
          </p>
          {rb.description && (
            <p className='mt-0.5 max-w-[80ch] text-slate-500 dark:text-muted-foreground'>
              {rb.description}
            </p>
          )}
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          {rb.target_env && (
            <label className='flex items-center gap-1.5 text-slate-600 dark:text-slate-300'>
              <span className='font-mono text-[11px]'>{rb.target_env}</span>
              <input
                value={target}
                onChange={(e) => {
                  setTarget(e.target.value)
                  setAsking(null)
                }}
                placeholder='target name'
                className='h-8 w-40 rounded border border-slate-300 bg-white px-2 font-mono text-[12px] dark:border-border dark:bg-background'
                data-runbook-target
              />
            </label>
          )}
          <Button
            size='sm'
            variant='outline'
            disabled={busy || needsTarget || refused || start.isPending}
            onClick={() => start.mutate({ mode: 'dry' })}
            data-runbook-dry
          >
            Dry run
          </Button>
          <Button
            size='sm'
            disabled={busy || needsTarget || refused || !dry}
            onClick={() => setAsking('go')}
            title={
              dry ? undefined : 'Needs a finished dry run of this target from the last 24 hours'
            }
            data-runbook-go
          >
            Run
          </Button>
          {canResume && (
            <Button
              size='sm'
              variant='outline'
              disabled={busy || !dry}
              onClick={() => setAsking('resume')}
              data-runbook-resume
            >
              Resume from {newestGo?.failed_step}
            </Button>
          )}
        </div>
      </div>
      {refused && (
        <p className='mt-2 text-rose-700 dark:text-rose-300' data-runbook-refused>
          {t} is refused by this runbook.
        </p>
      )}
      {!needsTarget && !refused && (
        <p className='mt-2 text-slate-500 dark:text-muted-foreground' data-runbook-gate>
          {dry
            ? `Dry run ${formatRelative(dry.finished_at)}${dry.summary ? ` — ${dry.summary}` : ''}.`
            : `No dry run of ${t || 'this runbook'} in the last 24 hours — run one and read the report first.`}
        </p>
      )}
      {asking && (
        <div
          className='mt-2 flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 dark:border-amber-500/40 dark:bg-amber-400/10'
          data-runbook-confirm
        >
          <span>
            {asking === 'resume'
              ? `Resume the real run against ${expected} at ${newestGo?.failed_step}.`
              : `Run every step for real against ${expected}.`}{' '}
            Type <span className='font-mono'>{expected}</span>:
          </span>
          <input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className='h-7 w-40 rounded border border-slate-300 bg-white px-1.5 font-mono dark:border-border dark:bg-background'
            data-runbook-confirm-input
          />
          <Button
            size='sm'
            disabled={confirm !== expected || start.isPending}
            onClick={() => start.mutate({ mode: 'go', resume: asking === 'resume' })}
            data-runbook-confirm-go
          >
            {asking === 'resume' ? 'Yes, resume' : 'Yes, run'}
          </Button>
          <Button size='sm' variant='outline' onClick={() => setAsking(null)}>
            Cancel
          </Button>
        </div>
      )}
      {runs.length > 0 && (
        <ul className='mt-2 space-y-0.5' data-runbook-history>
          {runs.slice(0, 6).map((r) => (
            <li key={r.id}>
              <button
                type='button'
                className='text-slate-600 underline-offset-2 hover:underline dark:text-slate-300'
                onClick={() => onOpen(r.id)}
              >
                {r.mode === 'dry' ? 'dry run' : 'run'} · {r.target ?? '—'} · {r.state}
                {r.failed_step ? ` at ${r.failed_step}` : ''} · {formatRelative(r.started_at)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function RunbookRunView({ id }: { id: string }) {
  const qc = useQueryClient()
  const offset = useRef(0)
  const [log, setLog] = useState('')
  const [cancelAsk, setCancelAsk] = useState(false)
  const q = useQuery({
    queryKey: ['runbook-run', id],
    gcTime: 0,
    queryFn: () =>
      api
        .get<{ run: RunbookRun; steps: StepState[]; log_chunk: string; next_offset: number }>(
          `/runbooks/runs/${id}`,
          { params: { after: offset.current } }
        )
        .then((r) => r.data),
    refetchInterval: (x) => (x.state.data?.run.state === 'running' ? 3_000 : false)
  })
  useEffect(() => {
    if (!q.data) return
    if (q.data.next_offset < offset.current) setLog('')
    offset.current = q.data.next_offset
    if (q.data.log_chunk)
      setLog((l) =>
        (l + q.data.log_chunk)
          .split('\n')
          .filter((x) => !x.startsWith('@@'))
          .join('\n')
          .slice(-60_000)
      )
  }, [q.data])
  const cancel = useMutation({
    mutationFn: () => api.post(`/runbooks/runs/${id}/cancel`),
    onSuccess: () => {
      setCancelAsk(false)
      void qc.invalidateQueries({ queryKey: ['runbook-run', id] })
      void qc.invalidateQueries({ queryKey: ['runbooks'] })
    }
  })
  const run = q.data?.run
  const steps = q.data?.steps ?? []
  const tone: Record<StepState['status'], string> = {
    pending: 'text-slate-400',
    running: 'text-nvr-navy dark:text-nvr-cyan',
    ok: 'text-emerald-700 dark:text-emerald-300',
    failed: 'text-rose-700 dark:text-rose-300',
    skipped: 'text-slate-400',
    refused: 'text-amber-700 dark:text-amber-300',
    cancelled: 'text-amber-700 dark:text-amber-300'
  }
  const mark: Record<StepState['status'], string> = {
    pending: '○',
    running: '◐',
    ok: '✓',
    failed: '✗',
    skipped: '·',
    refused: '!',
    cancelled: '■'
  }
  if (!run) return <div className='mt-3 h-24 animate-pulse rounded bg-muted' />
  return (
    <div className='mt-3' data-runbook-run={id} data-runbook-run-state={run.state}>
      <div className='flex flex-wrap items-center gap-2 text-[12px]'>
        <span className='font-medium text-slate-700 dark:text-slate-200'>
          {run.mode === 'dry' ? 'Dry run' : 'Run'} · {run.target ?? run.runbook} · {run.state}
          {run.failed_step ? ` at ${run.failed_step}` : ''}
        </span>
        {run.summary && <span className='text-slate-500'>{run.summary}</span>}
        {run.state === 'running' &&
          (cancelAsk ? (
            <span className='flex items-center gap-1.5'>
              Cancel? The step running now stops mid-way.
              <Button
                size='sm'
                variant='outline'
                onClick={() => cancel.mutate()}
                data-runbook-cancel-confirm
              >
                Yes, cancel
              </Button>
              <Button size='sm' variant='outline' onClick={() => setCancelAsk(false)}>
                Keep running
              </Button>
            </span>
          ) : (
            <Button
              size='sm'
              variant='outline'
              onClick={() => setCancelAsk(true)}
              data-runbook-cancel
            >
              Cancel
            </Button>
          ))}
      </div>
      <ol
        className='mt-2 grid gap-x-6 gap-y-1 text-[12px] sm:grid-cols-2 xl:grid-cols-3'
        data-runbook-steps
      >
        {steps.map((s) => (
          <li key={s.step} data-runbook-step={s.step} data-runbook-step-status={s.status}>
            <details>
              <summary className={cn('cursor-pointer list-none', tone[s.status])}>
                <span className='inline-block w-4'>{mark[s.status]}</span>
                <span className='font-mono'>{s.step}</span>
                {s.secs != null && <span className='ml-1 text-slate-400'>{fmtSecs(s.secs)}</span>}
                {s.status === 'running' && s.started_at && (
                  <span className='ml-1 text-slate-400'>since {formatRelative(s.started_at)}</span>
                )}
              </summary>
              {s.lines && s.lines.length > 0 && (
                <ul className='ml-4 mt-0.5 space-y-0.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
                  {s.lines.map((l, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: report lines repeat
                    <li key={i}>{l}</li>
                  ))}
                </ul>
              )}
            </details>
          </li>
        ))}
      </ol>
      <pre
        className='mt-2 max-h-72 overflow-y-auto rounded-md bg-slate-950 p-3 font-mono text-[11px] leading-snug text-slate-100'
        data-runbook-log
      >
        {log.slice(-20_000) || '…'}
      </pre>
    </div>
  )
}
