import { ConfirmButton, ErrorNotice, QueryErrorState } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileStack,
  Loader2,
  Undo2
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { HubEnvTag, ProductionGuard } from '@/components/hub-brand/HubBits'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn, formatRelative } from '@/lib/utils'
import { type ChecklistState, PreDeployChecklist } from '../changes/PreDeployChecklist'
import { EnvWindowGate } from '../changes/WindowGate'
import { fetchHubApps, hubKeys, useHubApp } from '../hub-api'
import { dangerArmed, Field, ghostButton, SectionCard } from '../hub-parts'
import {
  type ConfigPromotion,
  configError,
  configKeys,
  type PlanView,
  type RowChange,
  refusalItems,
  STATUS_LABEL,
  STATUS_TONE,
  shownValue,
  type TableChange,
  tableWords,
  type UndoPreview,
  useConfigGroups,
  useConfigSwitch,
  usePromotion,
  usePromotions
} from './config-api'

/**
 * Config (Apps hub tab, administrators): move an app's configuration — flows, payload
 * templates, managed procedures, roles, settings without secrets — from one of its
 * environments to another. Plan (a field diff the target app computes), typed confirm on
 * production, apply; every applied promotion can be undone from the target's restore point.
 * URL: ?app=<id>&promotion=<id> (a notice opens ?promotion=<id> alone).
 */
export default function HubConfig() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  if (!isAdmin)
    return (
      <div className='flex flex-1 items-center justify-center bg-slate-50 p-8 text-center dark:bg-background'>
        <p className='m-0 max-w-[48ch] text-[13px] text-slate-600 dark:text-muted-foreground'>
          Only administrators promote configuration between environments.
        </p>
      </div>
    )
  return <ConfigAdmin />
}

function useParam(
  name: string
): [number | null, (v: number | null, also?: Record<string, number | null>) => void] {
  const [params, setParams] = useSearchParams()
  const value = Number(params.get(name)) || null
  const set = (v: number | null, also: Record<string, number | null> = {}) =>
    setParams((p) => {
      const out = new URLSearchParams(p)
      for (const [k, x] of Object.entries({ [name]: v, ...also })) {
        if (x) out.set(k, String(x))
        else out.delete(k)
      }
      return out
    })
  return [value, set]
}

