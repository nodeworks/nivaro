import { ConfirmButton, ErrorNotice, QueryErrorState } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, ChevronLeft, CopyPlus, Play, RotateCcw, Undo2 } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { envTone } from '@/components/hub-brand/env-tone'
import { HubEnvTag, ProductionGuard } from '@/components/hub-brand/HubBits'
import { HubRunTimeline } from '@/components/hub-brand/HubRunTimeline'
import { HubToolbar } from '@/components/hub-page'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/lib/auth'
import { useHubProductFlag } from '@/lib/hub-product'
import { cn, formatDateTime, formatRelative } from '@/lib/utils'
import { PreDeployChecklist } from '../changes/PreDeployChecklist'
import { fetchHubApps, hubKeys, useHubApp } from '../hub-api'
import {
  countLabel,
  Field,
  ghostButton,
  ListPaneHeader,
  listPaneClass,
  SectionCard
} from '../hub-parts'
import {
  type CloneRow,
  captureClone,
  fetchClones,
  fetchRetirement,
  fetchRetirements,
  fetchRetirePlan,
  lifecycleError,
  lifecycleKeys,
  lifecycleToast,
  openRetirement,
  type RetireEnvPlan,
  type Retirement,
  type RetireStep,
  type RetireStepKey,
  retirementAction,
  type SignOff,
  STATUS_WORDS,
  startRetireStep,
  TRACK_STATE
} from './lifecycle-api'

/**
 * Clone & retire (Apps hub tab, administrators; owners read their apps' retirements).
 *
 *  - Copy an app: the structure of one environment's app (collections, fields, relations,
 *    workflows and pipelines, layouts, queues, rules, roles, flows — never records, files, people
 *    or secrets) becomes a library template; "Create app from it" opens Create app with it picked.
 *  - Retire an app: the plan, then five steps each signed off in turn — freeze writes, export
 *    data, final notice, stop and remove, archive. Undo goes back one step until the removal.
 *
 * URL: ?retirement=<id> | ?clone=<id> | ?new=copy | ?new=retire (shareable, Back works).
 */

/** The production words of an environment key (the server's PRODUCTION_KEY_RE). */
const PROD_KEY_RE = /(^|[-_.])(prod|production|prd|live)([-_.]|\d|$)/i

const STEP_SHORT: Record<RetireStepKey, string> = {
  freeze: 'Freeze',
  export: 'Export',
  notice: 'Notice',
  remove: 'Remove',
  archive: 'Archive'
}

const STATE_WORDS: Record<RetireStep['state'], string> = {
  pending: 'Not started',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  interrupted: 'Stopped'
}

const STEP_VERB: Record<RetireStepKey, string> = {
  freeze: 'Sign off and freeze',
  export: 'Sign off and export',
  notice: 'Sign off and send the notice',
  remove: 'Sign off and remove',
  archive: 'Sign off and archive'
}

const statusTone = (s: Retirement['status']) =>
  s === 'done'
    ? 'text-emerald-700 dark:text-emerald-400'
    : s === 'interrupted'
      ? 'text-amber-800 dark:text-amber-300'
      : s === 'cancelled'
        ? 'text-slate-500 dark:text-muted-foreground'
        : 'text-slate-700 dark:text-slate-200'

