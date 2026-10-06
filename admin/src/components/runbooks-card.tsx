import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { SimpleSelect } from '@/components/ui/simple-select'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

/**
 * Runbooks (#720) — long operator scripts an extension declared, watched
 * here: per-step status, duration and the lines each step said, the log
 * tail, cancel, resume at the failed step. A real run needs a finished dry
 * run of the same target in the last 24 hours and the target typed back.
 *
 * Two kinds:
 *   - local runbooks run on this machine (local development only);
 *   - host runbooks are QUEUED from any instance and run by the host agent
 *     on the machine that checks in for them (the staging box for EFP's
 *     "Rebuild EFP_Staging"). Their output streams back every second; the
 *     console estimates from history (the agent records each successful
 *     phase, and reads the nightly job's own logs) and warns when a run
 *     goes quiet for longer than that phase ever has, or the agent stops
 *     reporting.
 */

type State = 'running' | 'done' | 'failed' | 'cancelled' | 'lost' | 'queued' | 'refused'
interface RunbookRun {
  id: string
  source?: 'local' | 'host'
  extension: string
  runbook: string
  mode: 'dry' | 'go'
  target: string | null
  from_step?: string | null
  host?: string | null
  started_at: string
  finished_at?: string
  heartbeat_at?: string
  state: State
  failed_step?: string
  summary?: string
  cancel_requested?: boolean
}
interface Plan {
  phases: Array<{ key: string; label: string; secs: number | null }>
  from: Record<string, number | null>
  unknown_from: Record<string, number>
}
interface Runbook {
  extension: string
  key: string
  label: string
  description: string | null
  runs_on: 'local' | 'host'
  phases: Array<{ key: string; label: string }>
  typical: { go: Plan; dry: Plan } | null
  target_env: string | null
  refuse_targets: string[]
  resumable: boolean
  /** Read-only: it has no dry run, and a real run needs none first. */
  skip_dry_gate?: boolean
  active: RunbookRun | null
  agents: Array<{ host: string; last_seen: string; online: boolean }>
  dry_runs: Array<{ id: string; target: string | null; finished_at: string; summary?: string }>
}
interface StepState {
  step: string
  status: 'pending' | 'running' | 'ok' | 'failed' | 'skipped' | 'refused' | 'cancelled'
  started_at?: string
  secs?: number
  lines?: string[]
}
interface LiveEstimate {
  elapsed_secs: number
  current: string | null
  current_elapsed_secs: number
  current_typical_secs: number | null
  over_typical: boolean
  remaining_secs: number | null
  total_secs: number | null
  percent: number | null
  eta: string | null
  phases: Array<{
    key: string
    status: string
    actual_secs: number | null
    typical_secs: number | null
  }>
  unknown: number
}
interface RunDetail {
  run: RunbookRun
  steps: StepState[]
  log_chunk: string
  next_offset: number
  phases?: Array<{ key: string; label: string }>
  estimate?: LiveEstimate | null
  last_line_at?: string | null
  stall_after_secs?: number | null
  server_now?: string
  typical?: Plan | null
}
type ApiError = { response?: { data?: { error?: string } } }

const DAY = 24 * 3600_000
const ACTIVE: State[] = ['running', 'queued']