function ConfigAdmin() {
  const apps = useQuery({ queryKey: hubKeys.apps(), queryFn: fetchHubApps })
  const [appParam, setApp] = useParam('app')
  const [promotionId, setPromotion] = useParam('promotion')
  // A notice links to ?promotion=<id> alone: its app comes from the promotion.
  const linked = usePromotion(appParam ? null : promotionId)
  const appId = appParam ?? linked.data?.app_id ?? null

  return (
    <div className='flex flex-1 min-h-0 overflow-hidden'>
      <aside
        className={cn(
          'w-full shrink-0 flex-col overflow-y-auto border-slate-200 bg-white md:flex md:w-[272px] md:border-r dark:border-border dark:bg-card',
          appId ? 'hidden' : 'flex'
        )}
      >
        <p className='m-0 border-b border-slate-200 px-3 py-2 text-[12px] font-medium text-slate-500 dark:border-border dark:text-muted-foreground'>
          Apps
        </p>
        {apps.isPending ? (
          <div className='space-y-2 p-3'>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className='h-10 w-full' />
            ))}
          </div>
        ) : apps.isError ? (
          <QueryErrorState
            error={apps.error}
            what='the apps'
            onRetry={() => void apps.refetch()}
            className='m-3'
          />
        ) : apps.data.length === 0 ? (
          <p className='m-0 px-4 py-6 text-center text-[12px] text-slate-500 dark:text-muted-foreground'>
            No apps yet. Add one on the Apps tab first.
          </p>
        ) : (
          <ul className='m-0 list-none space-y-0.5 p-2'>
            {apps.data.map((a) => (
              <li key={a.id}>
                <button
                  type='button'
                  onClick={() => setApp(a.id, { promotion: null })}
                  aria-current={a.id === appId ? 'true' : undefined}
                  className={cn(
                    'w-full rounded-md px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
                    a.id === appId ? 'bg-accent' : 'hover:bg-muted'
                  )}
                >
                  <span className='block truncate text-[13px] font-medium text-slate-900 dark:text-foreground'>
                    {a.name}
                  </span>
                  <span className='block truncate font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
                    {a.key}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
      <div
        className={cn(
          'min-w-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-background',
          appId ? 'block' : 'hidden md:block'
        )}
      >
        {appId ? (
          <>
            <div className='border-b border-slate-200 bg-white px-2 py-1.5 md:hidden dark:border-border dark:bg-card'>
              <button
                type='button'
                className={ghostButton}
                onClick={() => setApp(null, { promotion: null })}
              >
                <ChevronLeft className='h-3.5 w-3.5' aria-hidden /> All apps
              </button>
            </div>
            <AppConfigPanel
              key={appId}
              appId={appId}
              promotionId={promotionId}
              open={(id) => setPromotion(id, { app: appId })}
            />
          </>
        ) : linked.isPending && promotionId ? (
          <div className='space-y-3 p-4'>
            <Skeleton className='h-24 w-full' />
          </div>
        ) : (
          <div className='flex h-full flex-col items-center justify-center p-8 text-center'>
            <div className='flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 dark:bg-muted'>
              <FileStack
                className='h-5 w-5 text-slate-400 dark:text-muted-foreground'
                aria-hidden
              />
            </div>
            <p className='mt-3 mb-0 text-[13px] font-medium text-slate-700 dark:text-foreground'>
              Pick an app
            </p>
            <p className='m-0 mt-1 max-w-[46ch] text-[12px] text-slate-500 dark:text-muted-foreground'>
              Move its flows, payload templates, procedures, roles and settings from one environment
              to another. You see every field that changes before anything is written, and you can
              undo it afterwards.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function AppConfigPanel({
  appId,
  promotionId,
  open
}: {
  appId: number
  promotionId: number | null
  open: (id: number | null) => void
}) {
  const app = useHubApp(appId)
  const list = usePromotions(appId)
  const sw = useConfigSwitch()
  const on = sw.data?.config_promotion === true
  if (app.isPending)
    return (
      <div className='space-y-3 p-4'>
        <Skeleton className='h-24 w-full' />
        <Skeleton className='h-48 w-full' />
      </div>
    )
  if (app.isError)
    return (
      <QueryErrorState
        error={app.error}
        what='this app'
        onRetry={() => void app.refetch()}
        className='m-4'
      />
    )
  const envs = app.data.environments
    .filter((e) => e.status !== 'archived')
    .sort((a, b) => a.position - b.position || a.id - b.id)
  const envKey = (id: number) => envs.find((e) => e.id === id)?.key ?? `environment ${id}`
  const selected =
    promotionId != null ? (list.data?.find((p) => p.id === promotionId) ?? null) : null
  return (
    <div className='space-y-4 p-4 sm:p-6'>
      <header>
        <h2 className='m-0 text-[18px] font-semibold text-slate-900 dark:text-foreground'>
          {app.data.name} configuration
        </h2>
        <p className='m-0 mt-1 max-w-[80ch] text-[12px] text-slate-500 dark:text-muted-foreground'>
          The target app works out the plan from its own rows. Secrets, people, the schema and what
          the target keeps for itself (mail, keys, endpoints, sign-in, switches) never travel.
        </p>
      </header>
      <SwitchNotice />
      {selected && (
        <PromotionPanel key={selected.id} p={selected} envKey={envKey} onClose={() => open(null)} />
      )}
      {!on ? null : envs.length < 2 ? (
        <p className='m-0 rounded-md border border-slate-200 bg-white px-3 py-3 text-[12px] text-slate-600 dark:border-border dark:bg-card dark:text-muted-foreground'>
          This app needs two environments before configuration can move between them.
        </p>
      ) : (
        <PlanForm appId={appId} envs={envs} onPlanned={(id) => open(id)} />
      )}
      <HistoryCard
        list={list.data ?? []}
        pending={list.isPending}
        error={list.isError ? list.error : null}
        retry={() => void list.refetch()}
        envKey={envKey}
        selectedId={promotionId}
        open={open}
      />
    </div>
  )
}

/**
 * The Hub's config promotion switch. Off (the default) until promotion has been tried on a
 * staging pair: new plans and applies are refused; checking and undoing past promotions still
 * work. Turning it on takes two presses; turning it off one.
 */
function SwitchNotice() {
  const qc = useQueryClient()
  const sw = useConfigSwitch()
  const save = useMutation({
    mutationFn: (on: boolean) => api.put('/hub/config/switch', { config_promotion: on }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: configKeys.switch() })
    }
  })
  if (!sw.data) return null
  const on = sw.data.config_promotion
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border px-3 py-2 text-[12px]',
        on
          ? 'border-slate-200 bg-white text-slate-600 dark:border-border dark:bg-card dark:text-muted-foreground'
          : 'border-slate-200 bg-slate-100 text-slate-700 dark:border-border dark:bg-muted/50 dark:text-foreground'
      )}
    >
      <p className='m-0 max-w-[80ch]'>
        {on ? (
          <>
            Config promotion is{' '}
            <span className='font-medium text-emerald-700 dark:text-emerald-400'>on</span> on this
            Hub.
          </>
        ) : (
          sw.data.notice
        )}
      </p>
      {on ? (
        <button
          type='button'
          className={ghostButton}
          disabled={save.isPending}
          onClick={() => save.mutate(false)}
        >
          Turn off
        </button>
      ) : (
        <ConfirmButton
          title='Turn config promotion on'
          confirmLabel='Turn on?'
          className={cn(ghostButton, 'border border-slate-200 dark:border-border')}
          armedClassName={dangerArmed}
          disabled={save.isPending}
          onConfirm={() => save.mutate(true)}
        >
          Turn on
        </ConfirmButton>
      )}
      {save.isError && (
        <ErrorNotice description={configError(save.error, 'Could not change the switch')} />
      )}
    </div>
  )
}

function useInvalidate(appId: number) {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: configKeys.list(appId) })
    void qc.invalidateQueries({ queryKey: ['hub', 'config', 'one'] })
  }
}

