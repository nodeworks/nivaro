import { ConfirmButton, QueryErrorState } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, Plus, Snowflake, Train, Undo2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { MonCombobox } from '@/components/filter-combobox'
import { envTone } from '@/components/hub-brand/env-tone'
import { HubEnvTag } from '@/components/hub-brand/HubBits'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useAuth } from '@/lib/auth'
import { cn, formatDateTime, formatRelative } from '@/lib/utils'
import { hubToast } from '../hub-api'
import { dangerArmed, dangerGhost, Field, ghostButton, SectionCard } from '../hub-parts'
import {
  abortTrain,
  cancelSchedule,
  createSchedule,
  deleteFreeze,
  deleteRollbackRule,
  fetchReleases,
  type HubFreeze,
  type HubTrain,
  isoToLocalInput,
  localInputToIso,
  type ReleaseEnv,
  type ReleasesOverview,
  type RollbackRule,
  releaseKeys,
  SCHEDULE_WORDS,
  saveFreeze,
  saveRollbackRule,
  skipTrainStep,
  startTrain,
  TRAIN_STATUS_WORDS,
  TRAIN_STEP_WORDS,
  type TrainStepInput,
  viewerTimeZone,
  WATCH_WORDS
} from './releases-api'

/**
 * Releases (Apps hub tab): release trains, scheduled promotions, freeze windows and automatic
 * rollback rules. Everyone who owns an app sees its rows; only administrators change anything.
 * Every time is shown in the viewer's own zone (the Hub stores UTC).
 */
export default function HubReleases() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  const q = useQuery({
    queryKey: releaseKeys.overview(),
    queryFn: fetchReleases,
    refetchInterval: (query) =>
      query.state.data?.trains.some((t) => t.status === 'running') ||
      query.state.data?.watches.some((w) => w.status === 'watching')
        ? 15_000
        : 60_000
  })
  return (
    <section aria-labelledby='hub-releases-title' className='flex flex-1 min-h-0 flex-col'>
      <header className='flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2.5 dark:border-border dark:bg-card'>
        <h2
          id='hub-releases-title'
          className='m-0 min-w-0 flex-1 truncate text-[13px] font-semibold text-slate-900 dark:text-foreground'
        >
          Releases
        </h2>
        <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
          Times in {viewerTimeZone()}
        </span>
      </header>
      <div className='flex-1 overflow-y-auto bg-slate-50 p-4 dark:bg-background'>
        {q.isPending ? (
          <Skeleton className='h-40 w-full' />
        ) : q.isError ? (
          <QueryErrorState error={q.error} what='the releases' onRetry={() => void q.refetch()} />
        ) : (
          <div className='space-y-4'>
            <TrainsCard data={q.data} isAdmin={isAdmin} />
            <SchedulesCard data={q.data} isAdmin={isAdmin} />
            <FreezesCard data={q.data} isAdmin={isAdmin} />
            <RollbackCard data={q.data} isAdmin={isAdmin} />
          </div>
        )}
      </div>
    </section>
  )
}

const appKey = (d: ReleasesOverview, id: number | null) =>
  id == null ? 'Every app' : (d.apps.find((a) => a.id === id)?.key ?? `#${id}`)
const envKey = (d: ReleasesOverview, id: number | null) =>
  id == null ? '—' : (d.environments.find((e) => e.id === id)?.key ?? `#${id}`)

function useRefresh() {
  const qc = useQueryClient()
  return () => void qc.invalidateQueries({ queryKey: releaseKeys.overview() })
}

const tone = (s: string) =>
  s === 'failed' || s === 'held' || s === 'aborted'
    ? 'text-red-700 dark:text-red-300'
    : s === 'rolled_back' || s === 'waiting'
      ? 'text-amber-700 dark:text-amber-300'
      : s === 'done' || s === 'passed' || s === 'started'
        ? 'text-emerald-700 dark:text-emerald-300'
        : 'text-slate-700 dark:text-slate-300'

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className='m-0 px-4 py-3 text-[12px] text-slate-500 dark:text-muted-foreground'>{children}</p>
)

// ─── Release trains ────────────────────────────────────────────────────────────

interface StepDraft extends TrainStepInput {
  on: boolean
}

function promotableEnvs(d: ReleasesOverview, appId: number) {
  return d.environments
    .filter((e) => e.app_id === appId && e.placed && !e.on_shared)
    .sort((a, b) => a.position - b.position)
}