/** Pure: seconds as `Ns`, `NmSSs` or `Nh Nm`. */
export function fmtSecs(secs?: number | null): string {
  if (secs == null) return ''
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  if (m < 60) return `${m}m${String(secs % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Pure: a rough duration for estimates — `~45s`, `~12m`, `~1h 15m`. */
export function fmtAbout(secs?: number | null): string {
  if (secs == null) return ''
  if (secs < 60) return `~${Math.max(1, Math.round(secs))}s`
  const m = Math.round(secs / 60)
  if (m < 60) return `~${m}m`
  return `~${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`
}

/** Pure: a line worth showing under "warnings & errors". */
export function isAttentionLine(line: string): boolean {
  return /\b(warn(ing)?|error|errors|fail(ed|ure)?|refused|abort(ed)?|timeout|exception)\b|✗|⚠|PHASE FAILED|### FAILED|### REFUSED/i.test(
    line
  )
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
          agent_cron?: string
        }>('/runbooks')
        .then((r) => r.data),
    refetchInterval: (x) => {
      const d = x.state.data
      const busy = d?.current || d?.runbooks.some((r) => r.active)
      return busy ? 3_000 : 30_000
    }
  })
  const [openId, setOpenId] = useState<string | null>(null)
  const current = q.data?.current ?? null
  const hostActive = q.data?.runbooks.find((r) => r.active)?.active ?? null
  useEffect(() => {
    const live = current ?? hostActive
    if (live && !openId) setOpenId(live.id)
  }, [current, hostActive, openId])
  if (!q.data?.available || q.data.runbooks.length === 0) return null
  return (
    <section
      data-runbooks-card
      className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'
    >
      <h2 className='text-[13.5px] font-semibold text-slate-900 dark:text-foreground'>Runbooks</h2>
      <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
        Long operator scripts from extensions, watched here. Local ones run on this machine (local
        development only); host ones are queued for the agent on the machine that runs them. Each
        needs its dry-run report before a real run.
      </p>
      <div className='mt-3 space-y-3'>
        {q.data.runbooks.map((rb) => (
          <RunbookRow
            key={`${rb.extension}:${rb.key}`}
            rb={rb}
            runs={q.data.runs.filter((r) => r.extension === rb.extension && r.runbook === rb.key)}
            busy={rb.runs_on === 'host' ? !!rb.active : !!current}
            agentCron={q.data.agent_cron ?? ''}
            onOpen={setOpenId}
          />
        ))}
      </div>
      {openId && (
        <RunbookRunView
          key={openId}
          id={openId}
          runbook={q.data.runbooks.find((rb) =>
            q.data.runs.some(
              (r) => r.id === openId && r.extension === rb.extension && r.runbook === rb.key
            )
          )}
        />
      )}
    </section>
  )
}

function HostAgentLine({ rb, cron }: { rb: Runbook; cron: string }) {
  const online = rb.agents.filter((a) => a.online)
  if (online.length > 0)
    return (
      <p
        className='mt-1 text-[11.5px] text-slate-500 dark:text-muted-foreground'
        data-runbook-agent='online'
      >
        <span className='mr-1 inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 align-middle' />
        Runs on {online.map((a) => a.host).join(', ')} · agent checked in{' '}
        {formatRelative(online[0].last_seen)}
      </p>
    )
  const seen = rb.agents[0]
  return (
    <div
      className='mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-[11.5px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-400/10 dark:text-amber-200'
      data-runbook-agent='offline'
    >
      {seen
        ? `The host agent on ${seen.host} last checked in ${formatRelative(seen.last_seen)} — runs wait in the queue until it is back.`
        : 'No host agent is checking in — install it on the machine that runs this, then queued runs start within a minute:'}
      <div className='mt-1 flex items-start gap-2'>
        <code className='block flex-1 overflow-x-auto whitespace-pre rounded bg-[#0f172a] px-2 py-1 font-mono text-[11px] text-slate-100'>
          {cron}
        </code>
        <Button
          size='sm'
          variant='outline'
          onClick={() => {
            void navigator.clipboard?.writeText(cron)
            toast.success('Cron line copied')
          }}
        >
          Copy
        </Button>
      </div>
    </div>
  )
}

function RunbookRow({
  rb,
  runs,
  busy,
  agentCron,
  onOpen
}: {
  rb: Runbook
  runs: RunbookRun[]
  busy: boolean
  agentCron: string
  onOpen: (id: string) => void
}) {
  const qc = useQueryClient()
  const [target, setTarget] = useState(
    rb.runs_on === 'host' && rb.target_env ? (rb.dry_runs[0]?.target ?? '') : ''
  )
  const [confirm, setConfirm] = useState('')
  const [from, setFrom] = useState('')
  const [asking, setAsking] = useState<'go' | 'resume' | null>(null)
  const t = rb.target_env ? target.trim() : ''
  const refused = rb.refuse_targets.some((x) => x.toLowerCase() === t.toLowerCase())
  const needsTarget = !!rb.target_env && !t
  const noDry = rb.skip_dry_gate === true
  const dry = freshDryRun(rb, t || null)
  // What unlocks a real run: a fresh dry run, or a runbook that needs none.
  const unlocked = noDry || !!dry
  const newestGo = runs.find((r) => r.mode === 'go' && (r.target ?? '') === t)
  const canResume = rb.resumable && newestGo?.state === 'failed' && !!newestGo.failed_step
  const expected = t || rb.key
  const host = rb.runs_on === 'host'
  const plan = rb.typical?.go
  const start = useMutation({
    mutationFn: (body: { mode: 'dry' | 'go'; resume?: boolean }) =>
      api
        .post<{ run: RunbookRun }>(`/runbooks/${rb.extension}/${rb.key}/runs`, {
          ...body,
          target: t || undefined,
          from: !body.resume && from ? from : undefined,
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
  const fromOptions = useMemo(
    () => [
      {
        value: '',
        label: `Full run${plan?.from[rb.phases[0]?.key] != null ? ` (${fmtAbout(plan.from[rb.phases[0].key])})` : ''}`
      },
      ...rb.phases.slice(1).map((p) => ({
        value: p.key,
        label: `From ${p.label}${plan?.from[p.key] != null ? ` (${fmtAbout(plan.from[p.key])})` : ''}`
      }))
    ],
    [rb.phases, plan]
  )
  const typicalLine = (() => {
    if (!plan || rb.phases.length === 0) return null
    const firstKey = rb.phases[0].key
    const full = plan.from[firstKey]
    if (full == null) return 'No timing history yet — the first runs set the estimates.'
    const parts = [`A full run usually takes ${fmtAbout(full)}`]
    if (from && plan.from[from] != null) {
      const label = rb.phases.find((p) => p.key === from)?.label ?? from
      parts.push(`from ${label.toLowerCase()} ${fmtAbout(plan.from[from])}`)
    }
    const unknown = plan.unknown_from[from || firstKey]
    return `${parts.join('; ')}${unknown ? ` (${unknown} phase${unknown > 1 ? 's' : ''} without history left out)` : ''}.`
  })()
  return (
    <div
      className='rounded-lg border border-slate-200 p-3 text-[12px] dark:border-border'
      data-runbook={`${rb.extension}:${rb.key}`}
    >
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='min-w-0 flex-1'>
          <p className='text-[12.5px] font-medium text-slate-800 dark:text-slate-100'>
            {rb.label} <span className='font-normal text-slate-400'>· {rb.extension}</span>
            {host && (
              <span
                className='ml-2 rounded-full bg-sky-50 px-2 py-0.5 text-[10.5px] font-medium text-sky-800 dark:bg-sky-400/10 dark:text-sky-200'
                data-runbook-host-badge
              >
                Runs on the host
              </span>
            )}
          </p>
          {rb.description && (
            <p className='mt-0.5 max-w-[80ch] text-slate-500 dark:text-muted-foreground'>
              {rb.description}
            </p>
          )}
          {host && rb.agents.length > 0 && rb.agents.some((a) => a.online) && (
            <HostAgentLine rb={rb} cron={agentCron} />
          )}
          {typicalLine && (
            <p
              className='mt-1 text-[11.5px] text-slate-500 dark:text-muted-foreground'
              data-runbook-typical
            >
              {typicalLine}
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
          {rb.resumable && rb.phases.length > 1 && (
            <SimpleSelect
              value={from}
              onChange={(v) => {
                setFrom(v)
                setAsking(null)
              }}
              options={fromOptions}
              ariaLabel='Start from phase'
              className='h-8 w-56 text-[12px]'
              triggerProps={{ 'data-runbook-from': 'true' }}
            />
          )}
          {!noDry && (
            <Button
              size='sm'
              variant='outline'
              disabled={busy || needsTarget || refused || start.isPending}
              onClick={() => start.mutate({ mode: 'dry' })}
              data-runbook-dry
            >
              Dry run
            </Button>
          )}
          <Button
            size='sm'
            disabled={busy || needsTarget || refused || !unlocked}
            onClick={() => setAsking('go')}
            title={
              unlocked
                ? undefined
                : 'Needs a finished dry run of this target from the last 24 hours'
            }
            data-runbook-go
          >
            Run
          </Button>
          {canResume && (
            <Button
              size='sm'
              variant='outline'
              disabled={busy || !unlocked}
              onClick={() => setAsking('resume')}
              data-runbook-resume
            >
              Resume from {newestGo?.failed_step}
            </Button>
          )}
        </div>
      </div>
      {host && !rb.agents.some((a) => a.online) && <HostAgentLine rb={rb} cron={agentCron} />}
      {refused && (
        <p className='mt-2 text-rose-700 dark:text-rose-300' data-runbook-refused>
          {t} is refused by this runbook.
        </p>
      )}
      {host && rb.active && (
        <p className='mt-2 text-sky-800 dark:text-sky-200' data-runbook-active>
          {rb.active.state === 'queued'
            ? 'A run is queued — the host agent picks it up within a minute.'
            : `A ${rb.active.mode === 'dry' ? 'dry run' : 'run'} is going on ${rb.active.host ?? 'the host'}.`}
        </p>
      )}
      {!needsTarget && !refused && !noDry && (
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
              : `Run ${from ? `from ${rb.phases.find((p) => p.key === from)?.label ?? from}` : 'every step'} for real against ${expected}${host ? ' on the host' : ''}.`}{' '}
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
                {r.failed_step ? ` at ${r.failed_step}` : ''}
                {r.host ? ` · ${r.host}` : ''} · {formatRelative(r.started_at)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

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

function RunbookRunView({ id, runbook }: { id: string; runbook?: Runbook }) {
  const qc = useQueryClient()
  const offset = useRef(0)
  const [log, setLog] = useState('')
  const [cancelAsk, setCancelAsk] = useState(false)
  const [filter, setFilter] = useState<'all' | 'attention'>('all')
  const [follow, setFollow] = useState(true)
  const [tickNow, setTickNow] = useState(Date.now())
  const skew = useRef(0)
  const logRef = useRef<HTMLPreElement | null>(null)
  const q = useQuery({
    queryKey: ['runbook-run', id],
    gcTime: 0,
    queryFn: () =>
      api
        .get<RunDetail>(`/runbooks/runs/${id}`, { params: { after: offset.current } })
        .then((r) => r.data),
    refetchInterval: (x) => {
      const s = x.state.data?.run.state
      return s && ACTIVE.includes(s) ? (x.state.data?.run.source === 'host' ? 1_500 : 3_000) : false
    }
  })
  useEffect(() => {
    if (!q.data) return
    if (q.data.server_now) skew.current = Date.parse(q.data.server_now) - Date.now()
    if (q.data.next_offset < offset.current) setLog('')
    offset.current = q.data.next_offset
    if (q.data.log_chunk)
      setLog((l) =>
        (l + q.data.log_chunk)
          .split('\n')
          .filter((x) => !x.startsWith('@@'))
          .join('\n')
          .slice(-200_000)
      )
  }, [q.data])
  const run = q.data?.run
  const active = !!run && ACTIVE.includes(run.state)
  // A clock for the "ago" figures between polls.
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setTickNow(Date.now()), 1_000)
    return () => clearInterval(t)
  }, [active])
  const shown = useMemo(() => {
    const lines = log.split('\n')
    const kept = filter === 'attention' ? lines.filter(isAttentionLine) : lines
    return kept.slice(-1500).join('\n')
  }, [log, filter])
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when new output renders
  useEffect(() => {
    const el = logRef.current
    if (el && follow) el.scrollTop = el.scrollHeight
  }, [shown, follow])
  const cancel = useMutation({
    mutationFn: () => api.post(`/runbooks/runs/${id}/cancel`),
    onSuccess: () => {
      setCancelAsk(false)
      void qc.invalidateQueries({ queryKey: ['runbook-run', id] })
      void qc.invalidateQueries({ queryKey: ['runbooks'] })
    }
  })
  if (!run) return <div className='mt-3 h-24 animate-pulse rounded bg-muted' />
  const steps = q.data?.steps ?? []
  const labelOf = (key: string) =>
    (q.data?.phases ?? runbook?.phases ?? []).find((p) => p.key === key)?.label ?? key
  const now = tickNow + skew.current
  const est = q.data?.estimate ?? null
  const host = run.source === 'host'
  const sinceLine = q.data?.last_line_at ? (now - Date.parse(q.data.last_line_at)) / 1000 : null
  const sinceBeat = run.heartbeat_at ? (now - Date.parse(run.heartbeat_at)) / 1000 : null
  const stallAfter = q.data?.stall_after_secs ?? 600
  const stalled = host && run.state === 'running' && sinceLine != null && sinceLine > stallAfter
  const agentSilent = host && run.state === 'running' && sinceBeat != null && sinceBeat > 45
  const currentStep = est?.current ? steps.find((s) => s.step === est.current) : null
  const subStep = currentStep?.lines?.[currentStep.lines.length - 1]
  const elapsedNow = est
    ? est.elapsed_secs + Math.max(0, Math.round((tickNow - q.dataUpdatedAt) / 1000))
    : null
  return (
    <div className='mt-3' data-runbook-run={id} data-runbook-run-state={run.state}>
      <div className='flex flex-wrap items-center gap-2 text-[12px]'>
        <span className='font-medium text-slate-700 dark:text-slate-200'>
          {run.mode === 'dry' ? 'Dry run' : 'Run'} · {run.target ?? run.runbook} · {run.state}
          {run.failed_step ? ` at ${run.failed_step}` : ''}
          {run.host ? ` · ${run.host}` : ''}
          {run.from_step ? ` · from ${labelOf(run.from_step)}` : ''}
        </span>
        {run.summary && <span className='text-slate-500'>{run.summary}</span>}
        {run.state === 'queued' && (
          <span className='text-slate-500'>waiting for the host agent to pick it up…</span>
        )}
        {run.cancel_requested && run.state === 'running' && (
          <span className='text-amber-700 dark:text-amber-300'>cancel requested — stopping…</span>
        )}
        {active &&
          (cancelAsk ? (
            <span className='flex items-center gap-1.5'>
              {run.state === 'queued'
                ? 'Take it out of the queue?'
                : 'Cancel? The step running now stops mid-way.'}
              <Button
                size='sm'
                variant='outline'
                onClick={() => cancel.mutate()}
                data-runbook-cancel-confirm
              >
                Yes, cancel
              </Button>
              <Button size='sm' variant='outline' onClick={() => setCancelAsk(false)}>
                Keep it
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

      {host && run.state === 'running' && est && (
        <div
          className='mt-2 rounded-md border border-slate-200 p-2.5 text-[12px] dark:border-border'
          data-runbook-estimate
        >
          <div className='flex flex-wrap items-baseline gap-x-4 gap-y-1'>
            <span className='text-slate-700 dark:text-slate-200'>
              Elapsed <span className='font-mono tabular-nums'>{fmtSecs(elapsedNow)}</span>
            </span>
            {est.current && (
              <span className='text-slate-700 dark:text-slate-200' data-runbook-current>
                Now: <span className='font-medium'>{labelOf(est.current)}</span>
                {subStep ? <span className='text-slate-500'> · {subStep}</span> : null}
              </span>
            )}
            {est.eta && (
              <span className='text-slate-700 dark:text-slate-200' data-runbook-eta>
                ETA{' '}
                <span className='font-mono tabular-nums'>
                  {new Date(Date.parse(est.eta) - skew.current).toLocaleTimeString([], {
                    hour: 'numeric',
                    minute: '2-digit'
                  })}
                </span>
                {est.remaining_secs != null && (
                  <span className='text-slate-500'> ({fmtAbout(est.remaining_secs)} left)</span>
                )}
              </span>
            )}
            {!est.eta && <span className='text-slate-500'>No timing history yet — no ETA.</span>}
          </div>
          {est.percent != null && (
            <div className='mt-2 flex items-center gap-2'>
              <div className='h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-white/10'>
                <div
                  className='h-full rounded-full bg-nvr-cyan transition-[width] duration-700'
                  style={{ width: `${est.percent}%` }}
                />
              </div>
              <span
                className='font-mono text-[11px] tabular-nums text-slate-500'
                data-runbook-percent
              >
                {est.percent}%
              </span>
            </div>
          )}
          {est.over_typical && est.current_typical_secs != null && (
            <p className='mt-1.5 text-amber-800 dark:text-amber-200' data-runbook-overrun>
              {labelOf(est.current as string)} is running longer than usual (typical{' '}
              {fmtAbout(est.current_typical_secs)}) — counted as finishing soon.
            </p>
          )}
          <p className='mt-1.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            Last output{' '}
            <span data-runbook-last-output>
              {sinceLine == null
                ? 'none yet'
                : `${fmtSecs(Math.max(0, Math.round(sinceLine)))} ago`}
            </span>
            {sinceBeat != null && (
              <> · agent reported {fmtSecs(Math.max(0, Math.round(sinceBeat)))} ago</>
            )}
          </p>
          {stalled && (
            <p className='mt-1 font-medium text-amber-800 dark:text-amber-200' data-runbook-stall>
              No output for {fmtSecs(Math.round(sinceLine as number))} — longer than{' '}
              {labelOf(est.current ?? '')} has ever been quiet ({fmtAbout(stallAfter)}). It may be
              stuck.
            </p>
          )}
          {agentSilent && (
            <p
              className='mt-1 font-medium text-rose-700 dark:text-rose-300'
              data-runbook-agent-silent
            >
              Host agent silent for {fmtSecs(Math.round(sinceBeat as number))} — the run may be
              lost.
            </p>
          )}
        </div>
      )}

      <ol
        className='mt-2 grid gap-x-6 gap-y-1 text-[12px] sm:grid-cols-2 xl:grid-cols-3'
        data-runbook-steps
      >
        {steps.map((s) => {
          const p = est?.phases.find((x) => x.key === s.step)
          const typical =
            p?.typical_secs ?? q.data?.typical?.phases.find((x) => x.key === s.step)?.secs ?? null
          return (
            <li key={s.step} data-runbook-step={s.step} data-runbook-step-status={s.status}>
              <details open={s.status === 'running' && !!s.lines?.length}>
                <summary className={cn('cursor-pointer list-none', tone[s.status])}>
                  <span className='inline-block w-4'>{mark[s.status]}</span>
                  <span className={host ? '' : 'font-mono'}>{host ? labelOf(s.step) : s.step}</span>
                  {s.secs != null && <span className='ml-1 text-slate-400'>{fmtSecs(s.secs)}</span>}
                  {typical != null &&
                    (s.status === 'ok' || s.status === 'pending' || s.status === 'running') && (
                      <span className='ml-1 text-slate-400'>
                        {s.status === 'pending'
                          ? `typical ${fmtAbout(typical)}`
                          : `vs ${fmtAbout(typical)}`}
                      </span>
                    )}
                  {s.status === 'running' && s.started_at && (
                    <span className='ml-1 text-slate-400'>
                      since {formatRelative(s.started_at)}
                    </span>
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
          )
        })}
      </ol>
      <div className='mt-2 flex items-center gap-2 text-[11.5px]'>
        <div className='flex overflow-hidden rounded border border-slate-200 dark:border-border'>
          {(
            [
              ['all', 'All output'],
              ['attention', 'Warnings & errors']
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type='button'
              onClick={() => setFilter(k)}
              aria-pressed={filter === k}
              data-runbook-log-filter={k}
              className={cn(
                'px-2 py-0.5',
                filter === k
                  ? 'bg-slate-100 font-medium text-slate-800 dark:bg-white/10 dark:text-slate-100'
                  : 'text-slate-500 hover:bg-muted dark:text-muted-foreground'
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {!follow && (
          <button
            type='button'
            className='text-nvr-navy underline-offset-2 hover:underline dark:text-nvr-cyan'
            onClick={() => setFollow(true)}
            data-runbook-follow
          >
            Jump to the latest output
          </button>
        )}
      </div>
      <pre
        ref={logRef}
        onScroll={(e) => {
          const el = e.currentTarget
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
        }}
        className='mt-1 max-h-80 overflow-y-auto rounded-md bg-[#0b1220] p-3 font-mono text-[11px] leading-snug text-slate-100'
        data-runbook-log
      >
        {shown || (filter === 'attention' ? 'No warnings or errors so far.' : '…')}
      </pre>
    </div>
  )
}
