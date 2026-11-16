import { ErrorNotice, toastError } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Check, ChevronRight, CircleAlert, CircleX, Undo2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { CollapsibleCard, type SummaryTone, useCardOpen } from '@/components/collapsible-card'
import { RunbookRunView } from '@/components/runbooks-card'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

/**
 * Environments → Runbooks → Refresh an environment. Copies one environment's database over another
 * (Production → Staging …) while the target keeps what is its own — external APIs, mail, keys,
 * switches, service and test accounts — then switches off anything that could reach real people
 * or partners. The flow: pick a direction → Dry run (the plan, in plain words, at once; the host
 * repeats the checks and that finished dry run unlocks the real run) → Run refresh, typing the
 * target database → progress from the runbook queue → Roll back within 24 hours.
 * API: /api/env-refresh (routes/env-refresh.ts). Production is never offered as a target.
 */

type RunState = 'running' | 'done' | 'failed' | 'cancelled' | 'lost' | 'queued' | 'refused'
interface HostRun {
  id: string
  extension: string
  runbook: string
  mode: 'dry' | 'go'
  target: string | null
  state: RunState
  host: string | null
  started_at: string
  finished_at?: string
  failed_step?: string
  summary?: string
}
interface Env {
  key: string
  label: string
  database: string
  production: boolean
}
interface Direction {
  key: string
  from: string
  to: string
  fresh_dry_run: { id: string; finished_at: string } | null
}
interface Overview {
  available: boolean
  runbook?: string
  rollback_runbook?: string | null
  rollback_hours?: number
  environments?: Env[]
  directions?: Direction[]
  rollback?: Array<{
    target: string
    until: string | null
    fresh_dry_run: { id: string; finished_at: string } | null
  }>
  runs?: HostRun[]
  active?: HostRun | null
  agents?: Array<{ host: string; last_seen: string; online: boolean }>
}
interface PreflightCheck {
  id: string
  state: 'ok' | 'warn' | 'fail'
  label: string
  detail?: string
}
interface Kept {
  id: string
  label: string
  reason: string
  table: string
  kind: 'table' | 'columns' | 'rows' | 'delegate'
  rows: number
  columns: string[]
  sample: Array<{ key: string; values: Record<string, string> }>
  note?: string
}
interface SafetyAction {
  id: string
  label: string
  count: number
  names?: string[]
  error?: string
}
export interface Plan {
  direction: string
  source: { key: string; label: string; database: string }
  target: { key: string; label: string; database: string }
  ready: boolean
  preflight: PreflightCheck[]
  copied: { tables: number; rows: number; used_mb: number | null }
  kept: Kept[]
  switched_off: SafetyAction[]
  files: string
  rollback_hours: number
  generated_at: string
}