function StepsEditor({
  envs,
  steps,
  onChange,
  idPrefix
}: {
  envs: ReleaseEnv[]
  steps: StepDraft[]
  onChange: (s: StepDraft[]) => void
  idPrefix: string
}) {
  const set = (i: number, patch: Partial<StepDraft>) =>
    onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  if (!envs.length)
    return (
      <p className='m-0 text-[12px] text-slate-500'>This app has no environment the Hub deploys.</p>
    )
  return (
    <div className='space-y-1.5'>
      <div className='hidden grid-cols-[minmax(0,1fr)_90px_110px_110px] gap-2 text-[11px] font-medium text-slate-500 sm:grid dark:text-muted-foreground'>
        <span>Environment (in order)</span>
        <span>Soak (min)</span>
        <span>Min. readiness</span>
        <span>Hold up to (min)</span>
      </div>
      {steps.map((s, i) => {
        const env = envs.find((e) => e.id === s.environment_id) as ReleaseEnv
        return (
          <div
            key={s.environment_id}
            className='grid grid-cols-2 items-center gap-2 sm:grid-cols-[minmax(0,1fr)_90px_110px_110px]'
          >
            <div className='col-span-2 flex items-center gap-2 text-[12px] sm:col-span-1'>
              <Switch
                checked={s.on}
                onCheckedChange={(v) => set(i, { on: v })}
                aria-label={`Include ${env.key}`}
              />
              <span className='font-mono'>{env.key}</span>
              <HubEnvTag envKey={env.key} />
              {!env.linked && (
                <span className='text-[11px] text-amber-700 dark:text-amber-300'>no hub link</span>
              )}
            </div>
            <Input
              id={`${idPrefix}-soak-${s.environment_id}`}
              aria-label={`${env.key} soak minutes`}
              type='number'
              min={0}
              value={s.soak_minutes}
              disabled={!s.on}
              onChange={(e) => set(i, { soak_minutes: Number(e.target.value) })}
              className='h-8 text-[12px]'
            />
            <Input
              aria-label={`${env.key} minimum readiness`}
              type='number'
              min={1}
              max={100}
              placeholder='none'
              value={s.min_readiness ?? ''}
              disabled={!s.on}
              onChange={(e) =>
                set(i, { min_readiness: e.target.value === '' ? null : Number(e.target.value) })
              }
              className='h-8 text-[12px]'
            />
            <Input
              aria-label={`${env.key} longest hold minutes`}
              type='number'
              min={5}
              value={s.max_hold_minutes}
              disabled={!s.on}
              onChange={(e) => set(i, { max_hold_minutes: Number(e.target.value) })}
              className='h-8 text-[12px]'
            />
          </div>
        )
      })}
      <p className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
        Each step is a normal promotion. After it, the train waits the soak, then (when set) until
        the readiness score reaches the minimum; still short after the hold, it waits for a person.
      </p>
    </div>
  )
}

const draftSteps = (envs: ReleaseEnv[]): StepDraft[] =>
  envs.map((e, i) => ({
    environment_id: e.id,
    on: true,
    soak_minutes: i === envs.length - 1 ? 0 : 30,
    min_readiness: e.linked && i < envs.length - 1 ? 80 : null,
    max_hold_minutes: 240
  }))

const stepsOut = (steps: StepDraft[]): TrainStepInput[] =>
  steps.filter((s) => s.on).map(({ on: _on, ...rest }) => rest)

