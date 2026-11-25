import { ConfirmButton, QueryErrorState } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronRight, Play, Plus, ShieldCheck, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
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
  type CheckKind,
  deleteSuite,
  fetchEnvSmoke,
  fetchSmokeOverview,
  KIND_WORDS,
  MAX_READS,
  type OnFail,
  runSuiteNow,
  type SmokeCheck,
  type SmokeOverview,
  type SmokeRun,
  type SmokeSuite,
  saveSuite,
  TRIGGER_WORDS,
  verifyKeys
} from './verify-api'

/**
 * Smoke checks (Apps hub tab): per environment, the checks the Hub runs after every promotion,
 * rollback, Apply now, move and shared upgrade — and their runs. Owners read their apps; only
 * administrators change or run a suite. `?env=<id>&run=<id>` opens one (the failure notice does).
 */

const RUN_TONE: Record<SmokeRun['status'], string> = {
  passed:
    'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300',
  failed:
    'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300',
  queued:
    'border-slate-200 bg-slate-50 text-slate-700 dark:border-border dark:bg-muted dark:text-slate-300',
  running:
    'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300',
  unverified:
    'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300'
}
const RUN_WORDS: Record<SmokeRun['status'], string> = {
  passed: 'Passed',
  failed: 'Failed',
  queued: 'Waiting',
  running: 'Running',
  unverified: 'Not judged'
}

function RunChip({ status }: { status: SmokeRun['status'] }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        RUN_TONE[status]
      )}
    >
      {status === 'passed' ? (
        <Check className='h-3 w-3' aria-hidden />
      ) : status === 'failed' ? (
        <X className='h-3 w-3' aria-hidden />
      ) : null}
      {RUN_WORDS[status]}
    </span>
  )
}

export default function HubSmoke() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  const [params, setParams] = useSearchParams()
  const q = useQuery({
    queryKey: verifyKeys.smoke(),
    queryFn: fetchSmokeOverview,
    refetchInterval: 30_000
  })
  const envParam = Number(params.get('env')) || null
  const selected = envParam ?? q.data?.environments[0]?.id ?? null
  const select = (id: number) => {
    const next = new URLSearchParams(params)
    next.set('env', String(id))
    next.delete('run')
    setParams(next, { replace: true })
  }
  return (
    <div className='flex min-h-0 flex-1 flex-col md:flex-row'>
      <aside className='max-h-[40vh] shrink-0 overflow-y-auto border-b border-slate-200 bg-white md:max-h-none md:w-[272px] md:border-b-0 md:border-r dark:border-border dark:bg-card'>
        {q.isPending ? (
          <div className='space-y-2 p-3'>
            <Skeleton className='h-8 w-full' />
            <Skeleton className='h-8 w-full' />
            <Skeleton className='h-8 w-full' />
          </div>
        ) : q.isError ? (
          <div className='p-3'>
            <QueryErrorState
              error={q.error}
              what='the smoke checks'
              onRetry={() => void q.refetch()}
            />
          </div>
        ) : (
          <EnvList data={q.data} selected={selected} onSelect={select} />
        )}
      </aside>
      <div className='min-h-0 flex-1 overflow-y-auto bg-slate-50 p-4 sm:p-6 dark:bg-background'>
        {q.data && selected != null ? (
          <EnvDetail
            key={selected}
            envId={selected}
            data={q.data}
            isAdmin={isAdmin}
            openRun={Number(params.get('run')) || null}
          />
        ) : q.data ? (
          <p className='m-0 text-[13px] text-slate-500 dark:text-muted-foreground'>
            No environments yet. Add an app and its environments on the Apps tab first.
          </p>
        ) : null}
      </div>
    </div>
  )
}

