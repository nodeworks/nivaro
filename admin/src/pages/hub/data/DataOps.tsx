import { ConfirmButton, ErrorNotice, QueryErrorState } from '@nivaro/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Loader2,
  MinusCircle,
  X
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { hubError } from '../hub-api'
import { dangerArmed, dangerGhost, Field, SectionCard } from '../hub-parts'
import {
  ago,
  type DataRun,
  type DataStep,
  dataKeys,
  type EnvDataView,
  fmtMs,
  KIND_LABEL,
  type RefreshPlan,
  STATUS_LABEL,
  untilWords,
  useEnvRuns
} from './data-api'

/** The Data tab's refresh, rehearsal and run history cards. */

function useInvalidate(envId: number) {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: dataKeys.env(envId) })
    void qc.invalidateQueries({ queryKey: dataKeys.runs(envId) })
    void qc.invalidateQueries({ queryKey: dataKeys.envs() })
  }
}

const CHECK_TONE = {
  ok: 'text-emerald-700 dark:text-emerald-400',
  warn: 'text-amber-700 dark:text-amber-400',
  fail: 'text-red-700 dark:text-red-400'
} as const

function CheckLine({ state, text }: { state: 'ok' | 'warn' | 'fail'; text: string }) {
  const Icon = state === 'ok' ? Check : state === 'warn' ? AlertTriangle : X
  return (
    <li className={cn('flex gap-2 text-[12px]', CHECK_TONE[state])}>
      <Icon className='mt-0.5 h-3.5 w-3.5 shrink-0' aria-hidden />
      <span className='text-slate-800 dark:text-foreground'>{text}</span>
    </li>
  )
}