function TrainForm({
  data,
  onDone,
  schedule
}: {
  data: ReleasesOverview
  onDone: () => void
  /** Schedule the train for later instead of starting it now. */
  schedule?: boolean
}) {
  const refresh = useRefresh()
  const [appId, setAppId] = useState<number | null>(data.apps[0]?.id ?? null)
  const envs = useMemo(() => (appId ? promotableEnvs(data, appId) : []), [data, appId])
  const [steps, setSteps] = useState<StepDraft[]>(() => draftSteps(envs))
  const [version, setVersion] = useState('')
  const [confirm, setConfirm] = useState('')
  const [when, setWhen] = useState('')
  const [onFreeze, setOnFreeze] = useState<'wait' | 'fail'>('wait')
  const key = appId ? appKey(data, appId) : ''
  const go = useMutation<unknown>({
    mutationFn: () =>
      schedule
        ? createSchedule({
            kind: 'train',
            app_id: appId,
            version: version.trim(),
            steps: stepsOut(steps),
            run_at: localInputToIso(when),
            on_freeze: onFreeze,
            confirm
          })
        : startTrain(appId as number, { version: version.trim(), steps: stepsOut(steps), confirm }),
    onSuccess: () => {
      toast.success(schedule ? 'Train scheduled' : 'Train started')
      refresh()
      onDone()
    },
    onError: (err) =>
      hubToast(err, schedule ? 'Could not schedule the train' : 'Could not start the train')
  })
  const ready =
    !!appId &&
    /^\d+\.\d+\.\d+$/.test(version.trim()) &&
    stepsOut(steps).length > 0 &&
    confirm.trim() === key &&
    (!schedule || !!localInputToIso(when))
  return (
    <div className='space-y-3 border-b border-slate-200 bg-slate-50 px-4 py-3 dark:border-border dark:bg-muted/40'>
      <div className='grid gap-3 sm:grid-cols-2'>
        <Field id='train-app' label='App'>
          <SimpleSelect
            value={appId ? String(appId) : ''}
            onChange={(v) => {
              const id = Number(v)
              setAppId(id)
              setSteps(draftSteps(promotableEnvs(data, id)))
              setConfirm('')
            }}
            options={data.apps.map((a) => ({ value: String(a.id), label: a.key }))}
            ariaLabel='App'
            className='h-8 bg-white text-left text-[13px] dark:bg-background'
            triggerProps={{ id: 'train-app' }}
          />
        </Field>
        <Field
          id='train-version'
          label='Version'
          hint='x.y.z, already running on the environment before the first step (the first environment takes a published release).'
        >
          <Input
            id='train-version'
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            placeholder='0.3.215'
            className='h-8 font-mono text-[13px]'
          />
        </Field>
      </div>
      <StepsEditor envs={envs} steps={steps} onChange={setSteps} idPrefix='train' />
      {schedule && (
        <WhenFields
          when={when}
          setWhen={setWhen}
          onFreeze={onFreeze}
          setOnFreeze={setOnFreeze}
          id='train'
        />
      )}
      <Field
        id='train-confirm'
        label={`Type ${key || 'the app key'} to ${schedule ? 'schedule' : 'start'}`}
      >
        <Input
          id='train-confirm'
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete='off'
          spellCheck={false}
          className='h-8 max-w-[280px] font-mono text-[13px]'
        />
      </Field>
      <div className='flex gap-2'>
        <Button
          size='sm'
          className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
          disabled={!ready || go.isPending}
          onClick={() => go.mutate()}
        >
          {go.isPending ? 'Working…' : schedule ? 'Schedule train' : 'Start train'}
        </Button>
        <Button size='sm' variant='ghost' className='h-8' onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function TrainRow({ t, data, isAdmin }: { t: HubTrain; data: ReleasesOverview; isAdmin: boolean }) {
  const refresh = useRefresh()
  const act = useMutation({
    mutationFn: (a: { kind: 'skip'; step: number } | { kind: 'abort' }) =>
      a.kind === 'skip' ? skipTrainStep(t.id, a.step) : abortTrain(t.id),
    onSuccess: refresh,
    onError: (err) => hubToast(err, 'Could not change the train')
  })
  const cur = t.steps[t.step_index]
  const canSkip =
    isAdmin && t.status === 'running' && cur && ['pending', 'soaking', 'held'].includes(cur.status)
  return (
    <li className='space-y-2 px-4 py-3'>
      <div className='flex flex-wrap items-center gap-x-3 gap-y-1'>
        <span className='font-mono text-[12px] font-semibold text-slate-900 dark:text-foreground'>
          {appKey(data, t.app_id)} {t.version}
        </span>
        <span className={cn('text-[12px] font-medium', tone(t.status))}>
          {TRAIN_STATUS_WORDS[t.status]}
        </span>
        <span
          className='text-[11px] text-slate-500 dark:text-muted-foreground'
          data-tip={t.started_at ? formatDateTime(t.started_at) : undefined}
        >
          {t.started_at ? formatRelative(t.started_at) : ''}
          {t.started_by_name ? ` · started by ${t.started_by_name}` : ''}
        </span>
        <div className='ml-auto flex gap-1'>
          {canSkip && (
            <button
              type='button'
              className={ghostButton}
              disabled={act.isPending}
              onClick={() => act.mutate({ kind: 'skip', step: t.step_index })}
            >
              {cur.blocked
                ? `Start ${cur.key} anyway`
                : cur.status === 'pending'
                  ? `Skip ${cur.key}`
                  : 'Skip the hold'}
            </button>
          )}
          {isAdmin && t.status === 'running' && (
            <ConfirmButton
              className={dangerGhost}
              armedClassName={dangerArmed}
              confirmLabel='Abort the train?'
              onConfirm={() => act.mutate({ kind: 'abort' })}
            >
              Abort
            </ConfirmButton>
          )}
        </div>
      </div>
      <ol className='m-0 flex list-none flex-wrap items-stretch gap-1.5 p-0' aria-label='Steps'>
        {t.steps.map((s, i) => (
          <li
            key={s.environment_id}
            data-env-tone={envTone(s.key)}
            className={cn(
              'min-w-[150px] flex-1 rounded-md border px-2.5 py-1.5 text-[11px]',
              i === t.step_index && t.status === 'running'
                ? 'border-nvr-cyan/60 bg-nvr-cyan/5'
                : 'border-slate-200 bg-white dark:border-border dark:bg-card'
            )}
          >
            <div className='flex items-center gap-1.5'>
              <span className='font-mono font-medium text-slate-900 dark:text-foreground'>
                {s.key}
              </span>
              <span className={cn('ml-auto font-medium', tone(s.status))}>
                {TRAIN_STEP_WORDS[s.status]}
              </span>
            </div>
            <div className='text-slate-500 dark:text-muted-foreground'>
              soak {s.soak_minutes} min
              {s.min_readiness != null ? ` · readiness ≥ ${s.min_readiness}` : ''}
              {s.readiness != null ? ` (now ${s.readiness})` : ''}
            </div>
            {s.note && (
              <div className='mt-0.5 break-words text-slate-600 dark:text-slate-300'>{s.note}</div>
            )}
          </li>
        ))}
      </ol>
      {t.error && !t.steps.some((s) => s.note && t.error?.endsWith(s.note)) && (
        <p className='m-0 text-[11px] text-red-700 dark:text-red-300'>{t.error}</p>
      )}
    </li>
  )
}

function TrainsCard({ data, isAdmin }: { data: ReleasesOverview; isAdmin: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <SectionCard
      title='Release trains'
      description='One version through an app’s environments in order, with a hold after each step.'
      actions={
        isAdmin &&
        !open && (
          <button type='button' className={ghostButton} onClick={() => setOpen(true)}>
            <Train className='h-3.5 w-3.5' aria-hidden /> New train
          </button>
        )
      }
    >
      {open && <TrainForm data={data} onDone={() => setOpen(false)} />}
      {data.trains.length === 0 ? (
        <Empty>No release trains yet.</Empty>
      ) : (
        <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
          {data.trains.map((t) => (
            <TrainRow key={t.id} t={t} data={data} isAdmin={isAdmin} />
          ))}
        </ul>
      )}
    </SectionCard>
  )
}

// ─── Scheduled promotions ──────────────────────────────────────────────────────

function WhenFields({
  when,
  setWhen,
  onFreeze,
  setOnFreeze,
  id
}: {
  when: string
  setWhen: (v: string) => void
  onFreeze: 'wait' | 'fail'
  setOnFreeze: (v: 'wait' | 'fail') => void
  id: string
}) {
  return (
    <div className='grid gap-3 sm:grid-cols-2'>
      <Field id={`${id}-when`} label='When' hint={`Your time (${viewerTimeZone()}).`}>
        <Input
          id={`${id}-when`}
          type='datetime-local'
          value={when}
          min={isoToLocalInput(new Date().toISOString())}
          onChange={(e) => setWhen(e.target.value)}
          className='h-8 text-[13px]'
        />
      </Field>
      <Field id={`${id}-freeze`} label='If a freeze is on then'>
        <SimpleSelect
          value={onFreeze}
          onChange={(v) => setOnFreeze(v === 'fail' ? 'fail' : 'wait')}
          options={[
            { value: 'wait', label: 'Wait until it ends' },
            { value: 'fail', label: 'Do not start' }
          ]}
          ariaLabel='If a freeze is on then'
          className='h-8 bg-white text-left text-[13px] dark:bg-background'
          triggerProps={{ id: `${id}-freeze` }}
        />
      </Field>
    </div>
  )
}

function PromoteScheduleForm({ data, onDone }: { data: ReleasesOverview; onDone: () => void }) {
  const refresh = useRefresh()
  const envs = data.environments.filter((e) => e.placed && !e.on_shared)
  const [envId, setEnvId] = useState<number | null>(envs[0]?.id ?? null)
  const [version, setVersion] = useState('')
  const [when, setWhen] = useState('')
  const [onFreeze, setOnFreeze] = useState<'wait' | 'fail'>('wait')
  const [confirm, setConfirm] = useState('')
  const env = envs.find((e) => e.id === envId)
  const go = useMutation({
    mutationFn: () =>
      createSchedule({
        kind: 'promote',
        app_id: env?.app_id,
        environment_id: envId,
        version: version.trim(),
        run_at: localInputToIso(when),
        on_freeze: onFreeze,
        confirm
      }),
    onSuccess: () => {
      toast.success('Promotion scheduled')
      refresh()
      onDone()
    },
    onError: (err) => hubToast(err, 'Could not schedule the promotion')
  })
  const ready =
    !!env &&
    /^\d+\.\d+\.\d+$/.test(version.trim()) &&
    !!localInputToIso(when) &&
    confirm.trim() === env.key
  return (
    <div className='space-y-3 border-b border-slate-200 bg-slate-50 px-4 py-3 dark:border-border dark:bg-muted/40'>
      <div className='grid gap-3 sm:grid-cols-2'>
        <Field id='sched-env' label='Environment'>
          <SimpleSelect
            value={envId ? String(envId) : ''}
            onChange={(v) => {
              setEnvId(Number(v))
              setConfirm('')
            }}
            options={envs.map((e) => ({
              value: String(e.id),
              label: `${appKey(data, e.app_id)} · ${e.key}`
            }))}
            ariaLabel='Environment'
            className='h-8 bg-white text-left text-[13px] dark:bg-background'
            triggerProps={{ id: 'sched-env' }}
          />
        </Field>
        <Field id='sched-version' label='Version'>
          <Input
            id='sched-version'
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            placeholder='0.3.215'
            className='h-8 font-mono text-[13px]'
          />
        </Field>
      </div>
      <WhenFields
        when={when}
        setWhen={setWhen}
        onFreeze={onFreeze}
        setOnFreeze={setOnFreeze}
        id='sched'
      />
      <Field
        id='sched-confirm'
        label={`Type ${env?.key ?? 'the environment key'} to schedule`}
        hint='The plan is checked again when it starts.'
      >
        <Input
          id='sched-confirm'
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete='off'
          spellCheck={false}
          className='h-8 max-w-[280px] font-mono text-[13px]'
        />
      </Field>
      <div className='flex gap-2'>
        <Button
          size='sm'
          className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
          disabled={!ready || go.isPending}
          onClick={() => go.mutate()}
        >
          {go.isPending ? 'Scheduling…' : 'Schedule promotion'}
        </Button>
        <Button size='sm' variant='ghost' className='h-8' onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function SchedulesCard({ data, isAdmin }: { data: ReleasesOverview; isAdmin: boolean }) {
  const refresh = useRefresh()
  const [open, setOpen] = useState<'promote' | 'train' | null>(null)
  const cancel = useMutation({
    mutationFn: (id: number) => cancelSchedule(id),
    onSuccess: refresh,
    onError: (err) => hubToast(err, 'Could not cancel it')
  })
  return (
    <SectionCard
      title='Scheduled'
      description='Promotions and trains the Hub starts at a set time. The plan is judged again then.'
      actions={
        isAdmin &&
        !open && (
          <>
            <button type='button' className={ghostButton} onClick={() => setOpen('promote')}>
              <CalendarClock className='h-3.5 w-3.5' aria-hidden /> Schedule a promotion
            </button>
            <button type='button' className={ghostButton} onClick={() => setOpen('train')}>
              <Plus className='h-3.5 w-3.5' aria-hidden /> Schedule a train
            </button>
          </>
        )
      }
    >
      {open === 'promote' && <PromoteScheduleForm data={data} onDone={() => setOpen(null)} />}
      {open === 'train' && <TrainForm data={data} schedule onDone={() => setOpen(null)} />}
      {data.schedules.length === 0 ? (
        <Empty>Nothing scheduled.</Empty>
      ) : (
        <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
          {data.schedules.map((s) => (
            <li
              key={s.id}
              className='flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[12px]'
            >
              <span className='font-medium text-slate-900 dark:text-foreground' data-tip={s.run_at}>
                {formatDateTime(s.run_at)}
              </span>
              <span className='font-mono text-slate-700 dark:text-slate-300'>
                {appKey(data, s.app_id)}{' '}
                {s.kind === 'train'
                  ? `train (${s.train?.keys.join(' → ') ?? ''})`
                  : envKey(data, s.environment_id)}{' '}
                → {s.version}
              </span>
              <span className={cn('font-medium', tone(s.status))}>{SCHEDULE_WORDS[s.status]}</span>
              {s.on_freeze === 'fail' && (
                <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                  no start in a freeze
                </span>
              )}
              {s.created_by_name && (
                <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                  runs as {s.created_by_name}
                </span>
              )}
              {(s.error || s.note) && (
                <span className='basis-full text-[11px] text-slate-600 dark:text-slate-300'>
                  {s.error ?? s.note}
                </span>
              )}
              {isAdmin && (s.status === 'scheduled' || s.status === 'waiting') && (
                <button
                  type='button'
                  className={cn(dangerGhost, 'ml-auto')}
                  disabled={cancel.isPending}
                  onClick={() => cancel.mutate(s.id)}
                >
                  Cancel
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  )
}

// ─── Freeze windows ────────────────────────────────────────────────────────────

/** Every IANA zone this browser knows (a month-end freeze is judged on that zone's calendar). */
function timeZones(current: string): string[] {
  let all: string[] = []
  try {
    all =
      (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
        'timeZone'
      ) ?? []
  } catch {
    all = []
  }
  return [...new Set(['UTC', current, ...all])]
}

function ZonePicker({
  id,
  value,
  onChange
}: {
  id: string
  value: string
  onChange: (v: string) => void
}) {
  const options = useMemo(() => timeZones(value).map((z) => ({ value: z, label: z })), [value])
  return (
    <div id={id}>
      <MonCombobox
        value={value}
        // Picking the same zone again would clear it: keep it instead. The command list may hand
        // back the value lower-cased, so it is matched back to the zone's own spelling.
        onChange={(v) => {
          const hit = options.find((o) => o.value.toLowerCase() === v.toLowerCase())
          if (hit) onChange(hit.value)
        }}
        options={options}
        placeholder='Pick a time zone'
        className='w-full bg-white text-[13px] dark:bg-background'
      />
    </div>
  )
}

function FreezeForm({
  data,
  current,
  onDone
}: {
  data: ReleasesOverview
  current: HubFreeze | null
  onDone: () => void
}) {
  const refresh = useRefresh()
  const [name, setName] = useState(current?.name ?? '')
  const [appId, setAppId] = useState<string>(current?.app_id ? String(current.app_id) : '')
  const [recurrence, setRecurrence] = useState<'none' | 'month_end'>(current?.recurrence ?? 'none')
  const [start, setStart] = useState(isoToLocalInput(current?.starts_at))
  const [end, setEnd] = useState(isoToLocalInput(current?.ends_at))
  const [before, setBefore] = useState(current?.days_before ?? 2)
  const [after, setAfter] = useState(current?.days_after ?? 2)
  const [tz, setTz] = useState(current?.time_zone ?? viewerTimeZone())
  const save = useMutation({
    mutationFn: () =>
      saveFreeze(current?.id ?? null, {
        name,
        app_id: appId ? Number(appId) : null,
        recurrence,
        ...(recurrence === 'none'
          ? { starts_at: localInputToIso(start), ends_at: localInputToIso(end) }
          : { days_before: before, days_after: after, time_zone: tz })
      }),
    onSuccess: () => {
      toast.success('Freeze saved')
      refresh()
      onDone()
    },
    onError: (err) => hubToast(err, 'Could not save the freeze')
  })
  return (
    <div className='space-y-3 border-b border-slate-200 bg-slate-50 px-4 py-3 dark:border-border dark:bg-muted/40'>
      <div className='grid gap-3 sm:grid-cols-3'>
        <Field id='fz-name' label='Name'>
          <Input
            id='fz-name'
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder='Month end'
            className='h-8 text-[13px]'
          />
        </Field>
        <Field id='fz-app' label='Applies to'>
          <SimpleSelect
            value={appId || 'all'}
            onChange={(v) => setAppId(v === 'all' ? '' : v)}
            options={[
              { value: 'all', label: 'Every app (Hub-wide)' },
              ...data.apps.map((a) => ({ value: String(a.id), label: a.key }))
            ]}
            ariaLabel='Applies to'
            className='h-8 bg-white text-left text-[13px] dark:bg-background'
            triggerProps={{ id: 'fz-app' }}
          />
        </Field>
        <Field id='fz-repeat' label='Repeats'>
          <SimpleSelect
            value={recurrence}
            onChange={(v) => setRecurrence(v === 'month_end' ? 'month_end' : 'none')}
            options={[
              { value: 'none', label: 'Once' },
              { value: 'month_end', label: 'Every month end' }
            ]}
            ariaLabel='Repeats'
            className='h-8 bg-white text-left text-[13px] dark:bg-background'
            triggerProps={{ id: 'fz-repeat' }}
          />
        </Field>
      </div>
      {recurrence === 'none' ? (
        <div className='grid gap-3 sm:grid-cols-2'>
          <Field id='fz-start' label='From' hint={`Your time (${viewerTimeZone()}).`}>
            <Input
              id='fz-start'
              type='datetime-local'
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className='h-8 text-[13px]'
            />
          </Field>
          <Field id='fz-end' label='Until'>
            <Input
              id='fz-end'
              type='datetime-local'
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className='h-8 text-[13px]'
            />
          </Field>
        </div>
      ) : (
        <div className='grid gap-3 sm:grid-cols-3'>
          <Field id='fz-zone' label='Time zone' hint='Days run midnight to midnight here.'>
            <ZonePicker id='fz-zone' value={tz} onChange={setTz} />
          </Field>
          <Field id='fz-before' label='Last days of the month'>
            <Input
              id='fz-before'
              type='number'
              min={0}
              max={10}
              value={before}
              onChange={(e) => setBefore(Number(e.target.value))}
              className='h-8 text-[13px]'
            />
          </Field>
          <Field id='fz-after' label='First days of the next month'>
            <Input
              id='fz-after'
              type='number'
              min={0}
              max={10}
              value={after}
              onChange={(e) => setAfter(Number(e.target.value))}
              className='h-8 text-[13px]'
            />
          </Field>
        </div>
      )}
      <p className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
        While a freeze is on, the Hub refuses promotions, Apply now, shared deployment upgrades and
        moves. A rollback to an older version than the one running is always allowed; any other
        target counts as a promotion.
      </p>
      <div className='flex gap-2'>
        <Button
          size='sm'
          className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
          disabled={!name.trim() || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save freeze'}
        </Button>
        <Button size='sm' variant='ghost' className='h-8' onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function FreezesCard({ data, isAdmin }: { data: ReleasesOverview; isAdmin: boolean }) {
  const refresh = useRefresh()
  const [editing, setEditing] = useState<HubFreeze | 'new' | null>(null)
  const remove = useMutation({
    mutationFn: (id: number) => deleteFreeze(id),
    onSuccess: refresh,
    onError: (err) => hubToast(err, 'Could not delete the freeze')
  })
  const words = (f: HubFreeze) =>
    f.recurrence === 'month_end'
      ? `Every month: last ${f.days_before ?? 0} day(s) through the first ${f.days_after ?? 0} of the next (${f.time_zone})`
      : `${f.starts_at ? formatDateTime(f.starts_at) : '?'} → ${f.ends_at ? formatDateTime(f.ends_at) : '?'}`
  return (
    <SectionCard
      title='Freeze windows'
      description='No promotions, upgrades or moves while one is on — rollbacks to an older version still go through.'
      actions={
        isAdmin &&
        !editing && (
          <button type='button' className={ghostButton} onClick={() => setEditing('new')}>
            <Snowflake className='h-3.5 w-3.5' aria-hidden /> New freeze
          </button>
        )
      }
    >
      {editing && (
        <FreezeForm
          key={editing === 'new' ? 'new' : editing.id}
          data={data}
          current={editing === 'new' ? null : editing}
          onDone={() => setEditing(null)}
        />
      )}
      {data.freezes.length === 0 ? (
        <Empty>No freeze windows.</Empty>
      ) : (
        <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
          {data.freezes.map((f) => (
            <li key={f.id} className='flex items-center gap-3 px-4 py-2.5 text-[12px]'>
              <div className='min-w-0 flex-1 space-y-0.5'>
                <div className='flex flex-wrap items-center gap-x-3 gap-y-1'>
                  <span className='font-medium text-slate-900 dark:text-foreground'>{f.name}</span>
                  <span className='text-slate-500 dark:text-muted-foreground'>
                    {appKey(data, f.app_id)}
                  </span>
                  {f.active ? (
                    <span className='rounded-full border border-sky-200 bg-sky-50 px-2 py-px text-[11px] font-medium text-sky-800 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-200'>
                      On until {formatDateTime(f.active.end)}
                    </span>
                  ) : f.next ? (
                    <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                      Next {formatDateTime(f.next.start)}
                    </span>
                  ) : null}
                </div>
                <div className='text-[11px] text-slate-600 dark:text-slate-300'>{words(f)}</div>
              </div>
              {isAdmin && (
                <div className='flex shrink-0 gap-1'>
                  <button type='button' className={ghostButton} onClick={() => setEditing(f)}>
                    Edit
                  </button>
                  <ConfirmButton
                    className={dangerGhost}
                    armedClassName={dangerArmed}
                    confirmLabel='Delete it?'
                    onConfirm={() => remove.mutate(f.id)}
                  >
                    Delete
                  </ConfirmButton>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  )
}

// ─── Automatic rollback ────────────────────────────────────────────────────────

interface RuleDraft {
  enabled: boolean
  window_minutes: number | ''
  max_error_pct: number | ''
  min_requests: number | ''
  max_crashes: number | ''
  min_readiness: number | ''
}

/** A rule in one line: what crosses it, and for how long after a promotion. */
function ruleWords(r: RollbackRule): string {
  const parts = [
    r.max_error_pct != null ? `5xx ≥ ${r.max_error_pct}% (from ${r.min_requests} requests)` : null,
    r.max_crashes != null ? `crashes ≥ ${r.max_crashes}` : null,
    r.min_readiness != null ? `readiness < ${r.min_readiness}` : null
  ].filter(Boolean)
  return `${parts.join(' · ')} — watched ${r.window_minutes} min after each promotion`
}

function RuleRow({
  env,
  rule,
  isAdmin
}: {
  env: ReleaseEnv
  rule: RollbackRule | undefined
  isAdmin: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className='px-4 py-2.5' data-env-tone={envTone(env.key)}>
      <div className='flex items-center gap-3 text-[12px]'>
        <div className='min-w-0 flex-1 space-y-0.5'>
          <div className='flex flex-wrap items-center gap-x-3 gap-y-1'>
            <span className='font-mono font-semibold text-slate-900 dark:text-foreground'>
              {env.key}
            </span>
            <HubEnvTag envKey={env.key} />
            <span
              className={cn(
                'font-medium',
                rule?.enabled
                  ? 'text-emerald-700 dark:text-emerald-300'
                  : 'text-slate-500 dark:text-muted-foreground'
              )}
            >
              {rule ? (rule.enabled ? 'On' : 'Off') : 'No rule'}
            </span>
            {!env.linked && (
              <span className='text-[11px] text-amber-700 dark:text-amber-300'>
                No hub link: the Hub cannot read its figures
              </span>
            )}
          </div>
          {rule && (
            <div className='text-[11px] text-slate-600 dark:text-slate-300'>{ruleWords(rule)}</div>
          )}
        </div>
        {isAdmin && !open && (
          <button
            type='button'
            className={cn(ghostButton, 'shrink-0')}
            onClick={() => setOpen(true)}
          >
            {rule ? 'Edit' : 'Add rule'}
          </button>
        )}
      </div>
      {open && <RuleEditor env={env} rule={rule} onDone={() => setOpen(false)} />}
    </div>
  )
}

function RuleEditor({
  env,
  rule,
  onDone
}: {
  env: ReleaseEnv
  rule: RollbackRule | undefined
  onDone: () => void
}) {
  const refresh = useRefresh()
  const [draft, setDraft] = useState<RuleDraft>({
    enabled: rule?.enabled ?? true,
    window_minutes: rule?.window_minutes ?? 30,
    max_error_pct: rule ? (rule.max_error_pct ?? '') : 5,
    min_requests: rule?.min_requests ?? 50,
    max_crashes: rule?.max_crashes ?? '',
    min_readiness: rule?.min_readiness ?? ''
  })
  const orNull = (v: number | '') => (v === '' ? null : v)
  const save = useMutation({
    mutationFn: () =>
      saveRollbackRule(env.id, {
        enabled: draft.enabled,
        window_minutes: orNull(draft.window_minutes),
        max_error_pct: orNull(draft.max_error_pct),
        min_requests: orNull(draft.min_requests),
        max_crashes: orNull(draft.max_crashes),
        min_readiness: orNull(draft.min_readiness)
      }),
    onSuccess: () => {
      toast.success(`Rollback rule saved for ${env.key}`)
      refresh()
      onDone()
    },
    onError: (err) => hubToast(err, 'Could not save the rule')
  })
  const remove = useMutation({
    mutationFn: () => deleteRollbackRule(env.id),
    onSuccess: () => {
      refresh()
      onDone()
    },
    onError: (err) => hubToast(err, 'Could not remove the rule')
  })
  const num = (
    k: Exclude<keyof RuleDraft, 'enabled'>,
    label: string,
    opts: { min?: number; max?: number; step?: string } = {}
  ) => (
    <Field id={`rb-${env.id}-${k}`} label={label}>
      <Input
        id={`rb-${env.id}-${k}`}
        type='number'
        min={opts.min}
        max={opts.max}
        step={opts.step}
        value={draft[k]}
        placeholder='off'
        onChange={(e) =>
          setDraft((d) => ({ ...d, [k]: e.target.value === '' ? '' : Number(e.target.value) }))
        }
        className='h-8 text-[12px]'
      />
    </Field>
  )
  return (
    <div className='mt-2 space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-border dark:bg-muted/40'>
      <div className='flex items-center gap-2 text-[12px] text-slate-700 dark:text-slate-300'>
        <Switch
          checked={draft.enabled}
          onCheckedChange={(v) => setDraft((d) => ({ ...d, enabled: v }))}
          aria-label={`Automatic rollback for ${env.key}`}
        />
        {draft.enabled ? 'Roll back on its own' : 'Off (kept, not used)'}
      </div>
      <div className='grid grid-cols-2 gap-2 sm:grid-cols-5'>
        {num('window_minutes', 'Watch (min)', { min: 5, max: 1440 })}
        {num('max_error_pct', '5xx rate ≥ %', { min: 0.1, max: 100, step: '0.1' })}
        {num('min_requests', 'Min. requests', { min: 1 })}
        {num('max_crashes', 'Crashes ≥', { min: 1, max: 50 })}
        {num('min_readiness', 'Readiness <', { min: 1, max: 100 })}
      </div>
      <div className='flex flex-wrap gap-2'>
        <Button
          size='sm'
          className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save rule'}
        </Button>
        <Button size='sm' variant='ghost' className='h-8' onClick={onDone}>
          Cancel
        </Button>
        {rule && (
          <button
            type='button'
            className={cn(dangerGhost, 'ml-auto')}
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            Remove rule
          </button>
        )}
      </div>
    </div>
  )
}

function RollbackCard({ data, isAdmin }: { data: ReleasesOverview; isAdmin: boolean }) {
  const envs = data.environments.filter((e) => e.placed && !e.on_shared)
  return (
    <SectionCard
      title='Automatic rollback'
      description='After a promotion, the Hub watches the app’s 5xx rate, crash reports (both over the minutes since the deploy, at most the last 60) and readiness score over its hub link, and rolls back to the version before when one crosses — only while that version still runs. Owners are told.'
    >
      {envs.length === 0 ? (
        <Empty>No environment the Hub deploys.</Empty>
      ) : (
        <div className='divide-y divide-slate-100 dark:divide-border'>
          {data.apps.map((a) => {
            const mine = envs.filter((e) => e.app_id === a.id)
            if (!mine.length) return null
            return (
              <div key={a.id}>
                <div className='bg-slate-50 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:bg-muted/40 dark:text-muted-foreground'>
                  {a.key}
                </div>
                <div className='divide-y divide-slate-100 dark:divide-border'>
                  {mine.map((e) => (
                    <RuleRow
                      key={e.id}
                      env={e}
                      rule={data.rules.find((r) => r.environment_id === e.id)}
                      isAdmin={isAdmin}
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
      {data.watches.length > 0 && (
        <div className='border-t border-slate-200 dark:border-border'>
          <h4 className='m-0 px-4 pt-3 text-[12px] font-semibold text-slate-800 dark:text-foreground'>
            Recent watches
          </h4>
          <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
            {data.watches.map((w) => (
              <li
                key={w.id}
                className='flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-[12px]'
              >
                {w.status === 'rolled_back' && (
                  <Undo2 className='h-3.5 w-3.5 text-red-600' aria-hidden />
                )}
                <span className='font-mono'>
                  {envKey(data, w.environment_id)} {w.version}
                </span>
                {w.from_version && (
                  <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                    promoted from {w.from_version}
                  </span>
                )}
                <span className={cn('font-medium', tone(w.status))}>{WATCH_WORDS[w.status]}</span>
                {w.until_at && w.status === 'watching' && (
                  <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                    until {formatDateTime(w.until_at)}
                  </span>
                )}
                {w.reason && (
                  <span className='basis-full text-[11px] text-slate-600 dark:text-slate-300'>
                    {w.reason}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </SectionCard>
  )
}
