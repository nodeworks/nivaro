import { QueryErrorState } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ChevronLeft, Gauge, Pin, SlidersHorizontal, Zap } from 'lucide-react'
import { Fragment, type ReactNode, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { HubEnvTag, ProductionGuard } from '@/components/hub-brand/HubBits'
import { HubRunTimeline, type RunStep } from '@/components/hub-brand/HubRunTimeline'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useAuth } from '@/lib/auth'
import { cn, formatDateTime, formatRelative } from '@/lib/utils'
import { PlanBeforeAfter } from '../costs/StackEstimate'
import { hubToast } from '../hub-api'
import {
  type ChipTone,
  countLabel,
  ghostButton,
  ListPaneHeader,
  listPaneClass,
  SectionCard,
  smallButton,
  ToneChip
} from '../hub-parts'
import { TONE, type Tone } from '../shared/shared-api'
import { RuleEditor } from './RuleEditor'
import {
  type AutoRule,
  type ConnMath,
  cancelScaleRun,
  changeText,
  fetchDbServers,
  fetchScaleDetail,
  fetchScaleOverview,
  METRIC_WORDS,
  type Pause,
  parseTargetParam,
  planScale,
  ROLE_HINT,
  ROLE_WORDS,
  type RoleChange,
  type RoleView,
  RUN_STATUS_WORDS,
  type RunStatus,
  type ScalePlan,
  type ScaleRun,
  SOURCE_WORDS,
  saveDbServerLimit,
  saveRole,
  scaleKeys,
  startScale,
  type TargetDetail,
  type TargetKind,
  type TargetView,
  targetParam
} from './scale-api'

/**
 * Scaling (Apps hub tab): every Docker stack the Hub runs — dedicated stacks and shared
 * deployments — with, per role, what swarm runs now against what the Hub keeps, the limits, the
 * "pin manual" switch and the autoscaling rule; a change is planned (connection math against the
 * database server and the shared pool budget, blockers, steps) and started as a scale run; the
 * recent runs and the automatic decisions that could not run, each with the figure behind it.
 * Hub administrators only.
 */
export default function HubScale() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  const [params, setParams] = useSearchParams()
  const picked = parseTargetParam(params.get('target'))
  const list = useQuery({
    queryKey: scaleKeys.overview(),
    queryFn: fetchScaleOverview,
    enabled: isAdmin,
    refetchInterval: 30_000
  })
  const show = (t: { kind: TargetKind; id: number } | null) =>
    setParams((p) => {
      const out = new URLSearchParams(p)
      if (t) out.set('target', targetParam(t))
      else out.delete('target')
      return out
    })

  if (!isAdmin)
    return (
      <div className='flex flex-1 items-center justify-center bg-slate-50 p-8 text-center dark:bg-background'>
        <p className='m-0 max-w-[48ch] text-[13px] text-slate-600 dark:text-muted-foreground'>
          Scaling is for Hub administrators.
        </p>
      </div>
    )

  const targets = list.data?.targets ?? []
  const dedicated = targets.filter((t) => t.kind === 'environment')
  const shared = targets.filter((t) => t.kind === 'shared')

  return (
    <div className='flex flex-1 min-h-0 overflow-hidden'>
      <aside className={cn(listPaneClass, picked ? 'hidden md:flex' : 'flex')}>
        <ListPaneHeader
          label={countLabel(list.data ? targets.length : undefined, 'stack', 'stacks')}
        />
        {list.isPending ? (
          <div className='space-y-2 p-3'>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className='h-14 w-full' />
            ))}
          </div>
        ) : list.isError ? (
          <QueryErrorState
            error={list.error}
            what='the stacks'
            onRetry={() => void list.refetch()}
            className='m-3'
          />
        ) : targets.length === 0 ? (
          <p className='m-0 px-4 py-6 text-center text-[12px] text-slate-500 dark:text-muted-foreground'>
            No Docker stacks yet. Environments placed on a Hub Docker driver and Docker shared
            deployments show here.
          </p>
        ) : (
          <>
            <TargetGroup
              title='Dedicated stacks'
              rows={dedicated}
              picked={picked}
              onPick={(t) => show(t)}
            />
            <TargetGroup
              title='Shared deployments'
              rows={shared}
              picked={picked}
              onPick={(t) => show(t)}
            />
          </>
        )}
      </aside>
      <div
        className={cn(
          'relative min-w-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-background',
          picked ? 'block' : 'hidden md:block'
        )}
      >
        {picked && (
          <div className='border-b border-slate-200 bg-white px-2 py-1.5 md:hidden dark:border-border dark:bg-card'>
            <button type='button' className={ghostButton} onClick={() => show(null)}>
              <ChevronLeft className='h-3.5 w-3.5' aria-hidden /> All stacks
            </button>
          </div>
        )}
        {picked ? (
          <TargetPanel key={targetParam(picked)} kind={picked.kind} id={picked.id} />
        ) : (
          <NothingPicked />
        )}
      </div>
    </div>
  )
}

/** The scale tab's chips: the hub ToneChip (warn yellow, accent "busy" in the Hub look). */
const CHIP_TONE: Record<Tone, ChipTone> = {
  ok: 'ok',
  busy: 'live',
  warn: 'warn',
  bad: 'down',
  quiet: 'neutral'
}

function Chip({ tone, children, tip }: { tone: Tone; children: ReactNode; tip?: string }) {
  return (
    <ToneChip tone={CHIP_TONE[tone]} tip={tip} compact>
      {children}
    </ToneChip>
  )
}

