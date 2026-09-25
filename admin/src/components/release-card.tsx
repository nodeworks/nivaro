import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

const STAGES = [
  'preflight',
  'release',
  'publish',
  'artifacts',
  'frontends',
  'deployments',
  'verify'
] as const
type Stage = (typeof STAGES)[number]

interface RunSummary {
  id: string
  mode: 'plan' | 'go'
  args: string[]
  started_at: string
  started_by: string
  started_by_name?: string
  finished_at?: string
  state: 'running' | 'done' | 'failed' | 'cancelled' | 'lost'
  failed_stage?: Stage
  version?: string
}
interface StageEvent {
  stage: Stage
  status: 'start' | 'ok' | 'fail' | 'skip' | 'progress'
  detail?: string
  at: string
}
interface Plan {
  commits: number
  files: number
  last_tag: string
  sdk_changed: boolean
  react_changed: boolean
  migrations: string[]
  dirty: string[]
  versions: { app: string; react: string; sdk: string }
  lines: Array<{ stage: string; text: string }>
}

/** Pure: the stage track from the event list. */
export function stageStates(
  events: StageEvent[]
): Record<Stage, { status: 'pending' | 'running' | 'ok' | 'failed' | 'skipped'; detail?: string }> {
  const out = Object.fromEntries(
    STAGES.map((s) => [s, { status: 'pending' as const }])
  ) as ReturnType<typeof stageStates>
  for (const e of events) {
    const cur = out[e.stage]
    if (e.status === 'start') out[e.stage] = { status: 'running' }
    else if (e.status === 'ok') out[e.stage] = { status: 'ok', detail: cur.detail }
    else if (e.status === 'fail') out[e.stage] = { status: 'failed', detail: e.detail }
    else if (e.status === 'skip') out[e.stage] = { status: 'skipped', detail: e.detail }
    else if (e.status === 'progress') out[e.stage] = { ...cur, detail: e.detail }
  }
  return out
}

/** Pure: what the confirm dialog promises. */
export function outcomeSentence(plan: Plan, bump: string): string {
  const next = (v: string) => {
    const [a, b, c] = v.split('.').map(Number)
    return bump === 'major'
      ? `${a + 1}.0.0`
      : bump === 'minor'
        ? `${a}.${b + 1}.0`
        : `${a}.${b}.${c + 1}`
  }
  const parts = [`Cut nivaro ${next(plan.versions.app)}`]
  if (plan.react_changed || plan.sdk_changed) parts.push(`react ${next(plan.versions.react)}`)
  if (plan.sdk_changed) parts.push(`sdk ${next(plan.versions.sdk)}`)
  return `${parts.join(' and ')}, push the mirror, bump and push the frontends, deploy and verify staging.`
}

/** Pure: a duration as `Ns`, `Nm Ss` or `Nh Nm`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  if (m < 60) return `${m}m ${total % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Pure: how long a run took, or has taken so far while running. */
export function runDuration(r: RunSummary, now: number): string {
  const start = Date.parse(r.started_at)
  if (Number.isNaN(start)) return '—'
  if (r.finished_at) return formatDuration(Date.parse(r.finished_at) - start)
  if (r.state === 'running') return formatDuration(now - start)
  return '—'
}

/** Pure: the bump a run was started with — a resume repeats it. */
export function bumpOf(r: RunSummary): string {
  const i = r.args.indexOf('--bump')
  return i >= 0 && r.args[i + 1] ? r.args[i + 1] : 'patch'
}

type Confirm = { kind: 'release' } | { kind: 'resume'; from: Stage; bump: string }
type ApiError = { response?: { status?: number; data?: { error?: string; log_tail?: string } } }