/** Pure: MB as `1.2 GB` / `640 MB`. */
export function fmtSize(mb: number | null | undefined): string {
  if (mb == null) return ''
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

/** Pure: what a kept item puts back, in words. */
export function keptWhat(k: Pick<Kept, 'kind' | 'rows' | 'columns' | 'note' | 'table'>): string {
  const rows = `${k.rows.toLocaleString('en-US')} row${k.rows === 1 ? '' : 's'}`
  const fields = `${k.columns.length} field${k.columns.length === 1 ? '' : 's'}`
  if (k.kind === 'table') return `The whole table — ${rows}`
  if (k.kind === 'columns')
    return k.table === 'nivaro_settings'
      ? `${fields} of the settings row`
      : `${fields} on ${rows}, matched by ${k.table === 'nivaro_sso_providers' ? 'key' : 'name'}`
  if (k.kind === 'rows') return rows
  return k.note ?? 'Kept by its own step'
}

/** Pure: the card's one-line summary. */
export function envRefreshSummary(
  data: Overview,
  envName: (key: string) => string,
  now = Date.now()
): { text: string; tone: SummaryTone; attention: boolean } {
  const active = data.active
  if (active) {
    const what =
      active.runbook === data.rollback_runbook
        ? `Rolling back ${envName(active.target ?? '')}`
        : `${active.mode === 'dry' ? 'Checking' : 'Refreshing'} ${envName(active.target?.split('-to-')[1] ?? '')}`
    return {
      text: `${what} — ${active.state === 'queued' ? 'waiting for the host' : 'running'}`,
      tone: 'warn',
      attention: true
    }
  }
  const lastGo = (data.runs ?? []).find((r) => r.mode === 'go')
  if (lastGo?.state === 'failed' || lastGo?.state === 'lost')
    return {
      text: `The last refresh stopped at ${lastGo.failed_step ?? 'a step'}`,
      tone: 'bad',
      attention: true
    }
  const open = (data.rollback ?? []).find((r) => r.until && Date.parse(r.until) > now)
  if (open)
    return {
      text: `${envName(open.target)} refreshed — roll back possible until ${new Date(open.until!).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`,
      tone: 'ok',
      attention: false
    }
  return {
    text: (data.directions ?? []).map((d) => `${envName(d.from)} → ${envName(d.to)}`).join(' · '),
    tone: 'muted',
    attention: false
  }
}

export function EnvRefreshCard() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['env-refresh'],
    queryFn: () => api.get<Overview>('/env-refresh').then((r) => r.data),
    refetchInterval: (x) => (x.state.data?.active ? 3_000 : 30_000),
    retry: false
  })
  const data = q.data
  const envs = data?.environments ?? []
  const envName = (key: string) => envs.find((e) => e.key === key)?.label ?? key
  const envOf = (key: string) => envs.find((e) => e.key === key)
  const [direction, setDirection] = useState<string>(() => data?.directions?.[0]?.key ?? '')
  const [plan, setPlan] = useState<Plan | null>(null)
  const [asking, setAsking] = useState<'go' | 'rollback' | null>(null)
  const [confirm, setConfirm] = useState('')
  const [openRun, setOpenRun] = useState<string | null>(null)

  useEffect(() => {
    if (!direction && data?.directions?.length) setDirection(data.directions[0].key)
  }, [data?.directions, direction])
  useEffect(() => {
    if (data?.active && !openRun) setOpenRun(data.active.id)
  }, [data?.active, openRun])

  const dir = data?.directions?.find((d) => d.key === direction) ?? null
  const target = dir ? envOf(dir.to) : undefined
  const source = dir ? envOf(dir.from) : undefined
  const rollback = target ? data?.rollback?.find((r) => r.target === target.key) : undefined
  const busy = !!data?.active
  const agentOnline = (data?.agents ?? []).some((a) => a.online)

  const planQ = useMutation({
    mutationFn: (d: string) =>
      api.post<{ plan: Plan }>('/env-refresh/plan', { direction: d }).then((r) => r.data.plan)
  })
  const queue = useMutation({
    mutationFn: (body: { mode: 'dry' | 'go'; confirm?: string }) =>
      api
        .post<{ run: HostRun }>('/env-refresh/runs', { direction, ...body })
        .then((r) => r.data.run),
    onSuccess: (run) => {
      setAsking(null)
      setConfirm('')
      setOpenRun(run.id)
      void qc.invalidateQueries({ queryKey: ['env-refresh'] })
      void qc.invalidateQueries({ queryKey: ['runbooks'] })
    },
    onError: (e) => toastError(e, 'The refresh could not be queued')
  })
  const back = useMutation({
    mutationFn: (body: { mode: 'dry' | 'go'; confirm?: string }) =>
      api
        .post<{ run: HostRun }>('/env-refresh/rollback', { target: target?.key, ...body })
        .then((r) => r.data.run),
    onSuccess: (run) => {
      setAsking(null)
      setConfirm('')
      setOpenRun(run.id)
      void qc.invalidateQueries({ queryKey: ['env-refresh'] })
    },
    onError: (e) => toastError(e, 'The roll back could not be queued')
  })

  const dryRun = () => {
    if (!direction) return
    setAsking(null)
    planQ.mutate(direction, {
      onSuccess: (p) => {
        setPlan(p)
        // The host repeats the checks; its finished dry run is what unlocks the real run.
        if (p.ready && !busy) queue.mutate({ mode: 'dry' })
      },
      onError: () => setPlan(null)
    })
  }
  const shownPlan = plan && plan.direction === direction ? plan : null
  const sum = data?.available ? envRefreshSummary(data, envName) : null
  const [cardOpen, setCardOpen] = useCardOpen('env-refresh', sum?.attention ?? false)
  if (!data?.available) return null

  const unlocked = !!dir?.fresh_dry_run && !busy
  const rollbackOpen = !!rollback?.until && !busy
  const runs = data.runs ?? []
  return (
    <CollapsibleCard
      data-env-refresh-card
      title='Refresh an environment'
      summary={sum?.text ?? ''}
      tone={sum?.tone ?? 'muted'}
      open={cardOpen}
      onOpenChange={setCardOpen}
    >
      <p className='mt-1 max-w-[86ch] text-[12px] text-slate-500 dark:text-muted-foreground'>
        Copies one environment’s database over another. The target keeps what is its own — external
        APIs, mail, keys, switches, service and test accounts — and anything that could reach real
        people or partners is switched off. People’s data comes across as it is. Files are not
        copied; the target reads the source’s, read-only.
      </p>

      <div className='mt-3 flex flex-wrap items-center gap-2'>
        <div
          role='radiogroup'
          aria-label='Direction'
          className='inline-flex flex-wrap rounded-md border border-slate-200 bg-slate-50 p-0.5 dark:border-border dark:bg-muted/40'
          data-env-refresh-directions
        >
          {(data.directions ?? []).map((d) => {
            const on = d.key === direction
            return (
              // A segmented control: buttons styled as one strip, announced as a radio group.
              // biome-ignore lint/a11y/useSemanticElements: segmented control, not native radios
              <button
                key={d.key}
                type='button'
                role='radio'
                aria-checked={on}
                onClick={() => {
                  setDirection(d.key)
                  setAsking(null)
                  setConfirm('')
                }}
                data-env-refresh-direction={d.key}
                className={cn(
                  'flex items-center gap-1.5 rounded px-3 py-1.5 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
                  on
                    ? 'bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.08)] dark:bg-card dark:text-foreground'
                    : 'text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
                )}
              >
                {envName(d.from)}
                <ArrowRight className='h-3 w-3 opacity-60' aria-hidden />
                {envName(d.to)}
              </button>
            )
          })}
        </div>
        <Button
          size='sm'
          variant='outline'
          disabled={!direction || planQ.isPending || busy}
          onClick={dryRun}
          data-env-refresh-dry
        >
          {planQ.isPending ? 'Reading both databases…' : 'Dry run'}
        </Button>
        <Button
          size='sm'
          disabled={!unlocked}
          onClick={() => {
            setConfirm('')
            setAsking('go')
          }}
          title={
            unlocked
              ? undefined
              : 'Needs a finished dry run of this direction from the last 24 hours'
          }
          data-env-refresh-go
        >
          Run refresh
        </Button>
        {rollback?.until && (
          <Button
            size='sm'
            variant='outline'
            disabled={!rollbackOpen || back.isPending}
            onClick={() => {
              setConfirm('')
              if (rollback.fresh_dry_run) setAsking('rollback')
              else back.mutate({ mode: 'dry' })
            }}
            data-env-refresh-rollback
          >
            <Undo2 className='h-3.5 w-3.5' aria-hidden />
            {rollback.fresh_dry_run
              ? `Roll back ${target?.label}`
              : `Check roll back of ${target?.label}`}
          </Button>
        )}
      </div>

      {source && target && (
        <p
          className='mt-2 text-[12px] text-slate-500 dark:text-muted-foreground'
          data-env-refresh-gate
        >
          <span className='font-mono text-[11.5px] text-slate-700 dark:text-slate-200'>
            {source.database}
          </span>
          {' → '}
          <span className='font-mono text-[11.5px] text-slate-700 dark:text-slate-200'>
            {target.database}
          </span>
          {' · '}
          {busy
            ? data.active?.state === 'queued'
              ? 'A run is queued — the host agent picks it up within a minute.'
              : `A run is going on ${data.active?.host ?? 'the host'}.`
            : dir?.fresh_dry_run
              ? `Host dry run passed ${formatRelative(dir.fresh_dry_run.finished_at)} — a real run is unlocked for 24 hours.`
              : 'Run the dry run first: you read the plan, and the host repeats the checks.'}
          {!agentOnline && ' No host agent has checked in recently — queued runs wait for it.'}
        </p>
      )}
      {rollback?.until && (
        <p
          className='mt-1 text-[12px] text-slate-500 dark:text-muted-foreground'
          data-env-refresh-rollback-window
        >
          {target?.label} can be put back to how it was before its last refresh until{' '}
          {new Date(rollback.until).toLocaleString([], {
            weekday: 'short',
            hour: 'numeric',
            minute: '2-digit'
          })}
          .
        </p>
      )}

      {asking && target && (
        <div
          className='mt-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-[12px] text-amber-950 dark:border-amber-500/40 dark:bg-amber-400/10 dark:text-amber-100'
          data-env-refresh-confirm
        >
          <span className='max-w-[70ch]'>
            {asking === 'go'
              ? `Everything in ${target.database} is replaced by ${source?.label}’s data; what ${target.label} keeps is put back. ${target.label} shows a maintenance page while it runs.`
              : `${target.database} goes back to the backup taken before its last refresh. Anything changed since is lost.`}{' '}
            Type <span className='font-mono font-semibold'>{target.database}</span> to confirm:
          </span>
          <input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            aria-label={`Type ${target.database} to confirm`}
            autoComplete='off'
            spellCheck={false}
            className='h-7 w-44 rounded border border-amber-300 bg-white px-1.5 font-mono text-[12px] text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-amber-500/40 dark:bg-background dark:text-foreground'
            data-env-refresh-confirm-input
          />
          <Button
            size='sm'
            disabled={confirm !== target.database || queue.isPending || back.isPending}
            onClick={() =>
              asking === 'go'
                ? queue.mutate({ mode: 'go', confirm })
                : back.mutate({ mode: 'go', confirm })
            }
            data-env-refresh-confirm-go
          >
            {asking === 'go' ? `Refresh ${target.label}` : `Roll back ${target.label}`}
          </Button>
          <Button size='sm' variant='outline' onClick={() => setAsking(null)}>
            Cancel
          </Button>
        </div>
      )}

      {planQ.isError && (
        <ErrorNotice error={planQ.error} what='the plan' onRetry={dryRun} className='mt-3' />
      )}
      {shownPlan && <PlanView plan={shownPlan} />}

      {openRun && <RunbookRunView key={openRun} id={openRun} />}

      {runs.length > 0 && (
        <ul className='mt-3 space-y-0.5 text-[12px]' data-env-refresh-history>
          {runs.slice(0, 6).map((r) => (
            <li key={r.id}>
              <button
                type='button'
                className='text-slate-600 underline-offset-2 hover:underline dark:text-slate-300'
                onClick={() => setOpenRun(r.id)}
              >
                {r.runbook === data.rollback_runbook
                  ? `${r.mode === 'dry' ? 'roll back check' : 'roll back'} · ${envName(r.target ?? '')}`
                  : `${r.mode === 'dry' ? 'dry run' : 'refresh'} · ${(r.target ?? '').split('-to-').map(envName).join(' → ')}`}{' '}
                · {r.state}
                {r.failed_step ? ` at ${r.failed_step}` : ''} · {formatRelative(r.started_at)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </CollapsibleCard>
  )
}

const CHECK_ICON = {
  ok: <Check className='h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400' aria-label='passed' />,
  warn: (
    <CircleAlert className='h-3.5 w-3.5 text-amber-600 dark:text-amber-400' aria-label='warning' />
  ),
  fail: <CircleX className='h-3.5 w-3.5 text-rose-600 dark:text-rose-400' aria-label='failed' />
}

export function PlanView({ plan }: { plan: Plan }) {
  return (
    <div
      className='mt-4 text-[12px]'
      data-env-refresh-plan
      data-ready={plan.ready ? 'true' : 'false'}
    >
      <div className='flex flex-wrap items-baseline justify-between gap-2'>
        <h3 className='text-[12.5px] font-semibold text-slate-900 dark:text-foreground'>
          Refresh {plan.target.label} from {plan.source.label}
        </h3>
        <span className='text-[11.5px] text-slate-400 dark:text-muted-foreground'>
          Plan read {formatRelative(plan.generated_at)} · nothing was written
        </span>
      </div>

      <ul className='mt-2 space-y-1' data-env-refresh-preflight>
        {plan.preflight.map((c) => (
          <li
            key={c.id}
            className='flex items-start gap-2'
            data-check={c.id}
            data-check-state={c.state}
          >
            <span className='mt-0.5 shrink-0'>{CHECK_ICON[c.state]}</span>
            <span className='text-slate-700 dark:text-slate-200'>
              {c.label}
              {c.detail && (
                <span className='text-slate-500 dark:text-muted-foreground'> — {c.detail}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {!plan.ready && (
        <p className='mt-2 font-medium text-rose-700 dark:text-rose-300'>
          Not ready: fix the failed checks, then run the dry run again.
        </p>
      )}

      <div className='mt-4 grid gap-x-8 gap-y-5 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.4fr)_minmax(0,1fr)]'>
        <section data-env-refresh-copied>
          <h4 className='text-[12px] font-semibold text-slate-800 dark:text-slate-100'>
            Copied from {plan.source.label}
          </h4>
          <p className='mt-1 text-slate-600 dark:text-slate-300'>
            Everything in <span className='font-mono text-[11.5px]'>{plan.source.database}</span>:{' '}
            {plan.copied.tables.toLocaleString('en-US')} tables, about{' '}
            {plan.copied.rows.toLocaleString('en-US')} rows
            {plan.copied.used_mb != null ? ` (${fmtSize(plan.copied.used_mb)})` : ''}. People and
            their data come across as they are.
          </p>
          <p className='mt-2 text-slate-500 dark:text-muted-foreground'>{plan.files}</p>
          <p className='mt-2 text-slate-500 dark:text-muted-foreground'>
            {plan.target.label} is backed up first; Roll back puts it back for {plan.rollback_hours}{' '}
            hours.
          </p>
        </section>

        <section data-env-refresh-kept>
          <h4 className='text-[12px] font-semibold text-slate-800 dark:text-slate-100'>
            Kept on {plan.target.label}
          </h4>
          <ul className='mt-1 divide-y divide-slate-100 dark:divide-border'>
            {plan.kept.map((k) => (
              <li key={k.id} className='py-1.5' data-kept={k.id}>
                <details className='group'>
                  <summary className='flex cursor-pointer list-none items-start gap-1.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan [&::-webkit-details-marker]:hidden'>
                    <ChevronRight
                      className='mt-0.5 h-3 w-3 shrink-0 text-slate-400 transition-transform group-open:rotate-90'
                      aria-hidden
                    />
                    <span className='min-w-0'>
                      <span className='font-medium text-slate-800 dark:text-slate-100'>
                        {k.label}
                      </span>
                      <span className='block text-slate-500 dark:text-muted-foreground'>
                        {keptWhat(k)}
                        {k.note && k.kind !== 'delegate' ? ` — ${k.note}` : ''}
                      </span>
                    </span>
                  </summary>
                  <div className='ml-[18px] mt-1.5'>
                    <p className='text-slate-500 dark:text-muted-foreground'>{k.reason}</p>
                    {k.sample.length > 0 && (
                      <div className='mt-1.5 max-h-64 overflow-auto rounded border border-slate-200 dark:border-border'>
                        <table className='w-full text-[11.5px]'>
                          <tbody>
                            {k.sample.map((r) => (
                              <tr
                                key={r.key}
                                className='border-b border-slate-100 align-top last:border-0 dark:border-border'
                              >
                                <th
                                  scope='row'
                                  className='whitespace-nowrap bg-slate-50 px-2 py-1 text-left font-medium text-slate-700 dark:bg-muted/40 dark:text-slate-200'
                                >
                                  {r.key}
                                </th>
                                <td className='px-2 py-1 text-slate-600 dark:text-slate-300'>
                                  {Object.entries(r.values).map(([c, v]) => (
                                    <span key={c} className='mr-3 inline-block break-all'>
                                      <span className='font-mono text-slate-400 dark:text-muted-foreground'>
                                        {c}
                                      </span>{' '}
                                      <span
                                        className={cn(
                                          v === 'set' && 'italic',
                                          v === 'empty' && 'text-slate-400'
                                        )}
                                      >
                                        {v}
                                      </span>
                                    </span>
                                  ))}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {k.rows > k.sample.length && k.sample.length > 0 && (
                      <p className='mt-1 text-slate-400 dark:text-muted-foreground'>
                        Showing {k.sample.length} of {k.rows.toLocaleString('en-US')}.
                      </p>
                    )}
                  </div>
                </details>
              </li>
            ))}
          </ul>
          <p className='mt-1 text-slate-400 dark:text-muted-foreground'>
            Credentials show only whether they are set.
          </p>
        </section>

        <section data-env-refresh-switched>
          <h4 className='text-[12px] font-semibold text-slate-800 dark:text-slate-100'>
            Switched off on {plan.target.label}
          </h4>
          <p className='mt-1 text-slate-500 dark:text-muted-foreground'>
            Always, after every copy.
          </p>
          <ul className='mt-1.5 space-y-1.5'>
            {plan.switched_off.map((s) => (
              <li
                key={s.id}
                data-switched={s.id}
                className='grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2'
              >
                <span
                  className={cn(
                    'text-right tabular-nums',
                    s.error
                      ? 'text-rose-700 dark:text-rose-300'
                      : s.count
                        ? 'font-semibold text-slate-900 dark:text-foreground'
                        : 'text-slate-400 dark:text-muted-foreground'
                  )}
                >
                  {s.error
                    ? 'unread'
                    : s.id === 'test-modes'
                      ? 'on'
                      : s.count === 0
                        ? 'none'
                        : s.count.toLocaleString('en-US')}
                </span>
                <span className='min-w-0 text-slate-700 dark:text-slate-200'>
                  {s.label}
                  {s.error && (
                    <span className='block text-rose-700 dark:text-rose-300'>
                      Could not be checked.
                    </span>
                  )}
                  {s.names && s.names.length > 0 && s.id !== 'test-modes' && (
                    <span className='block text-slate-500 dark:text-muted-foreground'>
                      {s.names.slice(0, 8).join(', ')}
                      {s.names.length > 8 ? ', …' : ''}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}