function TargetGroup({
  title,
  rows,
  picked,
  onPick
}: {
  title: string
  rows: TargetView[]
  picked: { kind: TargetKind; id: number } | null
  onPick: (t: { kind: TargetKind; id: number }) => void
}) {
  if (!rows.length) return null
  return (
    <div className='border-b border-slate-200 last:border-b-0 dark:border-border'>
      <h3 className='m-0 px-3 pt-3 pb-1 text-[11px] font-semibold text-slate-500 dark:text-muted-foreground'>
        {title}
      </h3>
      <ul aria-label={title} className='m-0 list-none space-y-0.5 p-2 pt-0'>
        {rows.map((t) => {
          const active = picked?.kind === t.kind && picked.id === t.id
          return (
            <li key={`${t.kind}:${t.id}`}>
              <button
                type='button'
                aria-current={active ? 'true' : undefined}
                onClick={() => onPick(t)}
                className={cn(
                  'w-full rounded-md px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
                  active ? 'bg-accent' : 'hover:bg-muted'
                )}
              >
                <span className='flex items-center gap-1.5'>
                  <span className='min-w-0 flex-1 truncate text-[13px] font-medium text-slate-900 dark:text-foreground'>
                    {t.label}
                  </span>
                  {t.kind === 'environment' && <HubEnvTag envKey={t.key.split('/')[1]} />}
                </span>
                <span className='mt-1 flex flex-wrap items-center gap-1.5 text-[11px] tabular-nums text-slate-500 dark:text-muted-foreground'>
                  {t.unusable ? (
                    <span>{t.unusable.text.split(':')[0]}</span>
                  ) : (
                    <span className='truncate'>
                      {t.roles.map((r) => `${ROLE_WORDS[r.role]} ${r.replicas}`).join(' · ')}
                    </span>
                  )}
                </span>
                {(t.open_run || t.autoscaling || t.maxed) && (
                  <span className='mt-1 flex flex-wrap items-center gap-1'>
                    {t.open_run && <Chip tone='busy'>Scaling now</Chip>}
                    {t.autoscaling && (
                      <Chip tone='quiet'>
                        <Zap className='h-2.5 w-2.5' aria-hidden /> Autoscaling
                      </Chip>
                    )}
                    {t.maxed && (
                      <Chip tone='warn' tip='A rule kept wanting more than its max today'>
                        <AlertTriangle className='h-2.5 w-2.5' aria-hidden /> At its max
                      </Chip>
                    )}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function NothingPicked() {
  return (
    <div className='space-y-4 p-4 sm:p-6'>
      <div className='flex flex-col items-center px-4 py-8 text-center'>
        <div className='flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 dark:bg-muted'>
          <Gauge className='h-5 w-5 text-slate-400 dark:text-muted-foreground' aria-hidden />
        </div>
        <p className='mt-3 mb-0 text-[13px] font-medium text-slate-700 dark:text-foreground'>
          Pick a stack
        </p>
        <p className='m-0 mt-1 max-w-[52ch] text-[12px] text-slate-500 dark:text-muted-foreground'>
          See how many processes each role runs, change them or their limits, and let rules scale
          web, realtime, importer and exporter with the load. The worker always stays at one.
        </p>
      </div>
      <DbServersCard />
    </div>
  )
}

// ─── one stack ───────────────────────────────────────────────────────────────

function TargetPanel({ kind, id }: { kind: TargetKind; id: number }) {
  const qc = useQueryClient()
  const detail = useQuery({
    queryKey: scaleKeys.detail(kind, id),
    queryFn: () => fetchScaleDetail(kind, id),
    refetchInterval: (q) => (q.state.data?.open_run ? 4_000 : 30_000)
  })
  const [editing, setEditing] = useState(false)
  const [ruleFor, setRuleFor] = useState<string | null>(null)
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: scaleKeys.all })
  }
  const save = useMutation({
    mutationFn: (v: {
      role: RoleView
      body: { pinned?: boolean; auto?: AutoRule | null; resume?: boolean }
    }) => saveRole(kind, id, v.role.role, v.body),
    onSuccess: (data, v) => {
      qc.setQueryData(scaleKeys.detail(kind, id), data)
      void qc.invalidateQueries({ queryKey: scaleKeys.overview() })
      if (v.body.auto !== undefined) {
        setRuleFor(null)
        toast.success(v.body.auto ? 'Rule saved' : 'Rule removed')
      }
      if (v.body.resume) toast.success('Rule resumed')
    },
    onError: (err) => hubToast(err, 'Could not save')
  })

  if (detail.isPending)
    return (
      <div className='space-y-3 p-4 sm:p-6'>
        <Skeleton className='h-16 w-full' />
        <Skeleton className='h-48 w-full' />
      </div>
    )
  if (detail.isError)
    return (
      <div className='p-4 sm:p-6'>
        <QueryErrorState
          error={detail.error}
          what='this stack'
          onRetry={() => void detail.refetch()}
        />
      </div>
    )
  const d = detail.data
  const envKey = d.kind === 'environment' ? d.key.split('/')[1] : null
  const openRun = d.runs.find((r) => r.status === 'running') ?? null
  const blockers = d.unusable ? [{ code: d.unusable.code, text: d.unusable.text }] : d.now.blockers

  return (
    <div className='space-y-4 p-4 sm:p-6'>
      <header className='flex flex-wrap items-start gap-3'>
        <div className='min-w-0 flex-1'>
          <h2 className='m-0 flex flex-wrap items-center gap-2 text-[16px] font-semibold text-slate-900 dark:text-foreground'>
            {d.label}
            {envKey && <HubEnvTag envKey={envKey} />}
          </h2>
          <p className='m-0 mt-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
            <span className='font-mono'>{d.stack ?? 'no stack'}</span> · size {d.size}
            {d.version ? ` · ${d.version}` : ''}
            {d.kind === 'shared' ? ' · shared deployment' : ' · dedicated stack'}
          </p>
        </div>
        <SwarmState d={d} />
      </header>

      {blockers.length > 0 && !editing && (
        <Notice tone='warn' items={blockers} title='Scaling is held' />
      )}
      {d.now.warnings.length > 0 && !editing && (
        <Notice tone='quiet' items={d.now.warnings} title='Good to know' />
      )}
      {d.roles.some((r) => r.paused_at) && (
        <div role='status' className={cn('rounded-lg border px-3 py-2.5 text-[12px]', TONE.warn)}>
          <p className='m-0 flex items-center gap-1.5 font-medium'>
            <AlertTriangle className='h-3.5 w-3.5 shrink-0' aria-hidden /> Autoscaling paused itself
          </p>
          <ul className='m-0 mt-1 list-none space-y-1.5 p-0'>
            {d.roles
              .filter((r) => r.paused_at)
              .map((r) => (
                <li key={r.role} className='flex flex-wrap items-center gap-x-3 gap-y-1'>
                  <span className='min-w-0 flex-1'>
                    {ROLE_WORDS[r.role]}: {r.paused_reason ?? 'repeated failed changes.'}
                  </span>
                  <button
                    type='button'
                    className={cn(
                      smallButton,
                      'bg-white text-slate-800 shadow-sm hover:bg-slate-50 dark:bg-card dark:text-foreground dark:hover:bg-muted'
                    )}
                    disabled={save.isPending}
                    onClick={() => save.mutate({ role: r, body: { resume: true } })}
                  >
                    Resume rule
                  </button>
                </li>
              ))}
          </ul>
        </div>
      )}
      {d.autoscaling && d.now.connections.limit_unknown && (
        <div role='status' className={cn('rounded-lg border px-3 py-2.5 text-[12px]', TONE.warn)}>
          <p className='m-0 flex flex-wrap items-center gap-x-3 gap-y-1'>
            <span className='min-w-0 flex-1'>
              <span className='font-medium'>Autoscaling cannot add processes.</span>{' '}
              {d.now.connections.unknown.length
                ? 'The Hub has no database record for this stack’s database, so it cannot check new connections against a limit.'
                : 'The database server’s connection limit is not set, so the Hub cannot check new connections against it. Scaling in still runs.'}
            </span>
            {!d.now.connections.unknown.length && (
              <a
                href='#scale-db-limits'
                className={cn(
                  smallButton,
                  'bg-white text-slate-800 shadow-sm hover:bg-slate-50 dark:bg-card dark:text-foreground dark:hover:bg-muted'
                )}
              >
                Set the limit
              </a>
            )}
          </p>
        </div>
      )}
      {d.maxed && (
        <Notice
          tone='warn'
          title='A rule keeps hitting its max'
          items={d.roles
            .filter((r) => r.max_hits >= 3)
            .map((r) => ({
              code: r.role,
              text: `${ROLE_WORDS[r.role]} wanted more than ${r.auto?.max ?? 'its max'} replicas ${r.max_hits} times in 24 hours. Raise the max, or look at what grew.`
            }))}
        />
      )}

      {openRun && <OpenRun run={openRun} onCancelled={refresh} />}

      <SectionCard
        title='Roles'
        description='What swarm runs, what the Hub keeps, and the limits of each process.'
        actions={
          !editing && !d.unusable ? (
            <button
              type='button'
              className={ghostButton}
              disabled={!!openRun}
              onClick={() => setEditing(true)}
            >
              <SlidersHorizontal className='h-3.5 w-3.5' aria-hidden /> Change…
            </button>
          ) : null
        }
      >
        {editing ? (
          <ChangePanel
            d={d}
            envKey={envKey}
            onDone={() => {
              setEditing(false)
              refresh()
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <RolesTable
            d={d}
            ruleFor={ruleFor}
            saving={save.isPending}
            onPin={(role, pinned) => save.mutate({ role, body: { pinned } })}
            onRule={(role) => setRuleFor(ruleFor === role.role ? null : role.role)}
            onSaveRule={(role, rule) => save.mutate({ role, body: { auto: rule } })}
            onClearRule={(role) => save.mutate({ role, body: { auto: null } })}
          />
        )}
      </SectionCard>

      <ConnectionsCard c={d.now.connections} title='Database connections now' />
      <RunsCard runs={d.runs} />
      <DbServersCard />
    </div>
  )
}

function SwarmState({ d }: { d: TargetDetail }) {
  if (d.unusable) return null
  const state = d.status?.state
  const health = !d.status
    ? 'unknown'
    : state === 'converged'
      ? 'ok'
      : state === 'updating'
        ? 'warn'
        : 'down'
  const words = !d.status
    ? 'The agent did not answer'
    : state === 'converged'
      ? 'Running as kept'
      : state === 'updating'
        ? 'Swarm is updating'
        : state === 'rolled_back'
          ? 'Swarm rolled back'
          : state === 'paused'
            ? 'Update paused'
            : 'Not all running'
  return (
    <div className='flex flex-col items-end gap-1 text-right'>
      <span className='flex items-center gap-1.5 text-[12px] font-medium text-slate-700 dark:text-foreground'>
        <span
          aria-hidden
          className={cn(
            'inline-block h-2 w-2 shrink-0 rounded-full',
            health === 'ok'
              ? 'bg-emerald-500'
              : health === 'warn'
                ? 'bg-amber-500 motion-safe:animate-pulse'
                : health === 'down'
                  ? 'bg-red-500'
                  : 'bg-slate-400'
          )}
        />{' '}
        {words}
      </span>
      <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
        Agent {d.now.agent.version ?? 'unknown'}
        {d.now.agent.ok ? '' : ' · needs 0.2.4 to scale'}
      </span>
    </div>
  )
}

function Notice({ tone, title, items }: { tone: Tone; title: string; items: Pause[] }) {
  return (
    <div
      role={tone === 'warn' ? 'status' : undefined}
      className={cn('rounded-lg border px-3 py-2.5 text-[12px]', TONE[tone])}
    >
      <p className='m-0 flex items-center gap-1.5 font-medium'>
        {tone === 'warn' && <AlertTriangle className='h-3.5 w-3.5 shrink-0' aria-hidden />}
        {title}
      </p>
      <ul className='m-0 mt-1 list-disc space-y-0.5 pl-5'>
        {items.map((b) => (
          <li key={`${b.code}:${b.text}`}>{b.text}</li>
        ))}
      </ul>
    </div>
  )
}

const limitText = (r: { cpus: number | null; memory_mb: number | null }) =>
  `${r.cpus == null ? '—' : `${r.cpus} CPU`} · ${r.memory_mb == null ? '—' : `${(r.memory_mb / 1024).toFixed(r.memory_mb % 1024 ? 1 : 0)} GB`}`

function RolesTable({
  d,
  ruleFor,
  saving,
  onPin,
  onRule,
  onSaveRule,
  onClearRule
}: {
  d: TargetDetail
  ruleFor: string | null
  saving: boolean
  onPin: (r: RoleView, pinned: boolean) => void
  onRule: (r: RoleView) => void
  onSaveRule: (r: RoleView, rule: AutoRule) => void
  onClearRule: (r: RoleView) => void
}) {
  const phone = usePhone()
  if (phone)
    return (
      <RoleCards
        d={d}
        ruleFor={ruleFor}
        saving={saving}
        onPin={onPin}
        onRule={onRule}
        onSaveRule={onSaveRule}
        onClearRule={onClearRule}
      />
    )
  return (
    <div className='overflow-x-auto'>
      <table className='w-full min-w-[640px] border-collapse text-[12px]'>
        <thead>
          <tr className='border-b border-slate-200 text-left text-[11px] text-slate-500 dark:border-border dark:text-muted-foreground'>
            <th className='px-4 py-2 font-medium'>Role</th>
            <th className='px-3 py-2 text-right font-medium'>Running</th>
            <th className='px-3 py-2 text-right font-medium'>Kept</th>
            <th className='px-3 py-2 font-medium'>Limits per process</th>
            <th className='px-3 py-2 font-medium'>Autoscaling</th>
            <th className='px-4 py-2 text-right font-medium'>Pin manual</th>
          </tr>
        </thead>
        <tbody>
          {d.roles.map((r) => {
            const off = r.running && r.running.running !== r.running.desired
            const changed = r.replicas !== r.template.replicas
            return (
              <Fragment key={r.role}>
                <tr className='border-b border-slate-100 last:border-b-0 dark:border-border/60'>
                  <td className='px-4 py-2.5 align-top'>
                    <span
                      className='font-medium text-slate-900 dark:text-foreground'
                      data-tip={ROLE_HINT[r.role]}
                    >
                      {ROLE_WORDS[r.role]}
                    </span>
                    {!r.scalable && (
                      <span className='block text-[11px] text-slate-500 dark:text-muted-foreground'>
                        {r.role === 'worker'
                          ? 'Stays at one'
                          : d.sqlite
                            ? 'SQLite: one process'
                            : 'Fixed'}
                      </span>
                    )}
                  </td>
                  <td
                    className={cn(
                      'px-3 py-2.5 text-right align-top tabular-nums',
                      off
                        ? 'text-amber-700 dark:text-amber-300'
                        : 'text-slate-700 dark:text-foreground'
                    )}
                  >
                    {r.running ? `${r.running.running} / ${r.running.desired}` : '—'}
                  </td>
                  <td className='px-3 py-2.5 text-right align-top tabular-nums'>
                    <span className='font-medium text-slate-900 dark:text-foreground'>
                      {r.replicas}
                    </span>
                    {changed && (
                      <span
                        className='block text-[11px] text-slate-500 dark:text-muted-foreground'
                        data-tip='The size template’s count'
                      >
                        size: {r.template.replicas}
                      </span>
                    )}
                  </td>
                  <td className='px-3 py-2.5 align-top tabular-nums text-slate-700 dark:text-foreground'>
                    {limitText(r)}
                  </td>
                  <td className='px-3 py-2.5 align-top'>
                    {r.scalable ? (
                      <button
                        type='button'
                        className={cn(ghostButton, 'h-7 -ml-2 px-2')}
                        aria-expanded={ruleFor === r.role}
                        onClick={() => onRule(r)}
                      >
                        <span
                          className={cn(
                            r.auto && (!r.auto.enabled || r.pinned) && 'text-slate-500'
                          )}
                        >
                          {ruleSummary(r)}
                        </span>
                      </button>
                    ) : (
                      <span className='text-slate-400 dark:text-muted-foreground'>—</span>
                    )}
                  </td>
                  <td className='px-4 py-2.5 text-right align-top'>
                    {r.scalable ? (
                      <span className='inline-flex items-center gap-2'>
                        {r.pinned && <Pin className='h-3.5 w-3.5 text-slate-500' aria-hidden />}
                        <Switch
                          checked={r.pinned}
                          disabled={saving}
                          onCheckedChange={(v) => onPin(r, v)}
                          aria-label={`Pin ${ROLE_WORDS[r.role]} to manual`}
                        />
                      </span>
                    ) : null}
                  </td>
                </tr>
                {ruleFor === r.role && (
                  <tr>
                    <td colSpan={6} className='p-0'>
                      <RuleEditor
                        role={r}
                        saving={saving}
                        onSave={(rule) => onSaveRule(r, rule)}
                        onClear={r.auto ? () => onClearRule(r) : null}
                        onCancel={() => onRule(r)}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
      {d.roles.some((r) => r.pinned) && (
        <p className='m-0 border-t border-slate-200 px-4 py-2 text-[11px] text-slate-500 dark:border-border dark:text-muted-foreground'>
          A pinned role keeps the count you set: its rule never changes it.
        </p>
      )}
    </div>
  )
}

/** Narrow screens get the roles as a list (the table would scroll its switches out of view). */
function usePhone(): boolean {
  const query = '(max-width: 639px)'
  const [on, setOn] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches
  )
  useEffect(() => {
    const m = window.matchMedia?.(query)
    if (!m) return
    const update = () => setOn(m.matches)
    m.addEventListener('change', update)
    return () => m.removeEventListener('change', update)
  }, [])
  return on
}

function ruleSummary(r: RoleView): string {
  if (!r.auto) return 'Add a rule'
  if (!r.auto.enabled) return 'Rule off'
  if (r.paused_at) return 'Paused'
  const bits = [`${r.auto.min}–${r.auto.max}`]
  if (r.auto.metrics.length)
    bits.push(r.auto.metrics.map((m) => METRIC_WORDS[m.metric].label).join(', '))
  if (r.auto.schedules.length) bits.push('schedule')
  return bits.join(' · ')
}

function RoleCards({
  d,
  ruleFor,
  saving,
  onPin,
  onRule,
  onSaveRule,
  onClearRule
}: Parameters<typeof RolesTable>[0]) {
  return (
    <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border/60'>
      {d.roles.map((r) => {
        const off = r.running && r.running.running !== r.running.desired
        return (
          <li key={r.role}>
            <div className='space-y-2 px-4 py-3'>
              <div className='flex items-baseline gap-2'>
                <span className='min-w-0 flex-1 text-[13px] font-medium text-slate-900 dark:text-foreground'>
                  {ROLE_WORDS[r.role]}
                </span>
                <span className='text-[12px] tabular-nums text-slate-700 dark:text-foreground'>
                  <span className='text-slate-500 dark:text-muted-foreground'>running </span>
                  <span className={off ? 'text-amber-700 dark:text-amber-300' : undefined}>
                    {r.running ? `${r.running.running} / ${r.running.desired}` : '—'}
                  </span>
                  <span className='text-slate-500 dark:text-muted-foreground'> · kept </span>
                  <span className='font-medium'>{r.replicas}</span>
                </span>
              </div>
              <p className='m-0 text-[12px] tabular-nums text-slate-500 dark:text-muted-foreground'>
                {limitText(r)}
                {r.replicas !== r.template.replicas ? ` · size: ${r.template.replicas}` : ''}
                {!r.scalable
                  ? ` · ${r.role === 'worker' ? 'stays at one' : d.sqlite ? 'SQLite: one process' : 'fixed'}`
                  : ''}
              </p>
              {r.scalable && (
                <div className='flex flex-wrap items-center gap-2'>
                  <button
                    type='button'
                    className={cn(ghostButton, '-ml-2')}
                    aria-expanded={ruleFor === r.role}
                    onClick={() => onRule(r)}
                  >
                    <Zap className='h-3.5 w-3.5' aria-hidden /> {ruleSummary(r)}
                  </button>
                  <span className='ml-auto flex items-center gap-2 text-[12px] text-slate-600 dark:text-muted-foreground'>
                    Pin manual
                    <Switch
                      checked={r.pinned}
                      disabled={saving}
                      onCheckedChange={(v) => onPin(r, v)}
                      aria-label={`Pin ${ROLE_WORDS[r.role]} to manual`}
                    />
                  </span>
                </div>
              )}
            </div>
            {ruleFor === r.role && (
              <RuleEditor
                role={r}
                saving={saving}
                onSave={(rule) => onSaveRule(r, rule)}
                onClear={r.auto ? () => onClearRule(r) : null}
                onCancel={() => onRule(r)}
              />
            )}
          </li>
        )
      })}
    </ul>
  )
}

// ─── change: plan, then start ────────────────────────────────────────────────

interface Draft {
  replicas: string
  cpus: string
  memory_mb: string
}

function ChangePanel({
  d,
  envKey,
  onDone,
  onCancel
}: {
  d: TargetDetail
  envKey: string | null
  onDone: () => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(
      d.roles.map((r) => [
        r.role,
        {
          replicas: String(r.replicas),
          cpus: r.cpus == null ? '' : String(r.cpus),
          memory_mb: r.memory_mb == null ? '' : String(r.memory_mb)
        }
      ])
    )
  )
  const [plan, setPlan] = useState<ScalePlan | null>(null)
  const [confirm, setConfirm] = useState('')
  const changes: RoleChange[] = useMemo(() => {
    const out: RoleChange[] = []
    for (const r of d.roles) {
      const v = draft[r.role]
      const c: RoleChange = { role: r.role }
      const n = Number(v.replicas)
      if (r.scalable && v.replicas !== '' && n !== r.replicas) c.replicas = n
      if (v.cpus !== '' && Number(v.cpus) !== r.cpus) c.cpus = Number(v.cpus)
      if (v.memory_mb !== '' && Number(v.memory_mb) !== r.memory_mb)
        c.memory_mb = Number(v.memory_mb)
      if (Object.keys(c).length > 1) out.push(c)
    }
    return out
  }, [d.roles, draft])

  const planIt = useMutation({
    mutationFn: () => planScale(d.kind, d.id, changes),
    onSuccess: (p) => {
      setPlan(p)
      setConfirm('')
    },
    onError: (err) => hubToast(err, 'Could not plan the change')
  })
  const start = useMutation({
    mutationFn: () =>
      startScale(d.kind, d.id, {
        roles: changes,
        plan_hash: plan?.plan_hash ?? '',
        ...(plan?.confirm ? { confirm } : {})
      }),
    onSuccess: () => {
      toast.success('Scaling started')
      onDone()
    },
    onError: (err) => {
      const fresh = (err as { response?: { data?: { plan?: ScalePlan } } })?.response?.data?.plan
      if (fresh) setPlan(fresh)
      hubToast(err, 'Could not start the change')
    }
  })
  const put = (role: string, patch: Partial<Draft>) => {
    setDraft((x) => ({ ...x, [role]: { ...x[role], ...patch } }))
    setPlan(null)
  }
  const caps = d.now.caps
  const canStart =
    !!plan && plan.blockers.length === 0 && (!plan.confirm || confirm === plan.confirm)

  return (
    <div className='space-y-4 p-4'>
      <div className='text-[12px]'>
        <div
          aria-hidden
          className='hidden gap-x-4 pb-1 text-[11px] font-medium text-slate-500 sm:grid sm:grid-cols-[9rem_6rem_6rem_7rem] dark:text-muted-foreground'
        >
          <span>Role</span>
          <span>Replicas</span>
          <span>CPUs</span>
          <span>Memory (MB)</span>
        </div>
        <ul className='m-0 list-none space-y-3 p-0 sm:space-y-1.5'>
          {d.roles.map((r) => (
            <li
              key={r.role}
              className='grid grid-cols-3 items-end gap-x-3 gap-y-1 sm:grid-cols-[9rem_6rem_6rem_7rem] sm:gap-x-4'
            >
              <span className='col-span-3 font-medium text-slate-900 sm:col-span-1 sm:self-center dark:text-foreground'>
                {ROLE_WORDS[r.role]}
              </span>
              <div className='min-w-0'>
                <span
                  aria-hidden
                  className='block text-[11px] text-slate-500 sm:hidden dark:text-muted-foreground'
                >
                  Replicas
                </span>
                {r.scalable ? (
                  <Input
                    type='number'
                    aria-label={`${ROLE_WORDS[r.role]} replicas`}
                    className='h-8 w-full text-[13px] tabular-nums'
                    min={r.min}
                    max={caps.max_replicas}
                    value={draft[r.role].replicas}
                    onChange={(e) => put(r.role, { replicas: e.target.value })}
                  />
                ) : (
                  <span
                    className='flex h-8 items-center text-[12px] tabular-nums text-slate-500 dark:text-muted-foreground'
                    data-tip={ROLE_HINT[r.role]}
                  >
                    {r.replicas} (fixed)
                  </span>
                )}
              </div>
              <div className='min-w-0'>
                <span
                  aria-hidden
                  className='block text-[11px] text-slate-500 sm:hidden dark:text-muted-foreground'
                >
                  CPUs
                </span>
                <Input
                  type='number'
                  step={0.5}
                  aria-label={`${ROLE_WORDS[r.role]} CPUs`}
                  className='h-8 w-full text-[13px] tabular-nums'
                  min={caps.cpus[0]}
                  max={caps.cpus[1]}
                  value={draft[r.role].cpus}
                  onChange={(e) => put(r.role, { cpus: e.target.value })}
                />
              </div>
              <div className='min-w-0'>
                <span
                  aria-hidden
                  className='block text-[11px] text-slate-500 sm:hidden dark:text-muted-foreground'
                >
                  Memory (MB)
                </span>
                <Input
                  type='number'
                  step={256}
                  aria-label={`${ROLE_WORDS[r.role]} memory in MB`}
                  className='h-8 w-full text-[13px] tabular-nums'
                  min={caps.memory_mb[0]}
                  max={caps.memory_mb[1]}
                  value={draft[r.role].memory_mb}
                  onChange={(e) => put(r.role, { memory_mb: e.target.value })}
                />
              </div>
            </li>
          ))}
        </ul>
      </div>
      <p className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
        At most {caps.max_replicas} replicas a role and {caps.max_total_replicas} a stack; CPUs{' '}
        {caps.cpus[0]}–{caps.cpus[1]}, memory {caps.memory_mb[0]}–{caps.memory_mb[1]} MB. A replica
        change starts or stops processes; a limit change replaces that role’s processes one at a
        time.
      </p>

      {plan && <PlanView plan={plan} />}

      <ProductionGuard envKey={plan?.confirm ? envKey : null} what='change'>
        <div className='flex flex-wrap items-end gap-2'>
          {plan?.confirm && plan.blockers.length === 0 && (
            <div>
              <label
                htmlFor='scale-confirm'
                className='block text-[11px] text-slate-500 dark:text-muted-foreground'
              >
                Type <span className='font-mono'>{plan.confirm}</span> to change it
              </label>
              <Input
                id='scale-confirm'
                className='mt-1 h-8 w-48 font-mono text-[13px]'
                autoComplete='off'
                spellCheck={false}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
          )}
          {!plan ? (
            <button
              type='button'
              className={cn(
                smallButton,
                'bg-nvr-cyan text-white hover:bg-nvr-cyan/90 disabled:opacity-50'
              )}
              disabled={!changes.length || planIt.isPending}
              onClick={() => planIt.mutate()}
            >
              {planIt.isPending ? 'Planning…' : 'Plan the change'}
            </button>
          ) : (
            <button
              type='button'
              className={cn(
                smallButton,
                'bg-nvr-cyan text-white hover:bg-nvr-cyan/90 disabled:opacity-50'
              )}
              disabled={!canStart || start.isPending}
              onClick={() => start.mutate()}
            >
              {start.isPending ? 'Starting…' : 'Start'}
            </button>
          )}
          <button type='button' className={ghostButton} onClick={onCancel}>
            Cancel
          </button>
          {!changes.length && (
            <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
              Change a number to plan.
            </span>
          )}
        </div>
      </ProductionGuard>
    </div>
  )
}

function PlanView({ plan }: { plan: ScalePlan }) {
  return (
    <div className='space-y-3 rounded-lg border border-slate-200 bg-slate-50/60 p-3 dark:border-border dark:bg-muted/30'>
      <p className='m-0 text-[13px] font-medium text-slate-900 dark:text-foreground'>
        {changeText(plan.from, plan.to) || 'Nothing changes'}
        {plan.steps.length > 1 && (
          <span className='font-normal text-slate-500 dark:text-muted-foreground'>
            {' '}
            · {plan.steps.length} steps
          </span>
        )}
      </p>
      {plan.blockers.length > 0 && <Notice tone='bad' title='Cannot start' items={plan.blockers} />}
      {plan.warnings.length > 0 && (
        <Notice tone='quiet' title='Good to know' items={plan.warnings} />
      )}
      <PlanBeforeAfter cost={plan.cost} />
      <ConnectionsTable c={plan.connections} />
    </div>
  )
}

function ConnectionsCard({ c, title }: { c: ConnMath; title: string }) {
  return (
    <SectionCard
      title={title}
      description={
        c.kind === 'shared'
          ? 'Every process opens a pool per app; the budget caps one process.'
          : 'Every process opens its main and background pools.'
      }
    >
      <div className='p-4'>
        <ConnectionsTable c={c} />
      </div>
    </SectionCard>
  )
}

function ConnectionsTable({ c }: { c: ConnMath }) {
  const changes = c.total.from !== c.total.to
  const arrow = (a: number, b: number) => (a === b ? String(a) : `${a} → ${b}`)
  return (
    <div className='space-y-2'>
      <div className='grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 min-[420px]:grid-cols-3 dark:border-border dark:bg-border'>
        <Cell label='Processes' value={arrow(c.processes.from, c.processes.to)} />
        <Cell
          label={c.kind === 'shared' ? 'Per process (apps’ pools)' : 'Per process'}
          value={
            c.kind === 'shared' && c.budget
              ? `${c.per_process} of ${c.budget.per_process}`
              : c.pools
                ? `${c.per_process} (${c.pools.main} + ${c.pools.background} + ${c.pools.probe} probe)`
                : String(c.per_process)
          }
          tip={
            c.kind === 'shared'
              ? 'Connections one process opens across its apps, of the deployment’s pool budget'
              : 'Main pool + background pool (DB_POOL_MAX + DB_POOL_BACKGROUND_MAX)'
          }
        />
        <Cell label='This stack in all' value={arrow(c.total.from, c.total.to)} strong={changes} />
      </div>
      {c.servers.length > 0 && (
        <ul className='m-0 list-none space-y-1.5 p-0'>
          {c.servers.map((s) => (
            <li key={s.id} className='text-[12px]'>
              <ServerBar s={s} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Cell({
  label,
  value,
  tip,
  strong
}: {
  label: string
  value: string
  tip?: string
  strong?: boolean
}) {
  return (
    <div className='min-w-0 bg-white px-3 py-2 dark:bg-card' data-tip={tip}>
      <p className='m-0 truncate text-[11px] text-slate-500 dark:text-muted-foreground'>{label}</p>
      <p
        className={cn(
          'm-0 truncate text-[14px] tabular-nums text-slate-900 dark:text-foreground',
          strong ? 'font-semibold' : 'font-medium'
        )}
      >
        {value}
      </p>
    </div>
  )
}

function ServerBar({ s }: { s: ServerMathLike }) {
  const max = s.max_connections
  const share = (n: number) => (max ? Math.min(100, (n / max) * 100) : 0)
  const over = max != null && s.after > max
  return (
    <div>
      <p className='m-0 flex flex-wrap items-baseline gap-x-2 text-slate-700 dark:text-foreground'>
        <span className='font-medium'>{s.name}</span>
        <span className='tabular-nums text-slate-500 dark:text-muted-foreground'>
          {max == null
            ? `${s.after} connections · no limit on record`
            : `${s.after} of ${max} (${s.others} other stacks, ${s.to} this one)`}
        </span>
      </p>
      {max != null && (
        <div
          className='mt-1 flex h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-muted'
          role='img'
          aria-label={`${s.after} of ${max} connections`}
        >
          <span
            className='bg-slate-400 dark:bg-slate-500'
            style={{ width: `${share(s.others)}%` }}
          />
          <span
            className={over ? 'bg-red-500' : 'bg-nvr-cyan'}
            style={{ width: `${Math.max(0, share(s.after) - share(s.others))}%` }}
          />
        </div>
      )}
    </div>
  )
}

type ServerMathLike = ConnMath['servers'][number]

// ─── runs ────────────────────────────────────────────────────────────────────

const RUN_TONE: Record<RunStatus, Tone> = {
  running: 'busy',
  success: 'ok',
  failed: 'bad',
  cancelled: 'quiet',
  skipped: 'warn',
  interrupted: 'warn'
}

function OpenRun({ run, onCancelled }: { run: ScaleRun; onCancelled: () => void }) {
  const cancel = useMutation({
    mutationFn: () => cancelScaleRun(run.id),
    onSuccess: () => {
      toast.success('It stops before its next step')
      onCancelled()
    },
    onError: (err) => hubToast(err, 'Could not cancel')
  })
  const steps: RunStep[] = run.steps.map((s, i) => ({
    key: String(i),
    label: run.steps.length > 1 ? `Step ${i + 1}` : changeText(run.from, run.to) || 'Change',
    state:
      s.status === 'done'
        ? 'done'
        : s.status === 'applying'
          ? 'running'
          : s.status === 'failed'
            ? 'failed'
            : 'pending'
  }))
  return (
    <SectionCard
      title='Scaling now'
      description={run.reason ?? undefined}
      actions={
        run.steps.length > 1 ? (
          <button
            type='button'
            className={ghostButton}
            disabled={cancel.isPending || run.error_code === 'CANCEL_REQUESTED'}
            onClick={() => cancel.mutate()}
          >
            {run.error_code === 'CANCEL_REQUESTED'
              ? 'Stopping after this step…'
              : 'Stop after this step'}
          </button>
        ) : null
      }
    >
      <div className='space-y-2 p-4'>
        <HubRunTimeline steps={steps} live what='Scale' />
        <ol className='m-0 list-decimal space-y-0.5 pl-5 text-[12px] text-slate-700 dark:text-foreground'>
          {run.steps.map((s, i) => (
            <li key={`${s.status}-${s.to.map((r) => r.replicas).join('.')}`}>
              {changeText(i === 0 ? run.from : run.steps[i - 1].to, s.to) || 'No change'} —{' '}
              <span className='text-slate-500 dark:text-muted-foreground'>
                {s.status === 'done' ? 'done' : s.status === 'applying' ? 'settling…' : 'waiting'}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </SectionCard>
  )
}

function RunsCard({ runs }: { runs: ScaleRun[] }) {
  return (
    <SectionCard
      title='Recent changes'
      description='Every change with its reason and figure, and the automatic changes that could not run.'
    >
      {runs.length === 0 ? (
        <p className='m-0 px-4 py-5 text-[12px] text-slate-500 dark:text-muted-foreground'>
          No changes yet.
        </p>
      ) : (
        <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border/60'>
          {runs.map((r) => (
            <li key={r.id} className='px-4 py-2.5'>
              <p className='m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]'>
                <Chip tone={RUN_TONE[r.status]}>{RUN_STATUS_WORDS[r.status]}</Chip>
                <span className='font-medium text-slate-800 dark:text-foreground'>
                  {SOURCE_WORDS[r.source]}
                </span>
                {r.status !== 'skipped' && r.to.length > 0 && (
                  <span className='tabular-nums text-slate-700 dark:text-foreground'>
                    {changeText(r.from, r.to)}
                  </span>
                )}
                <span
                  className='ml-auto text-[11px] text-slate-500 dark:text-muted-foreground'
                  data-tip={r.created_at ? formatDateTime(r.created_at) : undefined}
                >
                  {r.created_at ? formatRelative(r.created_at) : ''}
                </span>
              </p>
              {r.reason && (
                <p className='m-0 mt-1 text-[12px] text-slate-600 dark:text-muted-foreground'>
                  {r.reason}
                </p>
              )}
              {r.error && r.status !== 'skipped' && (
                <p className='m-0 mt-1 text-[12px] text-red-700 dark:text-red-300'>{r.error}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  )
}

// ─── database server limits ──────────────────────────────────────────────────

function DbServersCard() {
  const qc = useQueryClient()
  const servers = useQuery({ queryKey: scaleKeys.servers(), queryFn: fetchDbServers })
  const [draft, setDraft] = useState<Record<number, string>>({})
  const save = useMutation({
    mutationFn: (v: { id: number; max: number | null }) => saveDbServerLimit(v.id, v.max),
    onSuccess: () => {
      toast.success('Limit saved')
      setDraft({})
      void qc.invalidateQueries({ queryKey: scaleKeys.all })
    },
    onError: (err) => hubToast(err, 'Could not save the limit')
  })
  if (servers.isPending) return <Skeleton className='h-24 w-full' />
  if (servers.isError)
    return (
      <QueryErrorState
        error={servers.error}
        what='the database servers'
        onRetry={() => void servers.refetch()}
      />
    )
  if (!servers.data.length) return null
  return (
    <div id='scale-db-limits' className='scroll-mt-4'>
      <SectionCard
        title='Database server limits'
        description='Each server’s max connections, checked by scaling. A change past it is refused; without one autoscaling adds no processes and a change by hand asks for the key.'
      >
        <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border/60'>
          {servers.data.map((s) => {
            const value =
              draft[s.id] ?? (s.max_connections == null ? '' : String(s.max_connections))
            const dirty = draft[s.id] !== undefined
            const n = value === '' ? null : Number(value)
            const bad = n !== null && !(Number.isInteger(n) && n >= 1 && n <= 1_000_000)
            return (
              <li key={s.id} className='flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5'>
                <span className='min-w-0 flex-1'>
                  <span className='block text-[13px] font-medium text-slate-900 dark:text-foreground'>
                    {s.name}
                  </span>
                  <span className='block truncate text-[11px] text-slate-500 dark:text-muted-foreground'>
                    {s.engine} · {s.host}
                  </span>
                </span>
                <Input
                  type='number'
                  aria-label={`${s.name} max connections`}
                  placeholder='Not set'
                  className='h-8 w-28 text-[13px] tabular-nums'
                  value={value}
                  min={1}
                  onChange={(e) => setDraft((x) => ({ ...x, [s.id]: e.target.value }))}
                />
                <button
                  type='button'
                  className={ghostButton}
                  disabled={!dirty || bad || save.isPending}
                  onClick={() => save.mutate({ id: s.id, max: n })}
                >
                  Save
                </button>
              </li>
            )
          })}
        </ul>
      </SectionCard>
    </div>
  )
}