export default function HubLifecycle() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  const [params, setParams] = useSearchParams()
  const retirementId = Number(params.get('retirement')) || null
  const cloneId = Number(params.get('clone')) || null
  const mode = params.get('new')
  const show = (next: Record<string, string | number | null>) =>
    setParams(() => {
      const out = new URLSearchParams()
      for (const [k, v] of Object.entries(next)) if (v != null) out.set(k, String(v))
      return out
    })
  const retirements = useQuery({
    queryKey: lifecycleKeys.retirements(),
    queryFn: fetchRetirements,
    refetchInterval: 30_000
  })
  const clones = useQuery({
    queryKey: lifecycleKeys.clones(),
    queryFn: fetchClones,
    enabled: isAdmin
  })
  const detailOpen = retirementId != null || cloneId != null || mode != null

  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <HubToolbar
        description='A copy never carries records, files, people or secrets. A retirement can be undone step by step until its removal is signed off.'
        actions={
          isAdmin ? (
            <>
              <Button
                size='sm'
                variant='outline'
                className='h-8'
                aria-pressed={mode === 'copy'}
                onClick={() => show({ new: 'copy' })}
              >
                <CopyPlus className='mr-1.5 h-3.5 w-3.5' aria-hidden /> Copy an app
              </Button>
              <Button
                size='sm'
                variant='outline'
                className='h-8'
                aria-pressed={mode === 'retire'}
                onClick={() => show({ new: 'retire' })}
              >
                <Archive className='mr-1.5 h-3.5 w-3.5' aria-hidden /> Retire an app
              </Button>
            </>
          ) : null
        }
      />
      <div className='flex min-h-0 flex-1 flex-col md:flex-row'>
        <aside className={cn(listPaneClass, detailOpen ? 'hidden md:flex' : 'flex')}>
          <ListPaneHeader
            label={countLabel(retirements.data?.length, 'retirement', 'retirements')}
          />
          {retirements.isPending ? (
            <div className='space-y-2 p-3'>
              <Skeleton className='h-10 w-full' />
              <Skeleton className='h-10 w-full' />
            </div>
          ) : retirements.isError ? (
            <div className='p-3'>
              <QueryErrorState
                error={retirements.error}
                what='the retirements'
                onRetry={() => void retirements.refetch()}
              />
            </div>
          ) : retirements.data.length === 0 ? (
            <p className='m-0 px-3 py-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
              No app has been retired here.
            </p>
          ) : (
            <ul className='m-0 list-none space-y-0.5 p-2'>
              {retirements.data.map((r) => (
                <li key={r.id}>
                  <ListRow
                    active={r.id === retirementId}
                    onSelect={() => show({ retirement: r.id })}
                    title={`${r.plan?.app.name ?? `App ${r.app_id}`} · #${r.id}`}
                    meta={STATUS_WORDS[r.status]}
                    metaClass={statusTone(r.status)}
                    when={r.finished_at ?? r.created_at}
                  />
                </li>
              ))}
            </ul>
          )}
          {isAdmin && (
            <>
              <ListPaneHeader
                className='border-t'
                label={countLabel(clones.data?.length, 'structure copy', 'structure copies')}
              />
              {clones.isPending ? (
                <div className='p-3'>
                  <Skeleton className='h-10 w-full' />
                </div>
              ) : clones.isError ? (
                <div className='p-3'>
                  <QueryErrorState
                    error={clones.error}
                    what='the structure copies'
                    onRetry={() => void clones.refetch()}
                  />
                </div>
              ) : clones.data.length === 0 ? (
                <p className='m-0 px-3 py-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
                  No structure copied yet.
                </p>
              ) : (
                <ul className='m-0 list-none space-y-0.5 p-2'>
                  {clones.data.map((c) => (
                    <li key={c.id}>
                      <ListRow
                        active={c.id === cloneId}
                        onSelect={() => show({ clone: c.id })}
                        title={
                          c.source ? `${c.source.app_key} · ${c.source.env_key}` : `Copy #${c.id}`
                        }
                        meta={c.template ? c.template.version : 'Template deleted'}
                        when={c.captured_at}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </aside>

        <div
          className={cn(
            'min-h-0 min-w-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-background',
            detailOpen ? 'block' : 'hidden md:block'
          )}
        >
          {detailOpen && (
            <div className='border-b border-slate-200 bg-white px-2 py-1.5 md:hidden dark:border-border dark:bg-card'>
              <button type='button' className={ghostButton} onClick={() => show({})}>
                <ChevronLeft className='h-3.5 w-3.5' aria-hidden /> All retirements and copies
              </button>
            </div>
          )}
          <div className='p-4 sm:p-6'>
            {mode === 'copy' && isAdmin ? (
              <CopyPanel onCopied={(id) => show({ clone: id })} />
            ) : mode === 'retire' && isAdmin ? (
              <RetirePlanPanel onOpened={(id) => show({ retirement: id })} />
            ) : retirementId != null ? (
              <RetirementDetail key={retirementId} id={retirementId} isAdmin={isAdmin} />
            ) : cloneId != null ? (
              <CloneDetail clone={clones.data?.find((c) => c.id === cloneId) ?? null} />
            ) : (
              <NothingSelected isAdmin={isAdmin} onPick={(m) => show({ new: m })} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function ListRow({
  active,
  onSelect,
  title,
  meta,
  metaClass,
  when
}: {
  active: boolean
  onSelect: () => void
  title: string
  meta: string
  metaClass?: string
  when: string | null
}) {
  return (
    <button
      type='button'
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
        active ? 'bg-accent' : 'hover:bg-muted'
      )}
    >
      <span className='truncate text-[13px] font-medium text-slate-900 dark:text-foreground'>
        {title}
      </span>
      <span className='flex min-w-0 items-center gap-1.5 text-[11.5px]'>
        <span className={cn('truncate', metaClass ?? 'text-slate-600 dark:text-slate-300')}>
          {meta}
        </span>
        {when && (
          <span
            className='shrink-0 text-slate-500 tabular-nums dark:text-muted-foreground'
            data-tip={formatDateTime(when)}
          >
            · {formatRelative(when)}
          </span>
        )}
      </span>
    </button>
  )
}

function NothingSelected({
  isAdmin,
  onPick
}: {
  isAdmin: boolean
  onPick: (m: 'copy' | 'retire') => void
}) {
  return (
    <div className='max-w-[560px] space-y-4'>
      <div className='space-y-1.5'>
        <h2 className='m-0 text-[15px] font-semibold text-slate-900 dark:text-foreground'>
          Copy an app, or retire one
        </h2>
        <p className='m-0 text-[13px] leading-relaxed text-slate-600 dark:text-muted-foreground'>
          A copy takes an app’s structure — collections, fields, workflows, layouts, roles and flows
          — and starts a new app from it. Records, files, people and secrets stay behind.
        </p>
        <p className='m-0 text-[13px] leading-relaxed text-slate-600 dark:text-muted-foreground'>
          A retirement switches an app off in five signed-off steps. Each step can be undone until
          the app is removed.
        </p>
      </div>
      {isAdmin ? (
        <div className='flex flex-wrap gap-2'>
          <Button size='sm' variant='outline' className='h-8' onClick={() => onPick('copy')}>
            <CopyPlus className='mr-1.5 h-3.5 w-3.5' aria-hidden /> Copy an app
          </Button>
          <Button size='sm' variant='outline' className='h-8' onClick={() => onPick('retire')}>
            <Archive className='mr-1.5 h-3.5 w-3.5' aria-hidden /> Retire an app
          </Button>
        </div>
      ) : (
        <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
          Retirements of apps you own show up on the left. Only a Hub administrator starts one.
        </p>
      )}
    </div>
  )
}

// ─── Copy an app ─────────────────────────────────────────────────────────────────────────────

function useAppOptions() {
  const apps = useQuery({ queryKey: hubKeys.apps(), queryFn: fetchHubApps })
  const options = (apps.data ?? []).map((a) => ({ value: String(a.id), label: a.name || a.key }))
  return { apps, options }
}

function CopyPanel({ onCopied }: { onCopied: (cloneId: number) => void }) {
  const qc = useQueryClient()
  const { apps, options } = useAppOptions()
  const [appId, setAppId] = useState('')
  const [envId, setEnvId] = useState('')
  const app = useHubApp(appId ? Number(appId) : null)
  const envs = (app.data?.environments ?? [])
    .filter((e) => e.status !== 'archived')
    .sort((a, b) => a.position - b.position || a.id - b.id)
  useEffect(() => {
    // The production environment is the usual source of truth for a structure.
    if (!appId || envId || !envs.length) return
    const prod = envs.find((e) => PROD_KEY_RE.test(e.key)) ?? envs[envs.length - 1]
    setEnvId(String(prod.id))
  }, [appId, envId, envs])
  const copy = useMutation({
    mutationFn: () => captureClone(Number(envId)),
    onSuccess: (out) => {
      toast.success(`Copied into the library as ${out.template.name}`)
      void qc.invalidateQueries({ queryKey: lifecycleKeys.clones() })
      onCopied(out.clone.id)
    }
  })
  return (
    <SectionCard
      title='Copy an app’s structure'
      description='The copy becomes a template in the library; Create app then starts a new app from it.'
      className='max-w-[720px]'
    >
      <div className='space-y-4 px-4 py-4'>
        <div className='grid gap-3 sm:grid-cols-2'>
          <Field id='lc-copy-app' label='App'>
            <SimpleSelect
              value={appId}
              onChange={(v) => {
                setAppId(v)
                setEnvId('')
                copy.reset()
              }}
              options={options}
              ariaLabel='App'
              disabled={apps.isPending}
              className='h-8 text-[13px]'
              triggerProps={{ id: 'lc-copy-app' }}
            />
          </Field>
          <Field id='lc-copy-env' label='Copy from' hint='Its structure is read as it runs now.'>
            <SimpleSelect
              value={envId}
              onChange={(v) => {
                setEnvId(v)
                copy.reset()
              }}
              options={envs.map((e) => ({ value: String(e.id), label: e.key }))}
              ariaLabel='Environment to copy from'
              disabled={!appId || app.isPending}
              className='h-8 text-[13px]'
              triggerProps={{ id: 'lc-copy-env' }}
            />
          </Field>
        </div>
        <dl className='m-0 grid gap-x-6 gap-y-2 text-[12.5px] sm:grid-cols-2'>
          <div>
            <dt className='font-medium text-slate-800 dark:text-foreground'>Copied</dt>
            <dd className='m-0 mt-0.5 leading-relaxed text-slate-600 dark:text-muted-foreground'>
              Collections, fields and relations, workflows and pipelines, layouts, queues, rules
              (switched off), roles with their permissions, flows (inactive).
            </dd>
          </div>
          <div>
            <dt className='font-medium text-slate-800 dark:text-foreground'>Never copied</dt>
            <dd className='m-0 mt-0.5 leading-relaxed text-slate-600 dark:text-muted-foreground'>
              Records, files, people, settings and partner connections. Anything that talks to the
              outside — addresses, headers, passwords, flow and webhook texts — becomes a “fill in”
              placeholder in the app before anything leaves it.
            </dd>
          </div>
        </dl>
        {copy.isError && (
          <ErrorNotice
            description={lifecycleError(copy.error, 'The structure could not be copied')}
          />
        )}
        <div className='flex flex-wrap items-center gap-2'>
          <Button
            size='sm'
            className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
            disabled={!envId || copy.isPending}
            onClick={() => copy.mutate()}
          >
            <CopyPlus className='mr-1.5 h-3.5 w-3.5' aria-hidden />
            {copy.isPending ? 'Copying…' : 'Copy structure'}
          </Button>
          {copy.isPending && (
            <span className='text-[12px] text-slate-500 dark:text-muted-foreground' role='status'>
              Reading the app over its link — a large app takes up to a minute.
            </span>
          )}
        </div>
      </div>
    </SectionCard>
  )
}

function countsLine(c: Record<string, number> | null): string {
  if (!c) return ''
  const part = (n: number | undefined, one: string, many: string) =>
    n ? `${n.toLocaleString('en-US')} ${n === 1 ? one : many}` : null
  return [
    part(c.collections, 'collection', 'collections'),
    part(c.fields, 'field', 'fields'),
    part(c.workflows, 'workflow', 'workflows'),
    part(c.layouts, 'layout', 'layouts'),
    part(c.roles, 'role', 'roles'),
    part(c.flows, 'flow', 'flows'),
    part(c.queues, 'queue', 'queues'),
    part(c.rules, 'rule', 'rules')
  ]
    .filter(Boolean)
    .join(' · ')
}

function CloneDetail({ clone }: { clone: CloneRow | null }) {
  const navigate = useNavigate()
  if (!clone)
    return (
      <p className='m-0 text-[13px] text-slate-500 dark:text-muted-foreground'>
        That structure copy is not in the list.
      </p>
    )
  const src = clone.source
  return (
    <div className='max-w-[720px] space-y-4'>
      <div className='flex flex-wrap items-center gap-2'>
        <h2 className='m-0 text-[15px] font-semibold text-slate-900 dark:text-foreground'>
          {src ? `${src.app_name} · ${src.env_key}` : `Copy #${clone.id}`}
        </h2>
        {src && <HubEnvTag envKey={src.env_key} />}
        {clone.template && !clone.template.archived && (
          <Button
            size='sm'
            className='ml-auto h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
            onClick={() => navigate(`/hub?create=1&template=${clone.template_id}`)}
          >
            <Play className='mr-1.5 h-3.5 w-3.5' aria-hidden /> Create app from it
          </Button>
        )}
      </div>
      <SectionCard title='What was copied'>
        <dl className='m-0 divide-y divide-slate-200 text-[12.5px] dark:divide-border'>
          <Row label='Library template'>
            {clone.template
              ? `${clone.template.name} ${clone.template.version}${clone.template.archived ? ' (archived)' : ''}`
              : 'Deleted from the library'}
          </Row>
          <Row label='Copied'>
            {clone.captured_at ? formatDateTime(clone.captured_at) : '—'}
            {clone.source_version ? ` · from Nivaro ${clone.source_version}` : ''}
          </Row>
          <Row label='Holds'>{countsLine(clone.counts) || '—'}</Row>
          <Row label='Values to fill in'>
            {clone.scrubbed_count === 0
              ? 'None found'
              : `${clone.scrubbed_count} value${clone.scrubbed_count === 1 ? '' : 's'} — fill these in on the new app`}
          </Row>
        </dl>
        {clone.scrubbed.length > 0 && (
          <details className='border-t border-slate-200 px-4 py-3 dark:border-border'>
            <summary className='cursor-pointer text-[12px] font-medium text-slate-700 dark:text-slate-200'>
              Where they were
            </summary>
            <ul className='m-0 mt-2 list-none space-y-1 p-0'>
              {clone.scrubbed.map((p) => (
                <li
                  key={p}
                  className='break-all font-mono text-[11.5px] text-slate-600 dark:text-muted-foreground'
                >
                  {p}
                </li>
              ))}
            </ul>
          </details>
        )}
      </SectionCard>
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='grid gap-1 px-4 py-2.5 sm:grid-cols-[180px_1fr] sm:gap-4'>
      <dt className='text-slate-500 dark:text-muted-foreground'>{label}</dt>
      <dd className='m-0 min-w-0 text-slate-800 dark:text-foreground'>{children}</dd>
    </div>
  )
}

// ─── Retire an app: the plan ─────────────────────────────────────────────────────────────────

const KIND_WORDS: Record<RetireEnvPlan['kind'], string> = {
  docker: 'Docker stack',
  shared: 'Shared deployment',
  manual: 'By hand'
}

function EnvList({ envs }: { envs: RetireEnvPlan[] }) {
  const hubLook = useHubProductFlag()
  return (
    <ul className='m-0 list-none divide-y divide-slate-200 p-0 dark:divide-border'>
      {envs.map((e) => (
        <li
          key={e.id}
          className='flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[12.5px]'
        >
          <span className='font-medium text-slate-900 dark:text-foreground'>{e.key}</span>
          <HubEnvTag envKey={e.key} />
          {e.production && !(hubLook && envTone(e.key) === 'production') && (
            <span className='rounded border border-orange-300 px-1.5 text-[11px] font-medium text-orange-800 dark:border-orange-800 dark:text-orange-300'>
              Production
            </span>
          )}
          <span className='text-slate-600 dark:text-muted-foreground'>
            {KIND_WORDS[e.kind]}
            {e.stack ? ` ${e.stack}` : ''}
          </span>
          <span className='ml-auto text-slate-500 dark:text-muted-foreground'>
            {e.database ? 'Database' : 'No database record'} ·{' '}
            {e.files_target ? 'files target' : 'no files target'}
          </span>
        </li>
      ))}
    </ul>
  )
}

function RetirePlanPanel({ onOpened }: { onOpened: (id: number) => void }) {
  const qc = useQueryClient()
  const { apps, options } = useAppOptions()
  const [appId, setAppId] = useState('')
  const [notice, setNotice] = useState('')
  const id = appId ? Number(appId) : null
  const plan = useQuery({
    queryKey: lifecycleKeys.plan(id ?? 0),
    queryFn: () => fetchRetirePlan(id as number),
    enabled: id != null,
    staleTime: 0
  })
  const open = useMutation({
    mutationFn: () => openRetirement(id as number, plan.data?.plan_hash ?? '', notice),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: lifecycleKeys.retirements() })
      onOpened(r.id)
    },
    onError: (e) => {
      lifecycleToast(e, 'The retirement could not be opened')
      void plan.refetch()
    }
  })
  const p = plan.data
  return (
    <div className='max-w-[820px] space-y-4'>
      <SectionCard
        title='Retire an app'
        description='Read what each step will do. Nothing happens until you sign off the first step.'
      >
        <div className='space-y-4 px-4 py-4'>
          <Field id='lc-retire-app' label='App'>
            <SimpleSelect
              value={appId}
              onChange={setAppId}
              options={options}
              ariaLabel='App to retire'
              disabled={apps.isPending}
              className='h-8 max-w-[360px] text-[13px]'
              triggerProps={{ id: 'lc-retire-app' }}
            />
          </Field>
          {plan.isFetching && !p && <Skeleton className='h-24 w-full' />}
          {plan.isError && (
            <ErrorNotice
              description={lifecycleError(plan.error, 'Could not read the plan')}
              onRetry={() => void plan.refetch()}
            />
          )}
        </div>
      </SectionCard>
      {p && (
        <>
          <SectionCard
            title={`${p.environments.length} environment${p.environments.length === 1 ? '' : 's'}`}
            description='Production is decided by the Hub’s production rule.'
          >
            {p.environments.length ? (
              <EnvList envs={p.environments} />
            ) : (
              <p className='m-0 px-4 py-3 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
                No live environment: only the Hub record is archived.
              </p>
            )}
          </SectionCard>
          <SectionCard title='The five steps'>
            <ol className='m-0 list-none divide-y divide-slate-200 p-0 dark:divide-border'>
              {(Object.keys(STEP_SHORT) as RetireStepKey[]).map((k, i) => (
                <li key={k} className='grid gap-1 px-4 py-3 sm:grid-cols-[160px_1fr] sm:gap-4'>
                  <p className='m-0 text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
                    {i + 1}. {STEP_LABEL[k]}
                    {k === 'remove' && (
                      <span className='block text-[11.5px] font-normal text-red-700 dark:text-red-400'>
                        Cannot be undone
                      </span>
                    )}
                  </p>
                  <ul className='m-0 list-none space-y-1 p-0 text-[12.5px] leading-relaxed text-slate-600 dark:text-muted-foreground'>
                    {(p.lines[k] ?? []).map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          </SectionCard>
          <SectionCard title='Open the retirement'>
            <div className='space-y-3 px-4 py-4'>
              {p.blockers.map((b) => (
                <p
                  key={b.code}
                  role='alert'
                  className='m-0 text-[12.5px] text-red-700 dark:text-red-400'
                >
                  {b.text}
                </p>
              ))}
              {p.warnings.map((w) => (
                <p
                  key={w.code + w.text}
                  className='m-0 text-[12.5px] text-amber-800 dark:text-amber-300'
                >
                  {w.text}
                </p>
              ))}
              <Field
                id='lc-retire-notice'
                label='Final notice'
                hint='Sent to the app’s people at step 3 and shown on its maintenance page. Leave empty for the standard text; you can change it at step 3.'
              >
                <Textarea
                  id='lc-retire-notice'
                  value={notice}
                  maxLength={2000}
                  rows={3}
                  onChange={(e) => setNotice(e.target.value)}
                  placeholder={`${p.app.name} is being retired. It no longer takes changes and will be switched off.`}
                  className='text-[13px]'
                />
              </Field>
              <Button
                size='sm'
                className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
                disabled={p.blockers.length > 0 || open.isPending || plan.isFetching}
                onClick={() => open.mutate()}
              >
                {open.isPending ? 'Opening…' : 'Open the retirement'}
              </Button>
            </div>
          </SectionCard>
        </>
      )}
    </div>
  )
}

const STEP_LABEL: Record<RetireStepKey, string> = {
  freeze: 'Freeze writes',
  export: 'Export data',
  notice: 'Final notice to users',
  remove: 'Stop and remove',
  archive: 'Archive the Hub record'
}

// ─── Retire an app: one retirement ───────────────────────────────────────────────────────────

function RetirementDetail({ id, isAdmin }: { id: number; isAdmin: boolean }) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: lifecycleKeys.retirement(id),
    queryFn: () => fetchRetirement(id),
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 3_000 : 20_000)
  })
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: lifecycleKeys.retirement(id) })
    void qc.invalidateQueries({ queryKey: lifecycleKeys.retirements() })
  }
  const act = useMutation({
    mutationFn: (a: 'undo' | 'cancel' | 'resume') => retirementAction(id, a),
    onSuccess: refresh,
    onError: (e) => lifecycleToast(e, 'That did not work')
  })
  if (q.isPending) return <Skeleton className='h-48 w-full max-w-[820px]' />
  if (q.isError)
    return (
      <QueryErrorState error={q.error} what='the retirement' onRetry={() => void q.refetch()} />
    )
  const r = q.data
  const plan = r.plan
  const undo = r.undo_step ? r.steps.find((s) => s.key === r.undo_step) : null
  return (
    <div className='max-w-[820px] space-y-4'>
      <div className='flex flex-wrap items-center gap-x-3 gap-y-1'>
        <h2 className='m-0 text-[18px] font-semibold text-slate-900 dark:text-foreground'>
          Retiring {plan?.app.name ?? `app ${r.app_id}`}
        </h2>
        <span className={cn('text-[12.5px] font-medium', statusTone(r.status))}>
          {STATUS_WORDS[r.status]}
        </span>
        {r.created_at && (
          <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            opened {formatDateTime(r.created_at)}
          </span>
        )}
      </div>
      <HubRunTimeline
        what='Retirement'
        live={r.status === 'running'}
        steps={r.steps.map((s) => ({
          key: s.key,
          label: s.label,
          short: STEP_SHORT[s.key],
          state: TRACK_STATE[s.state]
        }))}
      />
      {r.error && r.status === 'open' && (
        <ErrorNotice description={{ title: 'The last step did not finish', hint: r.error }} />
      )}
      {isAdmin &&
        (r.status === 'interrupted' || (r.status === 'open' && (undo || r.cancellable))) && (
          <div className='flex flex-wrap items-center gap-2'>
            {r.status === 'interrupted' && (
              <Button
                size='sm'
                className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
                disabled={act.isPending}
                onClick={() => act.mutate('resume')}
              >
                <RotateCcw className='mr-1.5 h-3.5 w-3.5' aria-hidden /> Resume
              </Button>
            )}
            {r.status === 'open' && undo && (
              <Button
                size='sm'
                variant='outline'
                className='h-8'
                disabled={act.isPending}
                onClick={() => act.mutate('undo')}
              >
                <Undo2 className='mr-1.5 h-3.5 w-3.5' aria-hidden /> Undo “{undo.label}”
              </Button>
            )}
            {r.status === 'open' && r.cancellable && (
              <ConfirmButton
                onConfirm={() => act.mutate('cancel')}
                confirmLabel={
                  r.steps.some((s) => s.state === 'done' || s.state === 'failed')
                    ? 'Undo every step and cancel?'
                    : 'Cancel it?'
                }
                title='Cancel the retirement'
                className={cn(ghostButton, 'text-red-600 dark:text-red-400')}
                disabled={act.isPending}
              >
                Cancel the retirement
              </ConfirmButton>
            )}
          </div>
        )}
      <SectionCard title='Steps'>
        <ol className='m-0 list-none divide-y divide-slate-200 p-0 dark:divide-border'>
          {r.steps.map((s, i) => (
            <StepRow
              key={s.key}
              r={r}
              step={s}
              index={i}
              canSign={isAdmin && r.status === 'open' && r.next_step === s.key}
              onStarted={refresh}
            />
          ))}
        </ol>
      </SectionCard>
    </div>
  )
}

function StepRow({
  r,
  step,
  index,
  canSign,
  onStarted
}: {
  r: Retirement
  step: RetireStep
  index: number
  canSign: boolean
  onStarted: () => void
}) {
  const tone =
    step.state === 'done'
      ? 'text-emerald-700 dark:text-emerald-400'
      : step.state === 'failed'
        ? 'text-red-700 dark:text-red-400'
        : step.state === 'interrupted'
          ? 'text-amber-800 dark:text-amber-300'
          : step.state === 'running'
            ? 'text-slate-900 dark:text-foreground'
            : 'text-slate-500 dark:text-muted-foreground'
  const lines = r.lines?.[step.key] ?? []
  return (
    <li className='space-y-2 px-4 py-3.5'>
      <div className='flex flex-wrap items-baseline gap-x-3 gap-y-0.5'>
        <p className='m-0 text-[13px] font-semibold text-slate-900 dark:text-foreground'>
          {index + 1}. {step.label}
        </p>
        <span className={cn('text-[12px] font-medium', tone)}>{STATE_WORDS[step.state]}</span>
        {step.key === 'remove' && step.state === 'pending' && (
          <span className='text-[11.5px] text-red-700 dark:text-red-400'>Cannot be undone</span>
        )}
        {step.signed_off_at && (
          <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            signed off {formatDateTime(step.signed_off_at)}
          </span>
        )}
      </div>
      {step.note && (
        <p className='m-0 text-[12.5px] leading-relaxed text-slate-700 dark:text-slate-200'>
          {step.note}
        </p>
      )}
      {step.sign_note && (
        <p className='m-0 text-[12px] text-slate-600 italic dark:text-muted-foreground'>
          “{step.sign_note}”
        </p>
      )}
      {(step.state === 'pending' || canSign) && lines.length > 0 && (
        <ul className='m-0 list-none space-y-0.5 p-0 text-[12px] leading-relaxed text-slate-600 dark:text-muted-foreground'>
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      {canSign && <SignOffForm r={r} stepKey={step.key} onStarted={onStarted} />}
    </li>
  )
}

function SignOffForm({
  r,
  stepKey,
  onStarted
}: {
  r: Retirement
  stepKey: RetireStepKey
  onStarted: () => void
}) {
  const plan = r.plan
  const envs = plan?.environments ?? []
  const appKey = plan?.app.key ?? ''
  const [note, setNote] = useState('')
  const [confirm, setConfirm] = useState('')
  const [manual, setManual] = useState<number[]>([])
  const [skips, setSkips] = useState<Array<{ environment_id: number; what: 'db' | 'files' }>>(() =>
    envs.flatMap((e) => [
      ...(!e.database ? [{ environment_id: e.id, what: 'db' as const }] : []),
      ...(!e.files_target ? [{ environment_id: e.id, what: 'files' as const }] : [])
    ])
  )
  const [reason, setReason] = useState('')
  const [notice, setNotice] = useState(r.notice ?? '')
  const [lists, setLists] = useState<
    Record<number, { required: boolean; ready: boolean; runId: number | null }>
  >({})
  const firstStep = Object.keys(r.checklists).length === 0 && stepKey === r.next_step
  const prodEnvs = envs.filter((e) => e.production)
  const needsConfirm = stepKey === 'remove' || (stepKey === 'freeze' && !!plan?.production)
  const manualEnvs = envs.filter((e) =>
    stepKey === 'freeze'
      ? e.freeze === 'manual'
      : stepKey === 'remove'
        ? e.kind === 'manual'
        : false
  )
  const checklistBlocks = firstStep && Object.values(lists).some((s) => s.required && !s.ready)
  const start = useMutation({
    mutationFn: () => {
      const body: SignOff = { note: note.trim() || undefined }
      if (needsConfirm) body.confirm = confirm
      if (manualEnvs.length) body.manual = manual
      if (stepKey === 'export') {
        body.skip = skips
        if (reason.trim()) body.reason = reason.trim()
      }
      if (stepKey === 'notice' && notice.trim()) body.notice = notice.trim()
      if (firstStep) {
        const runs: Record<string, number> = {}
        for (const [envId, s] of Object.entries(lists)) if (s.runId) runs[envId] = s.runId
        if (Object.keys(runs).length) body.checklist_runs = runs
      }
      return startRetireStep(r.id, stepKey, body)
    },
    onSuccess: () => {
      toast.success(`${STEP_LABEL[stepKey]}: signed off`)
      onStarted()
    }
  })
  const onList = useCallback(
    (envId: number) => (s: { required: boolean; ready: boolean; runId: number | null }) =>
      setLists((cur) => {
        const prev = cur[envId]
        if (
          prev &&
          prev.required === s.required &&
          prev.ready === s.ready &&
          prev.runId === s.runId
        )
          return cur
        return { ...cur, [envId]: s }
      }),
    []
  )
  const listHandlers = useMemo(
    () => new Map(prodEnvs.map((e) => [e.id, onList(e.id)])),
    [prodEnvs, onList]
  )
  const missingManual = manualEnvs.some((e) => !manual.includes(e.id))
  const isSkipped = (envId: number, what: 'db' | 'files') =>
    skips.some((s) => s.environment_id === envId && s.what === what)
  const toggleSkip = (envId: number, what: 'db' | 'files', on: boolean) =>
    setSkips((cur) =>
      on
        ? [...cur, { environment_id: envId, what }]
        : cur.filter((s) => !(s.environment_id === envId && s.what === what))
    )
  const disabled =
    start.isPending ||
    (needsConfirm && confirm !== appKey) ||
    missingManual ||
    (manualEnvs.length > 0 && !note.trim()) ||
    (stepKey === 'export' && skips.length > 0 && reason.trim().length < 10) ||
    checklistBlocks

  const guarded = !!plan?.production && (stepKey === 'freeze' || stepKey === 'remove')
  const form = (
    <div
      className={cn(
        'space-y-3',
        !guarded &&
          'rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-border dark:bg-background'
      )}
    >
      {firstStep &&
        prodEnvs.map((e) => (
          <PreDeployChecklist
            key={e.id}
            target={{ kind: 'environment', envId: e.id }}
            action='retire'
            version={null}
            onState={listHandlers.get(e.id)}
          />
        ))}
      {stepKey === 'export' && (
        <fieldset className='m-0 space-y-2 border-0 p-0'>
          <legend className='mb-1 text-[12px] font-medium text-slate-700 dark:text-foreground'>
            Backups
          </legend>
          {envs.map((e) => (
            <div key={e.id} className='flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px]'>
              <span className='w-28 truncate font-medium text-slate-800 dark:text-foreground'>
                {e.key}
              </span>
              {(['db', 'files'] as const).map((what) => {
                const can = what === 'db' ? e.database : e.files_target
                const id = `lc-skip-${e.id}-${what}`
                return (
                  <label
                    key={what}
                    htmlFor={id}
                    className='inline-flex items-center gap-1.5 text-slate-700 dark:text-slate-200'
                  >
                    <Checkbox
                      id={id}
                      checked={isSkipped(e.id, what)}
                      disabled={!can}
                      onCheckedChange={(v) => toggleSkip(e.id, what, v === true)}
                    />
                    Skip {what === 'db' ? 'database' : 'files'}
                    {!can && (
                      <span className='text-slate-500 dark:text-muted-foreground'>
                        ({what === 'db' ? 'no database record' : 'no files target'})
                      </span>
                    )}
                  </label>
                )
              })}
            </div>
          ))}
          {skips.length > 0 && (
            <Field id='lc-skip-reason' label='Why the skipped parts need no backup'>
              <Input
                id='lc-skip-reason'
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className='h-8 text-[13px]'
                placeholder='For example: staging holds test data only'
              />
            </Field>
          )}
        </fieldset>
      )}
      {stepKey === 'notice' && (
        <Field
          id='lc-notice'
          label='Final notice'
          hint='In the app and by email, and on the maintenance page.'
        >
          <Textarea
            id='lc-notice'
            value={notice}
            maxLength={2000}
            rows={3}
            onChange={(e) => setNotice(e.target.value)}
            placeholder={`${plan?.app.name ?? 'The app'} is being retired. It no longer takes changes and will be switched off.`}
            className='text-[13px]'
          />
        </Field>
      )}
      {manualEnvs.length > 0 && (
        <fieldset className='m-0 space-y-1.5 border-0 p-0'>
          <legend className='mb-1 text-[12px] font-medium text-slate-700 dark:text-foreground'>
            {stepKey === 'freeze'
              ? 'The Hub cannot freeze these: put them in maintenance yourself'
              : 'The Hub cannot stop these: stop them yourself'}
          </legend>
          {manualEnvs.map((e) => {
            const id = `lc-manual-${stepKey}-${e.id}`
            return (
              <label
                key={e.id}
                htmlFor={id}
                className='flex items-center gap-1.5 text-[12.5px] text-slate-700 dark:text-slate-200'
              >
                <Checkbox
                  id={id}
                  checked={manual.includes(e.id)}
                  onCheckedChange={(v) =>
                    setManual((cur) =>
                      v === true ? [...cur, e.id] : cur.filter((x) => x !== e.id)
                    )
                  }
                />
                I {stepKey === 'freeze' ? 'put' : 'stopped'} {e.key}
                {stepKey === 'freeze' ? ' in maintenance' : ''}
              </label>
            )
          })}
        </fieldset>
      )}
      <Field
        id={`lc-note-${stepKey}`}
        label={manualEnvs.length ? 'Sign-off note (say how you did it)' : 'Sign-off note'}
      >
        <Input
          id={`lc-note-${stepKey}`}
          value={note}
          maxLength={1000}
          onChange={(e) => setNote(e.target.value)}
          className='h-8 text-[13px]'
          placeholder='What you checked'
        />
      </Field>
      {needsConfirm && (
        <Field
          id={`lc-confirm-${stepKey}`}
          label={`Type ${appKey} to ${stepKey === 'remove' ? 'stop and remove it' : 'freeze it'}`}
        >
          <Input
            id={`lc-confirm-${stepKey}`}
            value={confirm}
            autoComplete='off'
            spellCheck={false}
            onChange={(e) => setConfirm(e.target.value)}
            className='h-8 max-w-[320px] font-mono text-[13px]'
          />
        </Field>
      )}
      {start.isError && (
        <ErrorNotice
          description={lifecycleError(start.error, `${STEP_LABEL[stepKey]} did not start`)}
        />
      )}
      <Button
        size='sm'
        className={cn(
          'h-8',
          stepKey === 'remove'
            ? 'bg-red-600 text-white hover:bg-red-700'
            : 'bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
        )}
        disabled={disabled}
        onClick={() => start.mutate()}
      >
        {start.isPending ? 'Starting…' : STEP_VERB[stepKey]}
      </Button>
    </div>
  )
  // Production frame on the steps that reach live users.
  return guarded ? (
    <ProductionGuard envKey='production' what={stepKey === 'remove' ? 'removal' : 'freeze'}>
      {form}
    </ProductionGuard>
  ) : (
    form
  )
}