function EnvList({
  data,
  selected,
  onSelect
}: {
  data: SmokeOverview
  selected: number | null
  onSelect: (id: number) => void
}) {
  const last = new Map(data.last_runs.map((r) => [r.environment_id, r]))
  const suites = new Map(data.suites.map((s) => [s.environment_id, s]))
  return (
    <nav aria-label='Environments' className='py-2'>
      {data.apps.map((a) => {
        const envs = data.environments.filter((e) => e.app_id === a.id)
        if (!envs.length) return null
        return (
          <div key={a.id} className='pb-2'>
            <p className='m-0 px-3 pb-1 pt-2 text-[11px] font-semibold text-slate-500 dark:text-muted-foreground'>
              {a.name || a.key}
            </p>
            <ul className='m-0 list-none p-0'>
              {envs.map((e) => {
                const s = suites.get(e.id)
                const r = last.get(e.id)
                const active = e.id === selected
                return (
                  <li key={e.id}>
                    <button
                      type='button'
                      onClick={() => onSelect(e.id)}
                      aria-current={active ? 'true' : undefined}
                      className={cn(
                        'flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/50',
                        active ? 'bg-accent' : 'hover:bg-muted'
                      )}
                    >
                      <span className='min-w-0 flex-1 truncate font-medium text-slate-800 dark:text-foreground'>
                        {e.key}
                      </span>
                      <HubEnvTag envKey={e.key} />
                      {!s ? (
                        <span className='text-[11px] text-slate-400 dark:text-muted-foreground'>
                          No checks
                        </span>
                      ) : !s.enabled ? (
                        <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                          Off
                        </span>
                      ) : r ? (
                        <RunChip status={r.status} />
                      ) : (
                        <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                          Not run yet
                        </span>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </nav>
  )
}

function EnvDetail({
  envId,
  data,
  isAdmin,
  openRun
}: {
  envId: number
  data: SmokeOverview
  isAdmin: boolean
  openRun: number | null
}) {
  const env = data.environments.find((e) => e.id === envId)
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: verifyKeys.env(envId),
    queryFn: () => fetchEnvSmoke(envId),
    refetchInterval: (query) =>
      query.state.data?.runs.some((r) => r.status === 'queued' || r.status === 'running')
        ? 3_000
        : 30_000
  })
  const run = useMutation({
    mutationFn: () => runSuiteNow(envId),
    onSuccess: () => {
      toast.success('Smoke checks started')
      void qc.invalidateQueries({ queryKey: verifyKeys.env(envId) })
    },
    onError: (e) => hubToast(e, 'The smoke checks could not start')
  })
  if (!env)
    return (
      <p className='m-0 text-[13px] text-slate-500 dark:text-muted-foreground'>
        That environment is not one you can see.
      </p>
    )
  const app = data.apps.find((a) => a.id === env.app_id)
  return (
    <div className='space-y-5'>
      <div className='flex flex-wrap items-center gap-2'>
        <h2 className='m-0 text-[15px] font-semibold text-slate-900 dark:text-foreground'>
          {app?.key ?? ''} / {env.key}
        </h2>
        <HubEnvTag envKey={env.key} />
        {env.on_shared && (
          <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            on a shared deployment
          </span>
        )}
        {isAdmin && q.data?.suite && (
          <Button
            size='sm'
            variant='outline'
            className='ml-auto h-8'
            disabled={run.isPending || !q.data.suite.checks.length}
            onClick={() => run.mutate()}
          >
            <Play className='mr-1.5 h-3.5 w-3.5' aria-hidden />
            {run.isPending ? 'Starting…' : 'Run now'}
          </Button>
        )}
      </div>
      {q.isPending ? (
        <Skeleton className='h-40 w-full' />
      ) : q.isError ? (
        <QueryErrorState error={q.error} what='the smoke checks' onRetry={() => void q.refetch()} />
      ) : (
        <>
          <SuiteCard
            envId={envId}
            suite={q.data.suite}
            isAdmin={isAdmin}
            linked={env.linked}
            rollbackWindow={q.data.rollback_window_minutes}
            longestRun={q.data.longest_run_seconds}
          />
          <RunsCard runs={q.data.runs} openRun={openRun} />
        </>
      )}
    </div>
  )
}

type Draft = Omit<SmokeCheck, 'expect_status' | 'min_rows' | 'max_rows' | 'max_ms'> & {
  key: string
  expect_status: string
  min_rows: string
  max_rows: string
  max_ms: string
  params_text: string
}

let draftSeq = 0
const nextKey = () => `d${++draftSeq}`

function toDraft(c: SmokeCheck): Draft {
  return {
    ...c,
    key: c.id ?? nextKey(),
    expect_status: String(c.expect_status ?? 200),
    min_rows: c.min_rows == null ? '' : String(c.min_rows),
    max_rows: c.max_rows == null ? '' : String(c.max_rows),
    max_ms: c.max_ms == null ? '' : String(c.max_ms),
    params_text: c.params
      ? Object.entries(c.params)
          .map(([k, v]) => `${k}=${v ?? ''}`)
          .join(', ')
      : ''
  }
}

function blankDraft(kind: CheckKind): Draft {
  return toDraft({
    kind,
    name: kind === 'http' ? 'Home page' : kind === 'read' ? 'Signed-in read' : 'Saved query',
    path: kind === 'http' ? '/' : kind === 'read' ? '/api/items/' : undefined,
    slug: kind === 'query' ? '' : undefined,
    min_rows: kind === 'query' ? 1 : undefined
  })
}

const numOrUndef = (v: string) => (v.trim() === '' ? undefined : Number(v))

function parseParams(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of text.split(',')) {
    const [k, ...rest] = part.split('=')
    if (k?.trim()) out[k.trim()] = rest.join('=').trim()
  }
  return out
}

function fromDraft(d: Draft): SmokeCheck {
  const c: SmokeCheck = {
    ...(d.id ? { id: d.id } : {}),
    name: d.name,
    kind: d.kind,
    expect_status: numOrUndef(d.expect_status),
    max_ms: numOrUndef(d.max_ms)
  }
  if (d.kind === 'query') {
    c.slug = d.slug
    c.params = parseParams(d.params_text)
  } else c.path = d.path
  if (d.kind === 'http' && d.contains) c.contains = d.contains
  if (d.kind !== 'http') {
    c.min_rows = numOrUndef(d.min_rows)
    c.max_rows = numOrUndef(d.max_rows)
  }
  return c
}

const KIND_OPTIONS = (Object.keys(KIND_WORDS) as CheckKind[]).map((k) => ({
  value: k,
  label: KIND_WORDS[k]
}))

const FAIL_OPTIONS = [
  { value: 'notify', label: 'Tell the app’s people' },
  { value: 'rollback', label: 'Tell them, and let the rollback rule roll back' }
]

function SuiteCard({
  envId,
  suite,
  isAdmin,
  linked,
  rollbackWindow,
  longestRun
}: {
  envId: number
  suite: SmokeSuite | null
  isAdmin: boolean
  linked: boolean
  /** The automatic rollback rule's window in minutes; null = no enabled rule. */
  rollbackWindow: number | null
  longestRun: number | null
}) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [onFail, setOnFail] = useState<OnFail>('notify')
  const [settle, setSettle] = useState('30')
  const [checks, setChecks] = useState<Draft[]>([])
  const reset = () => {
    setEnabled(suite?.enabled ?? true)
    setOnFail(suite?.on_fail ?? 'notify')
    setSettle(String(suite?.settle_seconds ?? 30))
    setChecks(suite ? suite.checks.map(toDraft) : [blankDraft('http')])
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the stored suite changes
  useEffect(reset, [suite?.updated_at])
  const done = () => {
    void qc.invalidateQueries({ queryKey: verifyKeys.env(envId) })
    void qc.invalidateQueries({ queryKey: verifyKeys.smoke() })
  }
  const save = useMutation({
    mutationFn: () =>
      saveSuite(envId, {
        enabled,
        on_fail: onFail,
        settle_seconds: Number(settle),
        checks: checks.map(fromDraft)
      }),
    onSuccess: () => {
      toast.success('Smoke checks saved')
      setEditing(false)
      done()
    },
    onError: (e) => hubToast(e, 'The smoke checks could not be saved')
  })
  const remove = useMutation({
    mutationFn: () => deleteSuite(envId),
    onSuccess: () => {
      toast.success('Smoke checks removed')
      setEditing(false)
      done()
    },
    onError: (e) => hubToast(e, 'The smoke checks could not be removed')
  })
  const readCount = checks.filter((c) => c.kind !== 'http').length
  const set = (key: string, patch: Partial<Draft>) =>
    setChecks((list) => list.map((c) => (c.key === key ? { ...c, ...patch } : c)))

  const readsWithoutLink = !linked && (suite?.checks ?? []).some((c) => c.kind !== 'http')

  return (
    <SectionCard
      title='Checks'
      description='Run after every promotion, rollback, Apply now, move and shared upgrade of this environment, once the deploy has settled.'
      actions={
        isAdmin && !editing ? (
          <Button size='sm' className='h-8 bg-nvr-cyan text-white' onClick={() => setEditing(true)}>
            {suite ? 'Edit checks' : 'Add checks'}
          </Button>
        ) : undefined
      }
    >
      {readsWithoutLink && (
        <p className='m-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[12px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200'>
          The Hub holds no hub token for this environment, so its signed-in reads and saved queries
          cannot run. Set the hub token on the Apps tab.
        </p>
      )}
      {editing ? (
        <div className='space-y-4 p-4'>
          <div className='grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_7rem] sm:items-start'>
            <Field
              id='smoke-on-fail'
              label='When a check fails'
              hint={
                onFail === 'rollback'
                  ? 'After a promotion only, and only while the environment’s automatic rollback rule (Releases tab) watches it.'
                  : 'Hub administrators and the app’s owners get a notice; urgent on production.'
              }
            >
              <SimpleSelect
                value={onFail}
                onChange={(v) => setOnFail(v as OnFail)}
                options={FAIL_OPTIONS}
                ariaLabel='When a check fails'
                className='h-8 bg-white text-left text-[13px] dark:bg-background'
                triggerProps={{ id: 'smoke-on-fail' }}
              />
            </Field>
            <Field id='smoke-settle' label='Wait after the deploy' hint='Seconds, 0–600'>
              <Input
                id='smoke-settle'
                inputMode='numeric'
                value={settle}
                onChange={(e) => setSettle(e.target.value)}
                className='h-8 text-[13px] tabular-nums'
              />
            </Field>
            <Field
              id='smoke-enabled'
              label='Runs'
              hint={enabled ? 'After each deploy' : 'Nothing runs'}
            >
              <div className='flex h-8 items-center gap-2 text-[12px] text-slate-700 dark:text-foreground'>
                <Switch id='smoke-enabled' checked={enabled} onCheckedChange={setEnabled} />
                {enabled ? 'On' : 'Off'}
              </div>
            </Field>
          </div>

          {onFail === 'rollback' && (
            <p className='m-0 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200'>
              {rollbackWindow == null
                ? 'No automatic rollback rule is on for this environment (Releases tab): a failed run only tells the people.'
                : (longestRun ?? 0) > rollbackWindow * 60
                  ? `A run can finish after the rollback rule’s ${rollbackWindow}-minute window, and then it no longer rolls back. Shorten the wait or lengthen the window.`
                  : `Only a check that fails on the app’s own answer rolls back, within the rule’s ${rollbackWindow}-minute window. A run that cannot judge the app (no link, a timeout, maintenance) only tells the people.`}
            </p>
          )}

          <ol className='m-0 list-none space-y-3 p-0'>
            {checks.map((c, i) => (
              <li
                key={c.key}
                className='space-y-3 rounded-md border border-slate-200 bg-slate-50/60 p-3 dark:border-border dark:bg-muted/30'
              >
                <div className='grid gap-3 sm:grid-cols-[11rem_minmax(0,1fr)_auto] sm:items-end'>
                  <Field id={`kind-${c.key}`} label={`Check ${i + 1}`}>
                    <SimpleSelect
                      value={c.kind}
                      onChange={(v) => {
                        const b = blankDraft(v as CheckKind)
                        set(c.key, {
                          kind: b.kind,
                          path: b.path,
                          slug: b.slug,
                          min_rows: b.min_rows
                        })
                      }}
                      options={KIND_OPTIONS}
                      ariaLabel={`Check ${i + 1} kind`}
                      className='h-8 bg-white text-left text-[13px] dark:bg-background'
                      triggerProps={{ id: `kind-${c.key}` }}
                    />
                  </Field>
                  <Field id={`name-${c.key}`} label='Name'>
                    <Input
                      id={`name-${c.key}`}
                      value={c.name}
                      onChange={(e) => set(c.key, { name: e.target.value })}
                      className='h-8 text-[13px]'
                    />
                  </Field>
                  <button
                    type='button'
                    className={dangerGhost}
                    aria-label={`Remove check ${i + 1}`}
                    disabled={checks.length === 1}
                    onClick={() => setChecks((list) => list.filter((x) => x.key !== c.key))}
                  >
                    <Trash2 className='h-3.5 w-3.5' aria-hidden />
                  </button>
                </div>
                <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_6.5rem_minmax(0,1.4fr)_8.5rem]'>
                  {c.kind === 'query' ? (
                    <div className='grid grid-cols-2 gap-2'>
                      <Field id={`slug-${c.key}`} label='Query slug' hint='Its access is Signed in'>
                        <Input
                          id={`slug-${c.key}`}
                          value={c.slug ?? ''}
                          onChange={(e) => set(c.key, { slug: e.target.value })}
                          className='h-8 font-mono text-[12px]'
                        />
                      </Field>
                      <Field
                        id={`params-${c.key}`}
                        label='Parameters'
                        hint='name=value, comma separated'
                      >
                        <Input
                          id={`params-${c.key}`}
                          value={c.params_text}
                          onChange={(e) => set(c.key, { params_text: e.target.value })}
                          className='h-8 font-mono text-[12px]'
                        />
                      </Field>
                    </div>
                  ) : (
                    <Field
                      id={`path-${c.key}`}
                      label='Path'
                      hint={
                        c.kind === 'http'
                          ? 'On this environment’s own address'
                          : 'A GET under /api/, read by the app as its smoke identity'
                      }
                    >
                      <Input
                        id={`path-${c.key}`}
                        value={c.path ?? ''}
                        onChange={(e) => set(c.key, { path: e.target.value })}
                        className='h-8 font-mono text-[12px]'
                      />
                    </Field>
                  )}
                  <Field id={`status-${c.key}`} label='Expect status'>
                    <Input
                      id={`status-${c.key}`}
                      inputMode='numeric'
                      value={c.expect_status}
                      onChange={(e) => set(c.key, { expect_status: e.target.value })}
                      className='h-8 text-[13px] tabular-nums'
                    />
                  </Field>
                  {c.kind === 'http' ? (
                    <Field id={`contains-${c.key}`} label='Page contains (optional)'>
                      <Input
                        id={`contains-${c.key}`}
                        value={c.contains ?? ''}
                        onChange={(e) => set(c.key, { contains: e.target.value })}
                        className='h-8 text-[13px]'
                      />
                    </Field>
                  ) : (
                    <div className='grid grid-cols-2 gap-2'>
                      <Field id={`min-${c.key}`} label='At least rows'>
                        <Input
                          id={`min-${c.key}`}
                          inputMode='numeric'
                          value={c.min_rows}
                          onChange={(e) => set(c.key, { min_rows: e.target.value })}
                          className='h-8 text-[13px] tabular-nums'
                        />
                      </Field>
                      <Field id={`max-${c.key}`} label='At most'>
                        <Input
                          id={`max-${c.key}`}
                          inputMode='numeric'
                          value={c.max_rows}
                          onChange={(e) => set(c.key, { max_rows: e.target.value })}
                          className='h-8 text-[13px] tabular-nums'
                        />
                      </Field>
                    </div>
                  )}
                  <Field id={`ms-${c.key}`} label='Time limit, ms'>
                    <Input
                      id={`ms-${c.key}`}
                      inputMode='numeric'
                      value={c.max_ms}
                      onChange={(e) => set(c.key, { max_ms: e.target.value })}
                      className='h-8 text-[13px] tabular-nums'
                    />
                  </Field>
                </div>
              </li>
            ))}
          </ol>

          <div className='flex flex-wrap items-center gap-2'>
            <button
              type='button'
              className={ghostButton}
              disabled={checks.length >= 20}
              onClick={() => setChecks((list) => [...list, blankDraft('http')])}
            >
              <Plus className='h-3.5 w-3.5' aria-hidden /> Add a check
            </button>
            <span
              className={cn(
                'text-[11px] tabular-nums',
                readCount > MAX_READS
                  ? 'font-medium text-red-700 dark:text-red-400'
                  : 'text-slate-500 dark:text-muted-foreground'
              )}
            >
              {readCount} of {MAX_READS} signed-in reads and saved queries
            </span>
            <div className='ml-auto flex flex-wrap items-center gap-2'>
              {suite && (
                <ConfirmButton
                  className={dangerGhost}
                  armedClassName={dangerArmed}
                  onConfirm={() => remove.mutate()}
                  disabled={remove.isPending}
                  confirmLabel='Remove the checks'
                >
                  Remove all
                </ConfirmButton>
              )}
              <button
                type='button'
                className={ghostButton}
                onClick={() => {
                  reset()
                  setEditing(false)
                }}
              >
                Cancel
              </button>
              <Button
                size='sm'
                className='h-8 bg-nvr-cyan text-white'
                disabled={save.isPending || !checks.length || readCount > MAX_READS}
                onClick={() => save.mutate()}
              >
                {save.isPending ? 'Saving…' : 'Save checks'}
              </Button>
            </div>
          </div>
        </div>
      ) : !suite ? (
        <div className='flex items-start gap-3 p-4'>
          <ShieldCheck className='mt-0.5 h-4 w-4 shrink-0 text-slate-400' aria-hidden />
          <p className='m-0 max-w-[65ch] text-[12px] text-slate-600 dark:text-slate-300'>
            No smoke checks yet. Add a few cheap ones: the home page answers, one signed-in list
            read returns rows, one saved query returns the count you expect. They catch a deploy
            that came up but does not work.
          </p>
        </div>
      ) : (
        <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
          <li className='flex flex-wrap gap-x-4 gap-y-1 px-4 py-2 text-[12px] text-slate-600 dark:text-slate-300'>
            <span>{suite.enabled ? 'On' : 'Off — nothing runs'}</span>
            <span>
              On failure:{' '}
              {suite.on_fail === 'rollback' ? 'tell, and the rollback rule may roll back' : 'tell'}
            </span>
            <span>Waits {suite.settle_seconds} s after a deploy</span>
          </li>
          {suite.checks.map((c) => (
            <li key={c.id} className='flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5'>
              <span className='text-[13px] font-medium text-slate-800 dark:text-foreground'>
                {c.name}
              </span>
              <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                {KIND_WORDS[c.kind]}
              </span>
              <code className='min-w-0 truncate text-[12px] text-slate-600 dark:text-slate-300'>
                {c.kind === 'query' ? c.slug : c.path}
              </code>
              <span className='ml-auto text-[11px] text-slate-500 dark:text-muted-foreground'>
                {expectWords(c)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  )
}

function expectWords(c: SmokeCheck): string {
  const parts = [`${c.expect_status ?? 200}`]
  if (c.contains) parts.push(`contains “${c.contains}”`)
  if (c.min_rows != null && c.max_rows != null) parts.push(`${c.min_rows}–${c.max_rows} rows`)
  else if (c.min_rows != null) parts.push(`≥ ${c.min_rows} rows`)
  else if (c.max_rows != null) parts.push(`≤ ${c.max_rows} rows`)
  if (c.max_ms != null) parts.push(`≤ ${c.max_ms} ms`)
  return parts.join(' · ')
}

function RunsCard({ runs, openRun }: { runs: SmokeRun[]; openRun: number | null }) {
  const [open, setOpen] = useState<number | null>(openRun)
  const sorted = useMemo(() => runs, [runs])
  return (
    <SectionCard
      title='Runs'
      description='The newest 20. A failed run lists each check that failed and why.'
    >
      {!sorted.length ? (
        <p className='m-0 p-4 text-[12px] text-slate-500 dark:text-muted-foreground'>
          No runs yet. The next deploy of this environment runs the checks, or use Run now.
        </p>
      ) : (
        <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
          {sorted.map((r) => {
            const expanded = open === r.id
            return (
              <li key={r.id}>
                <button
                  type='button'
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : r.id)}
                  className='flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/50'
                >
                  <ChevronRight
                    className={cn(
                      'h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-150',
                      expanded && 'rotate-90'
                    )}
                    aria-hidden
                  />
                  <RunChip status={r.status} />
                  <span className='text-[13px] text-slate-800 dark:text-foreground'>
                    {TRIGGER_WORDS[r.trigger]}
                    {r.version ? ` · ${r.version}` : ''}
                  </span>
                  {r.passed != null && r.failed != null && (
                    <span className='text-[12px] tabular-nums text-slate-500 dark:text-muted-foreground'>
                      {r.passed} of {r.passed + r.failed} passed
                    </span>
                  )}
                  <span
                    className='ml-auto text-[12px] text-slate-500 dark:text-muted-foreground'
                    data-tip={formatDateTime(r.finished_at ?? r.due_at ?? r.created_at ?? '')}
                  >
                    {r.status === 'queued'
                      ? `due ${formatRelative(r.due_at ?? '')}`
                      : formatRelative(r.finished_at ?? r.started_at ?? r.created_at ?? '')}
                  </span>
                </button>
                {expanded && (
                  <div className='px-4 pb-3 pl-10'>
                    {r.results.length ? (
                      <table className='w-full text-left text-[12px]'>
                        <thead>
                          <tr className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                            <th className='py-1 pr-3 font-medium'>Check</th>
                            <th className='py-1 pr-3 font-medium'>Status</th>
                            <th className='py-1 pr-3 font-medium'>Time</th>
                            <th className='py-1 font-medium'>Result</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.results.map((c) => (
                            <tr key={c.id} className='border-t border-slate-100 dark:border-border'>
                              <td className='py-1.5 pr-3 font-medium text-slate-800 dark:text-foreground'>
                                {c.name}
                              </td>
                              <td className='py-1.5 pr-3 tabular-nums'>{c.status ?? '—'}</td>
                              <td className='py-1.5 pr-3 tabular-nums text-slate-500 dark:text-muted-foreground'>
                                {c.ms == null ? '—' : `${c.ms} ms`}
                              </td>
                              <td
                                className={cn(
                                  'py-1.5',
                                  c.ok
                                    ? 'text-emerald-700 dark:text-emerald-400'
                                    : 'text-red-700 dark:text-red-400'
                                )}
                              >
                                {c.ok
                                  ? c.rows != null
                                    ? `OK · ${c.rows} ${c.rows === 1 ? 'row' : 'rows'}`
                                    : 'OK'
                                  : c.reason}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
                        {r.reason ?? 'Waiting to run.'}
                      </p>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </SectionCard>
  )
}