export function RefreshCard({ v }: { v: EnvDataView }) {
  const envId = v.environment.id
  const invalidate = useInvalidate(envId)
  const [source, setSource] = useState(
    v.refresh_sources[0] ? String(v.refresh_sources[0].env_id) : ''
  )
  const [path, setPath] = useState('')
  const [plan, setPlan] = useState<RefreshPlan | null>(null)
  const [confirm, setConfirm] = useState('')
  const planBody = () => ({ source_env_id: Number(source), transfer_path: path.trim() || null })
  const doPlan = useMutation({
    mutationFn: () =>
      api
        .post<{ data: RefreshPlan }>(`/hub/environments/${envId}/data/refresh/plan`, planBody())
        .then((r) => r.data.data),
    onSuccess: (p) => {
      setPlan(p)
      setConfirm('')
    }
  })
  const start = useMutation({
    mutationFn: () =>
      api.post(`/hub/environments/${envId}/data/refresh`, {
        ...planBody(),
        plan_hash: plan?.plan_hash,
        confirm
      }),
    onSuccess: () => {
      toast.success('Refresh started')
      setPlan(null)
      invalidate()
    },
    onError: (err) => {
      const p = (err as { response?: { data?: { plan?: RefreshPlan } } }).response?.data?.plan
      if (p) setPlan(p)
    }
  })
  if (v.environment.production)
    return (
      <SectionCard
        title='Refresh'
        description='Production is never refreshed: the Hub only copies an environment down, onto a lower one.'
      >
        <p className='m-0 px-4 py-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
          {v.environment.key} counts as production ({v.environment.production_reasons.join('; ')}).
          To test with production data, refresh a lower environment from this one.
        </p>
      </SectionCard>
    )
  const rb = v.refresh_rollback
  if (!v.gate.refresh_enabled || !v.environment.refresh_target)
    return (
      <SectionCard
        title='Refresh from a higher environment'
        description='Copies the whole database of a higher environment over this one, keeping this environment’s own settings.'
      >
        <div className='space-y-3 p-4'>
          {!v.gate.refresh_enabled && (
            <p className='m-0 text-[12px] text-slate-600 dark:text-muted-foreground'>
              Refreshes are switched off on this Hub. An administrator turns them on under Switches
              ({v.gate_warning})
            </p>
          )}
          <RefreshTargetSwitch v={v} />
          {rb && !rb.refusal && (
            <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
              The last refresh can be undone only while refreshes are on and this environment is a
              refresh target.
            </p>
          )}
        </div>
      </SectionCard>
    )
  return (
    <SectionCard
      title='Refresh from a higher environment'
      description='Copies the whole database of a higher environment over this one, keeping this environment’s own settings (mail, keys, switches, service accounts). Both must run the same Nivaro version.'
    >
      <div className='space-y-3 p-4'>
        {v.refresh_sources.length === 0 ? (
          <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
            No higher environment to copy from.
          </p>
        ) : (
          <div className='flex flex-wrap items-end gap-2'>
            <div className='w-[200px]'>
              <Field id={`rf-src-${envId}`} label='Copy from'>
                <SimpleSelect
                  value={source}
                  onChange={(x) => {
                    setSource(x)
                    setPlan(null)
                  }}
                  ariaLabel='Copy from'
                  className='h-8 text-[13px]'
                  options={v.refresh_sources.map((s) => ({
                    value: String(s.env_id),
                    label: s.env_key
                  }))}
                />
              </Field>
            </div>
            <div className='min-w-[240px] flex-1'>
              <Field id={`rf-path-${envId}`} label='Shared folder (only across servers)'>
                <Input
                  id={`rf-path-${envId}`}
                  value={path}
                  onChange={(e) => {
                    setPath(e.target.value)
                    setPlan(null)
                  }}
                  placeholder='\\backup01\sql\refresh'
                  className='h-8 font-mono text-[13px]'
                />
              </Field>
            </div>
            <Button
              size='sm'
              variant='outline'
              disabled={!source || doPlan.isPending}
              onClick={() => doPlan.mutate()}
            >
              {doPlan.isPending && (
                <Loader2
                  className='h-3.5 w-3.5 animate-spin motion-reduce:animate-none'
                  aria-hidden
                />
              )}
              Plan the refresh
            </Button>
          </div>
        )}
        {doPlan.isError && (
          <ErrorNotice description={hubError(doPlan.error, 'Could not plan the refresh')} />
        )}
        {plan && (
          <div className='space-y-3 rounded-md border border-slate-200 p-3 dark:border-border'>
            <p className='m-0 text-[12px] text-slate-800 dark:text-foreground'>
              {plan.overwritten}
            </p>
            <ul className='m-0 list-none space-y-1 p-0'>
              {plan.checks.length === 0 && (
                <CheckLine state='ok' text='Nothing stands in the way.' />
              )}
              {plan.checks.map((c) => (
                <CheckLine key={c.id} state={c.state} text={c.text} />
              ))}
            </ul>
            <ul className='m-0 list-disc space-y-0.5 pl-5 text-[12px] text-slate-600 dark:text-muted-foreground'>
              {plan.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
            {plan.blocked && (
              <p className='m-0 text-[12px] font-medium text-red-700 dark:text-red-400'>
                This refresh cannot start yet: fix the refused checks above, then plan again.
              </p>
            )}
            <details open={plan.left_out.length > 0}>
              <summary className='cursor-pointer text-[12px] font-medium text-slate-700 dark:text-foreground'>
                What this environment keeps ({plan.kept.length}, from the app’s own list)
              </summary>
              <table className='mt-2 w-full text-[12px]'>
                <tbody>
                  {plan.kept.map((k) => (
                    <tr key={k.id} className='border-t border-slate-100 dark:border-border'>
                      <td className='py-1 pr-2 text-slate-800 dark:text-foreground'>{k.label}</td>
                      <td className='hidden py-1 pr-2 font-mono text-slate-500 sm:table-cell dark:text-muted-foreground'>
                        {k.table}
                      </td>
                      <td className='whitespace-nowrap py-1 text-right text-slate-500 dark:text-muted-foreground'>
                        {k.note ??
                          (k.rows == null ? '—' : `${k.rows} ${k.rows === 1 ? 'row' : 'rows'}`)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {plan.left_out.length > 0 && (
                <ul className='m-0 mt-2 list-none space-y-1 p-0'>
                  {plan.left_out.map((l) => (
                    <CheckLine key={l.id} state='warn' text={`${l.label}: not kept (${l.why}).`} />
                  ))}
                </ul>
              )}
            </details>
            {!plan.blocked && (
              <div className='flex flex-wrap items-end gap-2'>
                <div className='min-w-[240px] flex-1'>
                  <Field id={`rf-confirm-${envId}`} label={`Type ${plan.confirm} to replace it`}>
                    <Input
                      id={`rf-confirm-${envId}`}
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      autoComplete='off'
                      className='h-8 font-mono text-[13px]'
                    />
                  </Field>
                </div>
                <ConfirmButton
                  title={`Refresh ${plan.target.env_key} from ${plan.source.env_key}`}
                  confirmLabel={`Replace ${plan.confirm}?`}
                  className={dangerGhost}
                  armedClassName={dangerArmed}
                  disabled={confirm.trim() !== plan.confirm || start.isPending}
                  onConfirm={() => start.mutate()}
                >
                  Refresh {plan.target.env_key} from {plan.source.env_key}
                </ConfirmButton>
              </div>
            )}
          </div>
        )}
        {start.isError && (
          <ErrorNotice description={hubError(start.error, 'Could not start the refresh')} />
        )}
        <RefreshTargetSwitch v={v} />
        {rb && !plan && <RollbackBlock v={v} />}
      </div>
    </SectionCard>
  )
}

/** Opt this environment in (typed app/env) or out as a refresh target. */
function RefreshTargetSwitch({ v }: { v: EnvDataView }) {
  const envId = v.environment.id
  const invalidate = useInvalidate(envId)
  const want = `${v.app.key}/${v.environment.key}`
  const [typed, setTyped] = useState('')
  const set = useMutation({
    mutationFn: (on: boolean) =>
      api.put(`/hub/environments/${envId}/data/refresh-target`, { on, confirm: typed }),
    onSuccess: (_r, on) => {
      toast.success(on ? 'Refreshes may write over this environment' : 'Refresh target turned off')
      setTyped('')
      invalidate()
    }
  })
  const on = v.environment.refresh_target
  return (
    <div className='rounded-md border border-slate-200 p-3 dark:border-border'>
      <p className='m-0 text-[12px] font-semibold text-slate-800 dark:text-foreground'>
        Refresh target: {on ? 'on' : 'off'}
      </p>
      <p className='m-0 mt-0.5 text-[12px] text-slate-600 dark:text-muted-foreground'>
        {on
          ? 'A refresh may replace this environment’s database (it is never production).'
          : 'No refresh may write over this environment until an administrator turns this on.'}
      </p>
      {on ? (
        <Button
          size='sm'
          variant='outline'
          className='mt-2'
          disabled={set.isPending}
          onClick={() => set.mutate(false)}
        >
          Turn off
        </Button>
      ) : (
        <div className='mt-2 flex flex-wrap items-end gap-2'>
          <div className='min-w-[220px] flex-1'>
            <Field id={`rt-${envId}`} label={`Type ${want} to turn it on`}>
              <Input
                id={`rt-${envId}`}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete='off'
                className='h-8 font-mono text-[13px]'
              />
            </Field>
          </div>
          <Button
            size='sm'
            variant='outline'
            disabled={typed.trim() !== want || set.isPending}
            onClick={() => set.mutate(true)}
          >
            Allow refreshes here
          </Button>
        </div>
      )}
      {set.isError && <ErrorNotice description={hubError(set.error, 'Could not change it')} />}
    </div>
  )
}

/** Undo the newest refresh: the pinned database name is what a person types. */
function RollbackBlock({ v }: { v: EnvDataView }) {
  const envId = v.environment.id
  const invalidate = useInvalidate(envId)
  const rb = v.refresh_rollback
  const [typed, setTyped] = useState('')
  const rollback = useMutation({
    mutationFn: () => api.post(`/hub/data/runs/${rb?.run_id}/rollback`, { confirm: typed }),
    onSuccess: () => {
      toast.success('Rollback started')
      setTyped('')
      invalidate()
    }
  })
  if (!rb) return null
  const name = rb.database ?? ''
  return (
    <div className='border-t border-slate-200 pt-3 dark:border-border'>
      <h4 className='m-0 text-[12px] font-semibold text-slate-800 dark:text-foreground'>
        Undo the last refresh
      </h4>
      {rb.refusal ? (
        <p className='m-0 mt-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
          {rb.refusal}
        </p>
      ) : (
        <div className='mt-1 flex flex-wrap items-end gap-2'>
          <p className='m-0 w-full text-[12px] text-slate-600 dark:text-muted-foreground'>
            Puts {name} back as it was before refresh #{rb.run_id}, {untilWords(rb.expires_at)}.
          </p>
          <div className='min-w-[240px] flex-1'>
            <Field id={`rb-confirm-${envId}`} label={`Type ${name} to roll back`}>
              <Input
                id={`rb-confirm-${envId}`}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete='off'
                className='h-8 font-mono text-[13px]'
              />
            </Field>
          </div>
          <ConfirmButton
            title='Roll back the refresh'
            confirmLabel='Roll back to before the refresh?'
            className={dangerGhost}
            armedClassName={dangerArmed}
            disabled={!name || typed.trim() !== name || rollback.isPending}
            onConfirm={() => rollback.mutate()}
          >
            Roll back the refresh
          </ConfirmButton>
        </div>
      )}
      {rollback.isError && (
        <ErrorNotice description={hubError(rollback.error, 'Could not roll back')} />
      )}
    </div>
  )
}

export function RehearsalCard({ v }: { v: EnvDataView }) {
  const envId = v.environment.id
  const invalidate = useInvalidate(envId)
  const [shared, setShared] = useState(
    v.shared_deployments[0] ? String(v.shared_deployments[0].id) : ''
  )
  const start = useMutation({
    mutationFn: () =>
      api.post(`/hub/environments/${envId}/data/rehearsal`, { shared_id: Number(shared) }),
    onSuccess: () => {
      toast.success('Rehearsal started')
      invalidate()
    }
  })
  const last = v.latest.rehearsal
  const r = (last?.result ?? {}) as Record<string, unknown>
  const checks = r.checks as
    | { preflight?: { status: string; failing: string[] }; readiness_score?: number | null }
    | undefined
  const files = r.files as { ms?: number; total?: number; copied?: number } | undefined
  return (
    <SectionCard
      title='Rehearse a move onto a shared deployment'
      description='Copies the database into a scratch database, lists it on the deployment as a temporary app in maintenance, lets the deployment migrate and check it, copies the files, then removes everything. The live app is never touched.'
    >
      <div className='space-y-3 p-4'>
        {v.shared_deployments.length === 0 ? (
          <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
            No shared deployment to rehearse onto.
          </p>
        ) : (
          <div className='flex flex-wrap items-end gap-2'>
            <div className='w-[240px]'>
              <Field id={`rh-${envId}`} label='Shared deployment'>
                <SimpleSelect
                  value={shared}
                  onChange={setShared}
                  ariaLabel='Shared deployment'
                  className='h-8 text-[13px]'
                  options={v.shared_deployments.map((s) => ({
                    value: String(s.id),
                    label: s.name || s.key
                  }))}
                />
              </Field>
            </div>
            <Button
              size='sm'
              variant='outline'
              disabled={!shared || !v.native || !v.gate.rehearsal_enabled || start.isPending}
              onClick={() => start.mutate()}
            >
              Start a rehearsal
            </Button>
          </div>
        )}
        {!v.gate.rehearsal_enabled && (
          <p className='m-0 text-[12px] text-slate-600 dark:text-muted-foreground'>
            Move rehearsals are switched off on this Hub (Switches).
          </p>
        )}
        {start.isError && (
          <ErrorNotice description={hubError(start.error, 'Could not start the rehearsal')} />
        )}
        {last && (
          <dl className='m-0 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-3 dark:border-border dark:bg-border'>
            {[
              ['Last rehearsal', `${ago(last.started_at)} · ${STATUS_LABEL[last.status]}`],
              ['Database copy', `${fmtMs(r.backup_ms)} + ${fmtMs(r.restore_ms)}`],
              ['Migrate there', fmtMs(r.migrate_ms)],
              [
                'Preflight',
                checks?.preflight
                  ? `${checks.preflight.status}${checks.preflight.failing.length ? ` (${checks.preflight.failing.join(', ')})` : ''}`
                  : '—'
              ],
              ['Readiness', checks?.readiness_score != null ? String(checks.readiness_score) : '—'],
              [
                'Files',
                files ? `${files.copied ?? 0}/${files.total ?? 0} in ${fmtMs(files.ms)}` : '—'
              ]
            ].map(([label, value]) => (
              <div key={label} className='bg-white px-3 py-2 dark:bg-card'>
                <dt className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
                  {label}
                </dt>
                <dd className='m-0 mt-0.5 text-[13px] text-slate-900 [overflow-wrap:anywhere] dark:text-foreground'>
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </SectionCard>
  )
}

const STEP_ICON: Record<DataStep['state'], typeof Check> = {
  pending: CircleDashed,
  running: Loader2,
  done: Check,
  skipped: MinusCircle,
  warn: AlertTriangle,
  failed: X
}

const STEP_TONE: Record<DataStep['state'], string> = {
  pending: 'text-slate-400 dark:text-muted-foreground',
  running: 'animate-spin text-nvr-cyan',
  done: 'text-emerald-600 dark:text-emerald-400',
  skipped: 'text-slate-400 dark:text-muted-foreground',
  warn: 'text-amber-600 dark:text-amber-400',
  failed: 'text-red-600 dark:text-red-400'
}

const RUN_TONE: Record<string, string> = {
  done: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300',
  running:
    'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300',
  waiting:
    'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300',
  interrupted:
    'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300',
  failed:
    'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300',
  refused:
    'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300',
  cancelled:
    'border-slate-200 bg-slate-50 text-slate-700 dark:border-border dark:bg-muted dark:text-muted-foreground'
}

function RunRow({ run, envId }: { run: DataRun; envId: number }) {
  const [open, setOpen] = useState(
    run.status === 'running' || run.status === 'failed' || run.status === 'interrupted'
  )
  const invalidate = useInvalidate(envId)
  const resume = useMutation({
    mutationFn: () => api.post(`/hub/data/runs/${run.id}/resume`, {}),
    onSuccess: () => {
      toast.success(run.kind === 'refresh' ? 'Refresh resumed' : 'Rollback resumed')
      invalidate()
    }
  })
  const [typed, setTyped] = useState('')
  const abandon = useMutation({
    mutationFn: () => api.post(`/hub/data/runs/${run.id}/abandon`, { confirm: typed }),
    onSuccess: () => {
      toast.success('Run abandoned')
      setTyped('')
      invalidate()
    }
  })
  const resumable =
    (run.kind === 'refresh' || run.kind === 'refresh_rollback') &&
    (run.status === 'interrupted' || run.status === 'failed') &&
    !run.artifact?.rolled_back_at &&
    !run.artifact?.abandoned_at
  const abandonable =
    run.status === 'interrupted' || (run.kind === 'refresh' && run.status === 'failed')
  const want = run.abandon_confirm ?? String(run.id)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <li className='border-t border-slate-100 first:border-t-0 dark:border-border'>
      <button
        type='button'
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className='flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-muted'
      >
        <Chevron className='h-3.5 w-3.5 shrink-0 text-slate-400' aria-hidden />
        <span className='flex-1 truncate text-[13px] text-slate-900 dark:text-foreground'>
          {KIND_LABEL[run.kind]}
          <span className='ml-2 text-[11px] text-slate-500 dark:text-muted-foreground'>
            #{run.id} · {ago(run.started_at)}
            {run.started_via === 'schedule' ? ' · scheduled' : ''}
          </span>
        </span>
        <span
          className={cn(
            'rounded-full border px-2 py-px text-[11px] font-medium',
            RUN_TONE[run.status]
          )}
        >
          {STATUS_LABEL[run.status]}
        </span>
      </button>
      {open && (
        <div className='space-y-2 px-4 pb-3 pl-10'>
          {run.error && (
            <p className='m-0 text-[12px] text-red-700 [overflow-wrap:anywhere] dark:text-red-400'>
              {run.error}
            </p>
          )}
          <ol className='m-0 list-none space-y-1 p-0'>
            {run.steps.map((s) => {
              const Icon = STEP_ICON[s.state]
              return (
                <li key={s.key} className='flex gap-2 text-[12px]'>
                  <Icon
                    className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', STEP_TONE[s.state])}
                    role='img'
                    aria-label={s.state}
                  />
                  <span className='min-w-0 flex-1'>
                    <span className='text-slate-800 dark:text-foreground'>{s.label}</span>
                    {s.ms != null && (
                      <span className='ml-1 text-slate-500 dark:text-muted-foreground'>
                        · {fmtMs(s.ms)}
                      </span>
                    )}
                    {s.note && (
                      <span className='block text-slate-500 [overflow-wrap:anywhere] dark:text-muted-foreground'>
                        {s.note}
                      </span>
                    )}
                  </span>
                </li>
              )
            })}
          </ol>
          {resumable && (
            <Button
              size='sm'
              variant='outline'
              disabled={resume.isPending}
              onClick={() => resume.mutate()}
            >
              {run.kind === 'refresh' ? 'Resume the refresh' : 'Resume the rollback'}
            </Button>
          )}
          {abandonable && (
            <div className='flex flex-wrap items-end gap-2 border-t border-slate-100 pt-2 dark:border-border'>
              <div className='min-w-[200px] flex-1'>
                <Field id={`ab-${run.id}`} label={`Type ${want} to abandon this run`}>
                  <Input
                    id={`ab-${run.id}`}
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    autoComplete='off'
                    className='h-8 font-mono text-[13px]'
                  />
                </Field>
              </div>
              <ConfirmButton
                title='Abandon'
                confirmLabel='Abandon this run?'
                className={dangerGhost}
                armedClassName={dangerArmed}
                disabled={typed.trim() !== want || abandon.isPending}
                onConfirm={() => abandon.mutate()}
              >
                Abandon
              </ConfirmButton>
            </div>
          )}
          {abandon.isError && (
            <ErrorNotice description={hubError(abandon.error, 'Could not abandon')} />
          )}
          {resume.isError && (
            <ErrorNotice description={hubError(resume.error, 'Could not resume')} />
          )}
        </div>
      )}
    </li>
  )
}

export function RunsCard({ envId }: { envId: number }) {
  const runs = useEnvRuns(envId)
  return (
    <div id='data-history' className='scroll-mt-4'>
      <SectionCard
        title='History'
        description='Every backup, drill, refresh and rehearsal of this environment, newest first.'
      >
        {runs.isPending ? (
          <div className='p-4'>
            <Skeleton className='h-16 w-full' />
          </div>
        ) : runs.isError ? (
          <QueryErrorState
            error={runs.error}
            what='the history'
            onRetry={() => void runs.refetch()}
            className='m-4'
          />
        ) : runs.data.length === 0 ? (
          <p className='m-0 px-4 py-6 text-center text-[12px] text-slate-500 dark:text-muted-foreground'>
            Nothing has run here yet.
          </p>
        ) : (
          <ul className='m-0 list-none p-0'>
            {runs.data.map((r) => (
              <RunRow key={r.id} run={r} envId={envId} />
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  )
}