export function ReleaseCard() {
  const qc = useQueryClient()
  const status = useQuery({
    queryKey: ['release-status'],
    queryFn: () =>
      api
        .get<{ available: boolean; current: RunSummary | null; runs: RunSummary[] }>(
          '/release/status'
        )
        .then((r) => r.data),
    refetchInterval: (q) => (q.state.data?.current ? 5_000 : 60_000)
  })
  const [plan, setPlan] = useState<Plan | null>(null)
  const [bump, setBump] = useState<'patch' | 'minor' | 'major'>('patch')
  const [openId, setOpenId] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)

  const planMut = useMutation({
    mutationFn: () => api.post<{ plan: Plan }>('/release/plan').then((r) => r.data.plan),
    onMutate: () => setPlanError(null),
    onSuccess: setPlan,
    onError: (e: ApiError) => {
      toast.error(e.response?.data?.error ?? 'Plan failed')
      setPlanError(e.response?.data?.log_tail ?? null)
    }
  })
  const start = useMutation({
    mutationFn: (body: { bump: string; from?: Stage }) =>
      api.post<{ run: RunSummary }>('/release/runs', body).then((r) => r.data.run),
    onSuccess: (run) => {
      setConfirm(null)
      // A plan describes the tree before this run; the next release needs a fresh one.
      setPlan(null)
      setOpenId(run.id)
      void qc.invalidateQueries({ queryKey: ['release-status'] })
    },
    onError: (e: ApiError) => {
      if (e.response?.status === 409) {
        toast.error('A release is already running')
        void qc.invalidateQueries({ queryKey: ['release-status'] })
      } else toast.error(e.response?.data?.error ?? 'Could not start')
    }
  })

  const current = status.data?.current ?? null
  const busy = !!current || start.isPending
  useEffect(() => {
    if (current && !openId) setOpenId(current.id)
  }, [current, openId])

  if (!status.data?.available) return null
  return (
    <section
      data-release-card
      className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'
    >
      <div className='flex items-center justify-between gap-3'>
        <div>
          <h2 className='text-[13.5px] font-semibold text-slate-900 dark:text-foreground'>
            Release
          </h2>
          <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            Runs scripts/release-chain.mjs from this machine — local development only.
          </p>
        </div>
        <div className='flex items-center gap-2'>
          <Button
            size='sm'
            variant='outline'
            onClick={() => planMut.mutate()}
            disabled={planMut.isPending}
            data-release-plan
          >
            {planMut.isPending ? 'Planning…' : 'Show plan'}
          </Button>
          <div className='flex gap-1'>
            {(['patch', 'minor', 'major'] as const).map((v) => (
              <Button
                key={v}
                size='sm'
                variant={bump === v ? 'default' : 'outline'}
                aria-pressed={bump === v}
                onClick={() => setBump(v)}
                data-release-bump={v}
              >
                {v}
              </Button>
            ))}
          </div>
          <Button
            size='sm'
            onClick={() => setConfirm({ kind: 'release' })}
            disabled={busy || !plan}
            data-release-start
          >
            Release
          </Button>
        </div>
      </div>

      {plan && (
        <div
          className='mt-3 rounded-lg border border-slate-200 p-3 text-[12px] dark:border-border'
          data-release-plan-summary
        >
          <p>
            {plan.commits} commit(s), {plan.files} file(s) since {plan.last_tag} · app{' '}
            {plan.versions.app} · react {plan.versions.react}
            {plan.react_changed ? ' (changed)' : ''} · sdk {plan.versions.sdk}
            {plan.sdk_changed ? ' (changed)' : ''} · {plan.migrations.length} migration(s)
          </p>
          {plan.dirty.length > 0 && (
            <p className='mt-1 text-amber-700 dark:text-amber-300' data-release-dirty>
              {plan.dirty.length} tracked file(s) have uncommitted changes and will NOT ship:{' '}
              {plan.dirty.slice(0, 5).join(', ')}
            </p>
          )}
          <ul className='mt-2 max-h-64 space-y-0.5 overflow-y-auto text-slate-600 dark:text-muted-foreground'>
            {plan.lines.map((l, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: plan lines can repeat a stage; the index is the honest key
              <li key={`${l.stage}-${i}`}>
                <span className='font-mono text-slate-400'>{l.stage}</span> · {l.text}
              </li>
            ))}
          </ul>
        </div>
      )}

      {planError && (
        <pre
          className='mt-3 max-h-64 overflow-y-auto rounded-md bg-slate-950 p-3 font-mono text-[11px] leading-snug text-rose-200'
          data-release-plan-error
        >
          {planError}
        </pre>
      )}

      {confirm && (confirm.kind === 'resume' || plan) && (
        <div
          className='mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-[12.5px] dark:border-amber-500/40 dark:bg-amber-400/10'
          data-release-confirm
        >
          <p>
            {confirm.kind === 'resume'
              ? `Resume the release from ${confirm.from} (bump ${confirm.bump}).`
              : plan && outcomeSentence(plan, bump)}
          </p>
          <div className='mt-2 flex gap-2'>
            <Button
              size='sm'
              onClick={() =>
                start.mutate(
                  confirm.kind === 'resume' ? { bump: confirm.bump, from: confirm.from } : { bump }
                )
              }
              disabled={busy}
              data-release-confirm-go
            >
              {confirm.kind === 'resume' ? 'Yes, resume' : 'Yes, release'}
            </Button>
            <Button size='sm' variant='outline' onClick={() => setConfirm(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {openId && (
        <RunView
          key={openId}
          id={openId}
          resumeDisabled={busy}
          onResume={(r) => {
            if (r.failed_stage)
              setConfirm({ kind: 'resume', from: r.failed_stage, bump: bumpOf(r) })
          }}
        />
      )}

      {status.data.runs.length > 0 && (
        <details className='mt-3 text-[12px]'>
          <summary className='cursor-pointer text-slate-500'>
            History ({status.data.runs.length})
          </summary>
          <ul className='mt-1 max-h-40 space-y-0.5 overflow-y-auto' data-release-history>
            {status.data.runs.map((r) => (
              <li key={r.id}>
                <button
                  type='button'
                  className='underline-offset-2 hover:underline'
                  onClick={() => setOpenId(r.id)}
                >
                  {r.state}
                  {r.version ? ` · ${r.version}` : ''}
                  {r.failed_stage ? ` at ${r.failed_stage}` : ''} · {formatRelative(r.started_at)} ·{' '}
                  {runDuration(r, Date.now())} · {r.started_by_name ?? r.started_by}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

function RunView({
  id,
  onResume,
  resumeDisabled
}: {
  id: string
  onResume: (run: RunSummary) => void
  resumeDisabled: boolean
}) {
  const qc = useQueryClient()
  const offset = useRef(0)
  const [log, setLog] = useState('')
  const [events, setEvents] = useState<StageEvent[]>([])
  const [run, setRun] = useState<RunSummary | null>(null)
  const q = useQuery({
    queryKey: ['release-run', id],
    // Each fetch returns only the log AFTER `offset`, so a cached response is a fragment:
    // drop it once unobserved so reopening a run always starts from the beginning.
    gcTime: 0,
    queryFn: () =>
      api
        .get<{ run: RunSummary; events: StageEvent[]; log_chunk: string; next_offset: number }>(
          `/release/runs/${id}`,
          { params: { after: offset.current } }
        )
        .then((r) => r.data),
    refetchInterval: (q) => (q.state.data?.run.state === 'running' ? 2_000 : false)
  })
  useEffect(() => {
    if (!q.data) return
    if (q.data.next_offset < offset.current) setLog('')
    offset.current = q.data.next_offset
    if (q.data.log_chunk) setLog((l) => l + q.data.log_chunk)
    setEvents(q.data.events)
    setRun(q.data.run)
  }, [q.data])
  const cancel = useMutation({
    mutationFn: () => api.post(`/release/runs/${id}/cancel`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['release-run', id] })
      void qc.invalidateQueries({ queryKey: ['release-status'] })
    },
    onError: (e: ApiError) => toast.error(e.response?.data?.error ?? 'Could not cancel')
  })
  const stages = stageStates(events)
  const tone: Record<string, string> = {
    pending: 'border-slate-200 text-slate-400 dark:border-border',
    running: 'border-nvr-cyan text-nvr-navy dark:text-nvr-cyan',
    ok: 'border-emerald-400 text-emerald-700 dark:text-emerald-300',
    failed: 'border-rose-400 text-rose-700 dark:text-rose-300',
    skipped: 'border-dashed border-slate-300 text-slate-400 dark:border-border'
  }
  const failedDetail = run?.failed_stage ? stages[run.failed_stage].detail : undefined
  if (q.error && !run) {
    const e = q.error as ApiError & { message?: string }
    return (
      <p className='mt-3 text-[12px] text-rose-700 dark:text-rose-300' data-release-run-error>
        Could not load this run: {e.response?.data?.error ?? e.message ?? 'unknown error'}
      </p>
    )
  }
  return (
    <div className='mt-3' data-release-run={id} data-release-run-state={run?.state}>
      <div className='flex flex-wrap items-center gap-1.5'>
        {STAGES.map((s) => (
          <span
            key={s}
            className={cn('rounded-full border px-2 py-0.5 text-[11px]', tone[stages[s].status])}
            data-release-stage={s}
            data-release-stage-status={stages[s].status}
            title={stages[s].detail}
          >
            {s}
          </span>
        ))}
        {run?.state === 'running' && (
          <Button
            size='sm'
            variant='outline'
            onClick={() => cancel.mutate()}
            disabled={cancel.isPending}
            data-release-cancel
          >
            Cancel
          </Button>
        )}
        {run?.state === 'failed' && run.failed_stage && (
          <>
            <Button
              size='sm'
              onClick={() => onResume(run)}
              disabled={resumeDisabled}
              data-release-resume
            >
              Resume from {run.failed_stage}
            </Button>
            {failedDetail && (
              <span
                className='text-[11px] text-rose-700 dark:text-rose-300'
                data-release-failed-detail
              >
                {failedDetail}
              </span>
            )}
          </>
        )}
        {run?.state === 'lost' && (
          <span className='text-[11px] text-amber-700 dark:text-amber-300'>
            Process ended without a result — check the log.
          </span>
        )}
      </div>
      <pre
        className='mt-2 max-h-64 overflow-y-auto rounded-md bg-slate-950 p-3 font-mono text-[11px] leading-snug text-slate-100'
        data-release-log
      >
        {log || '…'}
      </pre>
    </div>
  )
}