function PlanForm({
  appId,
  envs,
  onPlanned
}: {
  appId: number
  envs: Array<{ id: number; key: string }>
  onPlanned: (id: number) => void
}) {
  const groups = useConfigGroups()
  const invalidate = useInvalidate(appId)
  const [source, setSource] = useState(String(envs[0]?.id ?? ''))
  const [target, setTarget] = useState(String(envs[1]?.id ?? ''))
  const [picked, setPicked] = useState<string[]>([])
  const [deletes, setDeletes] = useState(false)
  const [cascade, setCascade] = useState(false)
  const plan = useMutation({
    mutationFn: () =>
      api
        .post<{ data: ConfigPromotion }>(`/hub/apps/${appId}/config-promotions/plan`, {
          source_env_id: Number(source),
          target_env_id: Number(target),
          groups: picked,
          deletes,
          allow_cascade: deletes && cascade
        })
        .then((r) => r.data.data),
    onSuccess: (p) => {
      invalidate()
      onPlanned(p.id)
    }
  })
  const options = envs.map((e) => ({ value: String(e.id), label: e.key }))
  const same = source === target
  const toggle = (k: string, on: boolean) =>
    setPicked((cur) => (on ? [...new Set([...cur, k])] : cur.filter((x) => x !== k)))
  return (
    <SectionCard
      title='New promotion'
      description='Pick where the configuration comes from, where it goes and what kinds of configuration move.'
    >
      <div className='space-y-4 p-4'>
        <div className='grid gap-3 sm:flex sm:flex-wrap sm:items-end'>
          <Field id='cfg-source' label='From'>
            <SimpleSelect
              value={source}
              onChange={setSource}
              options={options}
              ariaLabel='From environment'
              className='h-8 w-full text-[13px] sm:w-[180px]'
            />
          </Field>
          <ArrowRight
            className='mb-2 hidden h-4 w-4 shrink-0 text-slate-400 sm:block dark:text-muted-foreground'
            aria-hidden
          />
          <Field id='cfg-target' label='To'>
            <SimpleSelect
              value={target}
              onChange={setTarget}
              options={options}
              ariaLabel='To environment'
              className='h-8 w-full text-[13px] sm:w-[180px]'
            />
          </Field>
        </div>
        {same && (
          <p className='m-0 text-[12px] text-amber-700 dark:text-amber-400'>
            Pick two different environments.
          </p>
        )}
        <fieldset className='m-0 border-0 p-0'>
          <legend className='mb-2 p-0 text-[12px] font-medium text-slate-700 dark:text-foreground'>
            What moves
          </legend>
          {groups.isPending ? (
            <Skeleton className='h-24 w-full' />
          ) : groups.isError ? (
            <QueryErrorState
              error={groups.error}
              what='what can be promoted'
              onRetry={() => void groups.refetch()}
            />
          ) : (
            <ul className='m-0 grid list-none gap-x-6 gap-y-2.5 p-0 sm:grid-cols-2'>
              {groups.data.map((g) => (
                <li key={g.key} className='flex gap-2.5'>
                  <Checkbox
                    id={`cfg-g-${g.key}`}
                    checked={picked.includes(g.key)}
                    onCheckedChange={(v) => toggle(g.key, v === true)}
                    className='mt-0.5'
                  />
                  <label htmlFor={`cfg-g-${g.key}`} className='min-w-0 cursor-pointer'>
                    <span className='block text-[13px] font-medium text-slate-900 dark:text-foreground'>
                      {g.label}
                    </span>
                    <span className='block text-[12px] text-slate-500 dark:text-muted-foreground'>
                      {g.hint}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
        <div className='space-y-2 border-t border-slate-100 pt-3 dark:border-border'>
          <label htmlFor='cfg-deletes' className='flex items-start gap-2.5 text-[12px]'>
            <Switch
              id='cfg-deletes'
              checked={deletes}
              onCheckedChange={setDeletes}
              aria-label='Also remove rows the source no longer has'
              className='mt-px'
            />
            <span>
              <span className='block font-medium text-slate-800 dark:text-foreground'>
                Also remove rows the source no longer has
              </span>
              <span className='block text-slate-500 dark:text-muted-foreground'>
                Off: the plan only adds and changes rows.
              </span>
            </span>
          </label>
          {deletes && (
            <label htmlFor='cfg-cascade' className='flex items-start gap-2.5 pl-11 text-[12px]'>
              <Checkbox
                id='cfg-cascade'
                checked={cascade}
                onCheckedChange={(v) => setCascade(v === true)}
                className='mt-px'
              />
              <span className='text-slate-700 dark:text-foreground'>
                Let removals take linked rows in other tables with them
              </span>
            </label>
          )}
        </div>
        <div className='flex flex-wrap items-center gap-3'>
          <Button
            size='sm'
            className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
            disabled={same || picked.length === 0 || plan.isPending}
            onClick={() => plan.mutate()}
          >
            {plan.isPending && (
              <Loader2
                className='h-3.5 w-3.5 animate-spin motion-reduce:animate-none'
                aria-hidden
              />
            )}
            {plan.isPending ? 'Reading both environments…' : 'Plan promotion'}
          </Button>
          {picked.length === 0 && !same && (
            <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
              Pick at least one kind of configuration.
            </span>
          )}
        </div>
        {plan.isError && (
          <>
            <ErrorNotice description={configError(plan.error, 'Could not plan the promotion')} />
            <RefusalList error={plan.error} />
          </>
        )}
      </div>
    </SectionCard>
  )
}

function StatusPill({ status }: { status: ConfigPromotion['status'] }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-px text-[11px] font-medium',
        STATUS_TONE[status]
      )}
    >
      {(status === 'applying' || status === 'undoing') && (
        <Loader2 className='h-3 w-3 animate-spin motion-reduce:animate-none' aria-hidden />
      )}
      {STATUS_LABEL[status]}
    </span>
  )
}

const QUIET = 'text-slate-500 dark:text-muted-foreground'

function Counts({ t }: { t: { inserts: number; updates: number; deletes: number } }) {
  return (
    <span className='inline-flex flex-wrap gap-x-3 text-[12px] tabular-nums'>
      <span className={t.inserts ? 'text-emerald-700 dark:text-emerald-400' : QUIET}>
        {t.inserts} to add
      </span>
      <span className={t.updates ? 'text-sky-700 dark:text-sky-400' : QUIET}>
        {t.updates} to change
      </span>
      <span className={t.deletes ? 'text-red-700 dark:text-red-400' : QUIET}>
        {t.deletes} to remove
      </span>
    </span>
  )
}

function PromotionPanel({
  p,
  envKey,
  onClose
}: {
  p: ConfigPromotion
  envKey: (id: number) => string
  onClose: () => void
}) {
  const from = envKey(p.source_environment_id)
  const to = envKey(p.target_environment_id)
  return (
    <SectionCard
      title={`Promotion #${p.id}: ${from} → ${to}`}
      description={
        <>
          Planned {p.planned_at ? formatRelative(p.planned_at) : ''}
          {p.applied_at ? ` · applied ${formatRelative(p.applied_at)}` : ''}
          {p.undone_at ? ` · undone ${formatRelative(p.undone_at)}` : ''}
          {p.source_version && p.target_version
            ? ` · Nivaro ${p.source_version} → ${p.target_version}`
            : ''}
        </>
      }
      actions={
        <>
          <StatusPill status={p.status} />
          <button type='button' className={ghostButton} onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className='space-y-4 p-4'>
        {p.error && (
          <p className='m-0 flex gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200'>
            <AlertTriangle className='mt-0.5 h-3.5 w-3.5 shrink-0' aria-hidden />
            <span>{p.error}</span>
          </p>
        )}
        {(p.status === 'interrupted' || (p.status === 'failed' && p.run_key)) && (
          <CheckTarget p={p} to={to} />
        )}
        {p.result?.totals && <Outcome p={p} to={to} />}
        {p.plan && <PlanBody plan={p.plan} to={to} />}
        {p.status === 'planned' && p.plan && <ApplyBox p={p} from={from} to={to} />}
        {p.undo_ready && <UndoBox p={p} to={to} />}
        {p.status === 'applied' && !p.undo_ready && (
          <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
            A newer promotion has written to {to} since; only the newest one can be undone.
          </p>
        )}
      </div>
    </SectionCard>
  )
}

function Outcome({ p, to }: { p: ConfigPromotion; to: string }) {
  const t = p.result?.totals
  const u = p.undo_result?.totals
  const procs = p.result?.procedures
  return (
    <div className='rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] text-slate-700 dark:border-border dark:bg-muted/40 dark:text-foreground'>
      {t && (
        <p className='m-0'>
          Written to {to}: {t.inserted} added, {t.updated} changed, {t.deleted} removed. {to}{' '}
          recorded exactly what it wrote.
        </p>
      )}
      {procs && (procs.written > 0 || procs.failed.length > 0) && (
        <p className='m-0 mt-1'>
          Procedures: {procs.written} saved and deployed
          {procs.failed.length > 0 && (
            <span className='text-red-700 dark:text-red-400'>
              {`; did not deploy: ${procs.failed.join(', ')}`}
            </span>
          )}
          .
        </p>
      )}
      {(p.result?.needs_setup?.length ?? 0) > 0 && (
        <SetupList items={p.result?.needs_setup ?? []} to={to} done />
      )}
      {p.result?.baseline?.startsWith('not moved') && (
        <p className='m-0 mt-1 flex gap-1.5 text-amber-800 dark:text-amber-300'>
          <AlertTriangle className='mt-0.5 h-3.5 w-3.5 shrink-0' aria-hidden />
          <span>
            Changed here on {to} kept its old baseline (
            {p.result.baseline.replace(/^not moved:\s*/, '')}). Rows this promotion wrote may show
            as changed here until the next promotion.
          </span>
        </p>
      )}
      {u && (
        <p className='m-0 mt-1'>
          Undone: {u.inserted} put back, {u.updated} changed back, {u.deleted} removed again.
        </p>
      )}
    </div>
  )
}

function Notes({ plan }: { plan: PlanView }) {
  const [open, setOpen] = useState(false)
  const stripped = plan.stripped_steps ?? []
  const n =
    plan.kept.length +
    plan.refused.length +
    plan.held.length +
    plan.switched_off.length +
    stripped.length
  if (!n) return null
  return (
    <div className='rounded-md border border-slate-200 dark:border-border'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className='flex w-full items-center gap-1.5 px-3 py-2 text-left text-[12px] font-medium text-slate-700 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-foreground'
      >
        {open ? (
          <ChevronDown className='h-3.5 w-3.5' aria-hidden />
        ) : (
          <ChevronRight className='h-3.5 w-3.5' aria-hidden />
        )}
        What stays as it is on the target
        <span className='font-normal text-slate-500 dark:text-muted-foreground'>({n})</span>
      </button>
      {open && (
        <ul className='m-0 list-none space-y-1.5 border-t border-slate-200 px-3 py-2 text-[12px] dark:border-border'>
          {plan.kept.map((k) => (
            <li key={`k-${k.table}`} className='text-slate-700 dark:text-foreground'>
              <span className='font-medium'>{tableWords(k.table)}</span>: keeps{' '}
              <span className='font-mono text-[11px]'>{k.columns.join(', ')}</span>
            </li>
          ))}
          {plan.refused.map((r) => (
            <li key={`r-${r.table}`} className='text-slate-700 dark:text-foreground'>
              <span className='font-medium'>{tableWords(r.table)}</span>: not promoted — {r.reason}
            </li>
          ))}
          {plan.held.map((h) => (
            <li key={`h-${h.table}-${h.key}`} className='text-amber-800 dark:text-amber-300'>
              <span className='font-medium'>
                {tableWords(h.table)} {h.label ?? `#${h.key}`}
              </span>
              : held back — {h.reason}
            </li>
          ))}
          {plan.switched_off.map((s) => (
            <li key={`s-${s.table}-${s.key}`} className='text-slate-700 dark:text-foreground'>
              <span className='font-medium'>
                {tableWords(s.table)} {s.label ?? `#${s.key}`}
              </span>
              : new here, arrives switched off
            </li>
          ))}
          {stripped.map((s) => (
            <li key={`o-${s.key}`} className='text-slate-700 dark:text-foreground'>
              <span className='font-medium'>Step {s.label ?? `#${s.key}`}</span>: keeps its own{' '}
              <span className='font-mono text-[11px]'>{s.paths.join(', ')}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function PlanBody({ plan, to }: { plan: PlanView; to: string }) {
  const empty = plan.totals.inserts + plan.totals.updates + plan.totals.deletes === 0
  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center gap-x-4 gap-y-1'>
        <Counts t={plan.totals} />
        <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          across {plan.totals.tables} table{plan.totals.tables === 1 ? '' : 's'}
          {plan.skipped_inactive_user
            ? ` · ${plan.skipped_inactive_user} grant${plan.skipped_inactive_user === 1 ? '' : 's'} skipped (person not active on ${to})`
            : ''}
        </span>
      </div>
      {plan.prod_only.count > 0 && (
        <div className='rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200'>
          <p className='m-0 font-medium'>
            {plan.prod_only.count} change{plan.prod_only.count === 1 ? '' : 's'} made on {to}, not
            from promotion, would be overwritten
            {plan.prod_only.refuse
              ? ' — that environment refuses it unless you say so below.'
              : '.'}
          </p>
          <ul className='m-0 mt-1 list-disc space-y-0.5 pl-4'>
            {plan.prod_only.lines.slice(0, 8).map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      )}
      {(plan.flags?.length ?? 0) > 0 && <RenameList items={plan.flags ?? []} />}
      {(plan.orphans?.length ?? 0) > 0 && <OrphanList items={plan.orphans ?? []} to={to} />}
      {(plan.needs_setup?.length ?? 0) > 0 && <SetupList items={plan.needs_setup ?? []} to={to} />}
      {plan.warnings.length > 0 && (
        <ul className='m-0 list-none space-y-1 p-0'>
          {plan.warnings.map((w) => (
            <li key={w} className='flex gap-2 text-[12px] text-amber-800 dark:text-amber-300'>
              <AlertTriangle className='mt-0.5 h-3.5 w-3.5 shrink-0' aria-hidden />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      )}
      {plan.cascade.length > 0 && (
        <p className='m-0 text-[12px] text-red-700 dark:text-red-400'>
          Removals would also take{' '}
          {plan.cascade.map((c) => `${c.rows} ${tableWords(c.child)}`).join(', ')} with them.
        </p>
      )}
      <Notes plan={plan} />
      {empty ? (
        <p className='m-0 rounded-md border border-slate-200 bg-white px-3 py-3 text-[12px] text-slate-600 dark:border-border dark:bg-card dark:text-muted-foreground'>
          {to} already has this configuration. Nothing would change.
        </p>
      ) : (
        <div className='space-y-2'>
          {plan.tables.map((t) => (
            <TableDiff key={t.table} t={t} to={to} />
          ))}
        </div>
      )}
    </div>
  )
}

const OP_WORD: Record<RowChange['op'], string> = {
  insert: 'Add',
  update: 'Change',
  delete: 'Remove'
}
const OP_TONE: Record<RowChange['op'], string> = {
  insert: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
  update: 'bg-sky-50 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300',
  delete: 'bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300'
}

function TableDiff({ t, to }: { t: TableChange; to: string }) {
  const [open, setOpen] = useState(t.rows.length > 0 && t.rows.length <= 5)
  return (
    <div className='overflow-hidden rounded-md border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className='flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/50'
      >
        <span className='inline-flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-slate-900 dark:text-foreground'>
          {open ? (
            <ChevronDown className='h-3.5 w-3.5 shrink-0' aria-hidden />
          ) : (
            <ChevronRight className='h-3.5 w-3.5 shrink-0' aria-hidden />
          )}
          <span className='first-letter:uppercase'>{tableWords(t.table)}</span>
        </span>
        <Counts t={t} />
      </button>
      {open && (
        <div className='border-t border-slate-200 dark:border-border'>
          {t.rows.map((r) => (
            <RowDiff key={`${r.op}-${r.key}`} r={r} to={to} />
          ))}
          {t.more > 0 && (
            <p className='m-0 border-t border-slate-100 px-3 py-2 text-[12px] text-slate-500 dark:border-border dark:text-muted-foreground'>
              and {t.more} more row{t.more === 1 ? '' : 's'} not shown (the counts above are exact).
            </p>
          )}
          {t.dropped_columns.length > 0 && (
            <p className='m-0 border-t border-slate-100 px-3 py-2 text-[12px] text-slate-500 dark:border-border dark:text-muted-foreground'>
              {to} has no{' '}
              <span className='font-mono text-[11px]'>{t.dropped_columns.join(', ')}</span> column;
              those values are not written.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function RowDiff({ r, to }: { r: RowChange; to: string }) {
  return (
    <div className='border-b border-slate-100 px-3 py-2 last:border-b-0 dark:border-border'>
      <p className='m-0 flex flex-wrap items-center gap-2 text-[12px]'>
        <span className={cn('rounded px-1.5 py-px text-[11px] font-medium', OP_TONE[r.op])}>
          {OP_WORD[r.op]}
        </span>
        <span className='font-medium text-slate-900 dark:text-foreground'>
          {r.label ?? `#${r.key}`}
        </span>
        {r.label && (
          <span className='font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
            #{r.key}
          </span>
        )}
      </p>
      {r.fields.length > 0 && (
        <dl className='m-0 mt-1.5 grid grid-cols-1 gap-x-3 gap-y-1 text-[12px] sm:grid-cols-[minmax(7rem,max-content)_minmax(0,1fr)_minmax(0,1fr)]'>
          <div className='hidden text-[11px] text-slate-500 sm:contents dark:text-muted-foreground'>
            <span>Field</span>
            <span>On {to} now</span>
            <span>After</span>
          </div>
          {r.fields.map((f) => (
            <div key={f.field} className='contents'>
              <dt className='m-0 font-mono text-[11px] text-slate-600 dark:text-muted-foreground'>
                {f.field}
              </dt>
              <dd
                className={cn(
                  'm-0 min-w-0 break-words font-mono text-[11px] text-slate-500 dark:text-muted-foreground',
                  r.op === 'update' && 'line-through decoration-slate-300 sm:no-underline',
                  r.op === 'insert' && 'hidden sm:block'
                )}
              >
                {r.op === 'insert' ? '—' : shownValue(f.current)}
              </dd>
              <dd
                className={cn(
                  'm-0 min-w-0 break-words font-mono text-[11px] text-slate-900 dark:text-foreground',
                  r.op === 'delete' && 'hidden sm:block'
                )}
              >
                {r.op === 'delete' ? '—' : shownValue(f.incoming)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

function ConfirmField({
  id,
  to,
  value,
  onChange
}: {
  id: string
  to: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <Field id={id} label={`Type ${to} to confirm`}>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete='off'
        spellCheck={false}
        className='h-8 max-w-[260px] font-mono text-[13px]'
      />
    </Field>
  )
}

function ApplyBox({ p, from, to }: { p: ConfigPromotion; from: string; to: string }) {
  const invalidate = useInvalidate(p.app_id)
  const [typed, setTyped] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const [outsideReason, setOutsideReason] = useState<string | null>(null)
  const [checklist, setChecklist] = useState<ChecklistState>({
    required: false,
    ready: true,
    runId: null
  })
  const plan = p.plan as PlanView
  const needsOverwrite = plan.prod_only.refuse
  const empty = plan.totals.inserts + plan.totals.updates + plan.totals.deletes === 0
  const apply = useMutation({
    mutationFn: () =>
      api
        .post<{ data: ConfigPromotion }>(`/hub/config-promotions/${p.id}/apply`, {
          plan_hash: p.plan_hash,
          confirm: p.production ? typed.trim() : undefined,
          overwrite_prod_changes: needsOverwrite && overwrite,
          ...(checklist.runId != null ? { checklist_run_id: checklist.runId } : {}),
          ...(outsideReason ? { outside_window_reason: outsideReason } : {})
        })
        .then((r) => r.data.data),
    onSuccess: () => {
      toast.success(`Configuration promoted to ${to}`)
      invalidate()
    },
    onError: () => invalidate()
  })
  const blocked =
    empty ||
    plan.over_cap ||
    (p.production && typed.trim() !== to) ||
    (needsOverwrite && !overwrite) ||
    (checklist.required && !checklist.ready) ||
    apply.isPending
  return (
    <ProductionGuard envKey={p.production ? to : null} what='promotion'>
      <div className='space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-border dark:bg-muted/30'>
        {plan.over_cap ? (
          <p className='m-0 text-[12px] text-red-700 dark:text-red-400'>
            More than {plan.cap} rows would change at once. Plan fewer kinds of configuration.
          </p>
        ) : (
          <p className='m-0 text-[12px] text-slate-600 dark:text-muted-foreground'>
            Applying reads {from} again. If either environment changed since this plan, nothing is
            written and you plan again. {to} records exactly what it writes, so the newest promotion
            can be undone.
          </p>
        )}
        {needsOverwrite && (
          <label
            htmlFor={`cfg-overwrite-${p.id}`}
            className='flex items-start gap-2 text-[12px] text-slate-800 dark:text-foreground'
          >
            <Checkbox
              id={`cfg-overwrite-${p.id}`}
              checked={overwrite}
              onCheckedChange={(v) => setOverwrite(v === true)}
              className='mt-px'
            />
            Overwrite the {plan.prod_only.count} change{plan.prod_only.count === 1 ? '' : 's'} made
            on {to}
          </label>
        )}
        <EnvWindowGate envId={p.target_environment_id} what='config' onReason={setOutsideReason} />
        <PreDeployChecklist
          target={{ kind: 'environment', envId: p.target_environment_id }}
          action='config_promote'
          version={`config-promotion-${p.id}`}
          onState={setChecklist}
        />
        {p.production && (
          <ConfirmField id={`cfg-confirm-${p.id}`} to={to} value={typed} onChange={setTyped} />
        )}
        <ConfirmButton
          title={`Apply to ${to}`}
          confirmLabel={`Write to ${to}?`}
          className='inline-flex h-8 items-center gap-1.5 rounded-md bg-nvr-cyan px-3 text-[12px] font-medium text-white hover:bg-nvr-cyan/90 disabled:opacity-50'
          armedClassName={dangerArmed}
          disabled={blocked}
          onConfirm={() => apply.mutate()}
        >
          {apply.isPending && (
            <Loader2 className='h-3.5 w-3.5 animate-spin motion-reduce:animate-none' aria-hidden />
          )}
          {apply.isPending ? 'Applying…' : `Apply to ${to}`}
        </ConfirmButton>
        {apply.isError && (
          <>
            <ErrorNotice description={configError(apply.error, 'Could not apply the promotion')} />
            <RefusalList error={apply.error} />
          </>
        )}
      </div>
    </ProductionGuard>
  )
}

function UndoBox({ p, to }: { p: ConfigPromotion; to: string }) {
  const invalidate = useInvalidate(p.app_id)
  const [typed, setTyped] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const [preview, setPreview] = useState<UndoPreview | null>(null)
  const load = useMutation({
    mutationFn: () =>
      api
        .post<{ data: UndoPreview }>(`/hub/config-promotions/${p.id}/undo/plan`)
        .then((r) => r.data.data),
    onSuccess: setPreview
  })
  const undo = useMutation({
    mutationFn: () =>
      api.post(`/hub/config-promotions/${p.id}/undo`, {
        plan_hash: preview?.plan_hash,
        confirm: typed.trim(),
        overwrite_prod_changes: preview?.plan.prod_only.refuse ? overwrite : false
      }),
    onSuccess: () => {
      toast.success(`${to} has its configuration from before #${p.id} back`)
      invalidate()
    },
    onError: () => invalidate()
  })
  const needsOverwrite = !!preview?.plan.prod_only.refuse
  return (
    <div className='space-y-3 border-t border-slate-200 pt-4 dark:border-border'>
      <div className='flex flex-wrap items-center gap-3'>
        <h4 className='m-0 text-[13px] font-semibold text-slate-900 dark:text-foreground'>Undo</h4>
        <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          Puts back exactly the rows this promotion wrote on {to}. Rows changed since stop it; a
          freeze or a closed deploy window does not.
        </span>
      </div>
      {!preview ? (
        <button
          type='button'
          className={cn(ghostButton, 'border border-slate-200 dark:border-border')}
          disabled={load.isPending}
          onClick={() => load.mutate()}
        >
          {load.isPending ? (
            <Loader2 className='h-3.5 w-3.5 animate-spin motion-reduce:animate-none' aria-hidden />
          ) : (
            <Undo2 className='h-3.5 w-3.5' aria-hidden />
          )}
          See what undo would change
        </button>
      ) : (
        <>
          <PlanBody plan={preview.plan} to={to} />
          <ProductionGuard envKey={p.production ? to : null} what='undo'>
            <div className='space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-border dark:bg-muted/30'>
              {needsOverwrite && (
                <label
                  htmlFor={`cfg-undo-overwrite-${p.id}`}
                  className='flex items-start gap-2 text-[12px] text-slate-800 dark:text-foreground'
                >
                  <Checkbox
                    id={`cfg-undo-overwrite-${p.id}`}
                    checked={overwrite}
                    onCheckedChange={(v) => setOverwrite(v === true)}
                    className='mt-px'
                  />
                  Overwrite the changes made on {to} since
                </label>
              )}
              <ConfirmField
                id={`cfg-undo-confirm-${p.id}`}
                to={to}
                value={typed}
                onChange={setTyped}
              />
              <ConfirmButton
                title={`Undo on ${to}`}
                confirmLabel={`Put ${to} back?`}
                className={cn(ghostButton, 'border border-slate-200 dark:border-border')}
                armedClassName={dangerArmed}
                disabled={undo.isPending || typed.trim() !== to || (needsOverwrite && !overwrite)}
                onConfirm={() => undo.mutate()}
              >
                {undo.isPending ? 'Undoing…' : `Undo on ${to}`}
              </ConfirmButton>
            </div>
          </ProductionGuard>
        </>
      )}
      {load.isError && (
        <ErrorNotice description={configError(load.error, 'Could not read what undo would do')} />
      )}
      {undo.isError && (
        <>
          <ErrorNotice description={configError(undo.error, 'Could not undo the promotion')} />
          <RefusalList error={undo.error} />
        </>
      )}
    </div>
  )
}

function RefusalList({ error }: { error: unknown }) {
  const items = refusalItems(error)
  if (!items.length) return null
  return (
    <ul className='m-0 list-none space-y-1 rounded-md border border-slate-200 bg-white px-3 py-2 text-[12px] dark:border-border dark:bg-card'>
      {items.map((i) => (
        <li key={`${i.table}-${i.key}-${i.reason}`} className='text-slate-700 dark:text-foreground'>
          <span className='font-medium'>
            <span className='first-letter:uppercase'>{tableWords(i.table)}</span>{' '}
            {i.label ?? `#${i.key}`}
          </span>
          : {i.reason}
        </li>
      ))}
    </ul>
  )
}

function RenameList({ items }: { items: NonNullable<PlanView['flags']> }) {
  return (
    <div className='rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200'>
      <p className='m-0 font-medium'>Possibly a renamed flow — check before anything is removed</p>
      <ul className='m-0 mt-1 list-disc space-y-0.5 pl-4'>
        {items.slice(0, 20).map((f) => (
          <li key={`${f.table}-${f.key}`}>
            <span className='font-medium'>{f.label ?? `#${f.key}`}</span>: {f.reason}
          </li>
        ))}
      </ul>
    </div>
  )
}

function OrphanList({ items, to }: { items: NonNullable<PlanView['orphans']>; to: string }) {
  return (
    <div className='rounded-md border border-slate-200 bg-white px-3 py-2 text-[12px] text-slate-700 dark:border-border dark:bg-card dark:text-foreground'>
      <p className='m-0 font-medium'>
        Removed with their flow on {to}
        <span className='font-normal text-slate-500 dark:text-muted-foreground'>
          {' '}
          — the source no longer has these steps; undo puts them back
        </span>
      </p>
      <ul className='m-0 mt-1 list-disc space-y-0.5 pl-4'>
        {items.slice(0, 20).map((o) => (
          <li key={o.key}>{o.label ?? `Step #${o.key}`}</li>
        ))}
      </ul>
      {items.length > 20 && (
        <p className='m-0 mt-1 text-slate-500 dark:text-muted-foreground'>
          and {items.length - 20} more
        </p>
      )}
    </div>
  )
}

function SetupList({
  items,
  to,
  done
}: {
  items: Array<{ flow: string | null; step: string | null; reason: string }>
  to: string
  done?: boolean
}) {
  return (
    <div className='rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200'>
      <p className='m-0 font-medium'>
        {done ? 'Switched off on ' : 'Will arrive switched off on '}
        {to} until set up there
      </p>
      <ul className='m-0 mt-1 list-disc space-y-0.5 pl-4'>
        {items.slice(0, 20).map((n) => (
          <li key={`${n.flow}-${n.step}-${n.reason}`}>
            <span className='font-medium'>{[n.flow, n.step].filter(Boolean).join(' → ')}</span>:{' '}
            {n.reason}
          </li>
        ))}
      </ul>
    </div>
  )
}

function CheckTarget({ p, to }: { p: ConfigPromotion; to: string }) {
  const invalidate = useInvalidate(p.app_id)
  const check = useMutation({
    mutationFn: () =>
      api
        .post<{ data: ConfigPromotion }>(`/hub/config-promotions/${p.id}/check`)
        .then((r) => r.data.data),
    onSuccess: (q) => {
      toast.success(`${to} says: ${STATUS_LABEL[q.status].toLowerCase()}`)
      invalidate()
    }
  })
  return (
    <div className='flex flex-wrap items-center gap-3'>
      <button
        type='button'
        className={cn(ghostButton, 'border border-slate-200 dark:border-border')}
        disabled={check.isPending}
        onClick={() => check.mutate()}
      >
        {check.isPending && (
          <Loader2 className='h-3.5 w-3.5 animate-spin motion-reduce:animate-none' aria-hidden />
        )}
        Check the target
      </button>
      <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
        Reads what {to} itself recorded for this promotion.
      </span>
      {check.isError && (
        <ErrorNotice description={configError(check.error, 'Could not read the target')} />
      )}
    </div>
  )
}

function HistoryCard({
  list,
  pending,
  error,
  retry,
  envKey,
  selectedId,
  open
}: {
  list: ConfigPromotion[]
  pending: boolean
  error: unknown
  retry: () => void
  envKey: (id: number) => string
  selectedId: number | null
  open: (id: number) => void
}) {
  const groups = useConfigGroups()
  const label = useMemo(
    () => new Map((groups.data ?? []).map((g) => [g.key, g.label])),
    [groups.data]
  )
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])
  void now
  return (
    <SectionCard title='History' description='The newest 50 promotions of this app.'>
      {pending ? (
        <div className='space-y-2 p-4'>
          <Skeleton className='h-10 w-full' />
          <Skeleton className='h-10 w-full' />
        </div>
      ) : error ? (
        <QueryErrorState error={error} what='the promotions' onRetry={retry} className='m-4' />
      ) : list.length === 0 ? (
        <p className='m-0 px-4 py-6 text-center text-[12px] text-slate-500 dark:text-muted-foreground'>
          No promotions yet. Plan one above: nothing is written until you apply it.
        </p>
      ) : (
        <ul className='m-0 list-none p-0'>
          {list.map((p) => {
            const to = envKey(p.target_environment_id)
            return (
              <li
                key={p.id}
                className='border-b border-slate-100 last:border-b-0 dark:border-border'
              >
                <button
                  type='button'
                  onClick={() => open(p.id)}
                  aria-current={p.id === selectedId ? 'true' : undefined}
                  className={cn(
                    'flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/50',
                    p.id === selectedId ? 'bg-accent' : 'hover:bg-muted'
                  )}
                >
                  <span className='font-mono text-[11px] text-slate-500 tabular-nums dark:text-muted-foreground'>
                    #{p.id}
                  </span>
                  <span className='inline-flex items-center gap-1 text-[13px] font-medium text-slate-900 dark:text-foreground'>
                    {envKey(p.source_environment_id)}
                    <ArrowRight
                      className='h-3 w-3 text-slate-400 dark:text-muted-foreground'
                      aria-label='to'
                    />
                    {to}
                    <HubEnvTag envKey={to} className='ml-1' />
                  </span>
                  <span className='order-last min-w-0 basis-full truncate text-[12px] text-slate-500 sm:order-none sm:basis-0 sm:flex-1 dark:text-muted-foreground'>
                    {p.groups.map((g) => label.get(g) ?? g).join(', ')}
                  </span>
                  <span className='text-[11px] text-slate-500 tabular-nums dark:text-muted-foreground'>
                    {formatRelative(p.applied_at ?? p.planned_at ?? '')}
                  </span>
                  <StatusPill status={p.status} />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </SectionCard>
  )
}
