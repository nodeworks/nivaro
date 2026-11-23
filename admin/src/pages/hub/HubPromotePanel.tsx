import {
  ConfirmButton,
  type ErrorDescription,
  ErrorDetails,
  ErrorNotice,
  isRawErrorText
} from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Ban, Check, Circle, Eye, Loader2, RotateCcw, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { cn, formatDateTime, formatRelative } from '@/lib/utils'
import {
  blockerCopy,
  blockerDetailLine,
  blockersOf,
  cancelPromotion,
  changedPlanOf,
  deployKindWords,
  fetchPromotableReleases,
  fetchPromotion,
  fetchPromotionPlan,
  fetchPromotions,
  type HubEnvironment,
  type HubPromotion,
  hubError,
  hubKeys,
  hubToast,
  isLivePromotion,
  isPromotionKind,
  type PromotionBlocker,
  type PromotionKind,
  type PromotionPlan,
  promotionPlanOf,
  promotionStatusTone,
  promotionStatusWords,
  RELEASES_ERROR_TEXT,
  startPromotion
} from './hub-api'
import { dangerArmed, dangerGhost, ghostButton, SectionCard } from './hub-parts'

/**
 * Promote and roll back (Hub phase 2): pick a version, read the plan in plain words, type the
 * environment's name, start; then watch each step until the new version answers. The server
 * re-checks every blocker at start, so the confirmation here is for the person, not the gate.
 */

const KIND_VERB: Record<PromotionKind, string> = { promote: 'promote', rollback: 'roll back' }
const KIND_TITLE: Record<PromotionKind, string> = { promote: 'Promote', rollback: 'Roll back' }

export function HubPromotePanel({
  env,
  kind,
  initialVersion,
  deployId: watchId,
  canCancel = true,
  idPrefix,
  onClose
}: {
  env: HubEnvironment
  kind: PromotionKind
  /** The version to start on (a history row's Roll back). */
  initialVersion?: string
  /** Open straight on this promotion's progress (Watch on a running history row). */
  deployId?: number
  canCancel?: boolean
  /** Unique per layout (the table and the phone list can both hold a panel). */
  idPrefix: string
  onClose: () => void
}) {
  const [deployId, setDeployId] = useState<number | null>(watchId ?? null)
  const title = `${KIND_TITLE[kind]} ${env.key}`

  return (
    <section
      aria-label={title}
      className='min-w-0 space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:p-4 dark:border-border dark:bg-muted/40'
    >
      <div className='flex items-center gap-2'>
        <h4 className='m-0 min-w-0 flex-1 truncate text-[13px] font-semibold text-slate-900 dark:text-foreground'>
          {KIND_TITLE[kind]} <span className='font-mono'>{env.key}</span>
        </h4>
        <button type='button' aria-label='Close' className={ghostButton} onClick={onClose}>
          <X className='h-3.5 w-3.5' aria-hidden />
        </button>
      </div>
      {deployId != null ? (
        <PromotionProgress
          envId={env.id}
          deployId={deployId}
          canCancel={canCancel}
          onClose={onClose}
        />
      ) : (
        <PromoteForm
          env={env}
          kind={kind}
          initialVersion={initialVersion}
          idPrefix={idPrefix}
          onStarted={setDeployId}
          onClose={onClose}
        />
      )}
    </section>
  )
}

// ─── Before start: version, plan, confirmation ────────────────────────────────

function PromoteForm({
  env,
  kind,
  initialVersion,
  idPrefix,
  onStarted,
  onClose
}: {
  env: HubEnvironment
  kind: PromotionKind
  initialVersion?: string
  idPrefix: string
  onStarted: (deployId: number) => void
  onClose: () => void
}) {
  const qc = useQueryClient()
  const promotable = useQuery({
    queryKey: hubKeys.promotable(env.id),
    queryFn: () => fetchPromotableReleases(env.id),
    staleTime: 15_000
  })
  const choices = useMemo(() => {
    const listed = promotable.data?.[kind] ?? []
    return initialVersion && !listed.includes(initialVersion) ? [initialVersion, ...listed] : listed
  }, [promotable.data, kind, initialVersion])

  const [picked, setPicked] = useState<string>(initialVersion ?? '')
  // Pinned on first load: a refetch that lists a newer version never swaps it under a
  // typed confirmation.
  useEffect(() => {
    if (!picked && choices[0]) setPicked(choices[0])
  }, [picked, choices])
  // A switch between promote and roll back starts the pick again.
  const shownKind = useRef(kind)
  useEffect(() => {
    if (shownKind.current === kind) return
    shownKind.current = kind
    setPicked(initialVersion ?? '')
  }, [kind, initialVersion])
  const version = picked || choices[0] || ''
  const [confirm, setConfirm] = useState('')
  /** A start refused with PLAN_CHANGED: the new plan is shown and must be checked again. */
  const [changed, setChanged] = useState(false)
  // The confirmation names one version and one kind: either changing clears it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: clearing is the point
  useEffect(() => {
    setConfirm('')
    setChanged(false)
  }, [kind, version])
  /** Blockers a refused start sent back, and when: a later fresh plan replaces them. */
  const [refused, setRefused] = useState<{ at: number; blockers: PromotionBlocker[] } | null>(null)

  const plan = useQuery({
    queryKey: hubKeys.plan(env.id, kind, version),
    queryFn: () => fetchPromotionPlan(env.id, kind, version),
    enabled: !!version,
    staleTime: 0
  })
  // The confirmation names one plan: a re-read that plans differently clears it.
  const shownHash = useRef<string | undefined>(undefined)
  const planHash = plan.data?.plan_hash
  useEffect(() => {
    if (shownHash.current && planHash && planHash !== shownHash.current) setConfirm('')
    if (planHash) shownHash.current = planHash
  }, [planHash])

  const start = useMutation({
    mutationFn: () =>
      startPromotion(env.id, {
        version,
        kind,
        confirm: confirm.trim(),
        // The plan on screen: the Hub starts only if it would still do exactly this.
        plan_hash: plan.data?.plan_hash ?? ''
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: hubKeys.promotions(env.id) })
      onStarted(r.deploy_id)
    },
    onError: (err) => {
      const now = changedPlanOf(err)
      if (now) {
        qc.setQueryData(hubKeys.plan(env.id, kind, version), now)
        setChanged(true)
        setConfirm('')
        return
      }
      const blockers = blockersOf(err)
      if (blockers.length > 0) {
        setRefused({ at: Date.now(), blockers })
        void qc.invalidateQueries({ queryKey: hubKeys.plan(env.id, kind, version) })
      } else hubToast(err, `Could not ${KIND_VERB[kind]} ${env.key}`)
    }
  })

  // The plan read again after a refusal re-checks everything the server judged.
  useEffect(() => {
    if (refused && plan.dataUpdatedAt > refused.at) setRefused(null)
  }, [refused, plan.dataUpdatedAt])

  const verb = KIND_VERB[kind]
  const blockers = refused ? refused.blockers : (plan.data?.blockers ?? [])
  const ready =
    !!plan.data?.ok &&
    !!plan.data.plan_hash &&
    !refused &&
    confirm.trim() === env.key &&
    !start.isPending

  if (promotable.isPending) return <Skeleton className='h-24 w-full' />
  if (promotable.isError)
    return (
      <ErrorNotice
        description={hubError(promotable.error, 'Could not load the versions')}
        onRetry={() => void promotable.refetch()}
      />
    )
  const releasesNote =
    kind === 'promote' && promotable.data.releases_error ? (
      <p role='status' className='m-0 text-[12px] text-amber-800 dark:text-amber-300'>
        {RELEASES_ERROR_TEXT}
      </p>
    ) : null
  if (choices.length === 0)
    return (
      <div className='space-y-1.5'>
        {releasesNote}
        <p className='m-0 text-[12px] text-slate-600 dark:text-slate-300'>
          {kind === 'rollback'
            ? 'Nothing to roll back to: this environment has no earlier successful deploy.'
            : promotable.data?.previous === null
              ? 'Nothing to promote: this is the first environment, so new versions reach it through its own pipeline.'
              : 'Nothing to promote: the environment before this one runs no newer version.'}
        </p>
      </div>
    )

  return (
    <div className='space-y-3'>
      {releasesNote}
      <div className='max-w-[280px] space-y-1.5'>
        <label
          htmlFor={`${idPrefix}-version`}
          className='block text-[12px] font-medium text-slate-700 dark:text-foreground'
        >
          Version
        </label>
        <SimpleSelect
          value={version}
          onChange={(v) => {
            setPicked(v)
            setRefused(null)
          }}
          options={choices.map((v) => ({
            value: v,
            label:
              kind === 'promote' && v === promotable.data?.finish
                ? `${v} — finish the stopped promotion`
                : v
          }))}
          ariaLabel='Version'
          className='h-8 bg-white text-left font-mono text-[13px] dark:bg-background'
          triggerProps={{ id: `${idPrefix}-version` }}
        />
        {kind === 'promote' && version && version === promotable.data?.finish && (
          <p className='m-0 text-[12px] text-slate-600 dark:text-slate-300'>
            {env.key} already runs {version}, but its Hub promotion stopped before every part was
            deployed. Promoting it again deploys only what is missing.
          </p>
        )}
      </div>

      {changed && (
        <p
          role='status'
          className='m-0 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] font-medium text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200'
        >
          The plan changed — check it again. This is the plan as it stands now; type{' '}
          <code className='font-mono font-semibold'>{env.key}</code> again to start it.
        </p>
      )}
      {plan.data ? (
        <PlanPreview plan={plan.data} blockers={blockers} />
      ) : plan.isPending ? (
        <Skeleton className='h-16 w-full' />
      ) : (
        <ErrorNotice
          description={hubError(plan.error, 'Could not check this version')}
          onRetry={() => void plan.refetch()}
        />
      )}

      <div className='space-y-1.5'>
        <label
          htmlFor={`${idPrefix}-confirm`}
          className='block text-[12px] font-medium text-slate-700 dark:text-foreground'
        >
          Type <code className='font-mono font-semibold'>{env.key}</code> to {verb}
        </label>
        <Input
          id={`${idPrefix}-confirm`}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete='off'
          spellCheck={false}
          placeholder='Type it here'
          className='h-8 max-w-[280px] bg-white font-mono text-[13px] dark:bg-background'
        />
      </div>

      <div className='flex flex-wrap items-center gap-2'>
        <Button
          size='sm'
          className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
          disabled={!ready}
          onClick={() => start.mutate()}
        >
          {start.isPending ? 'Starting…' : `Start ${kind === 'promote' ? 'promotion' : 'rollback'}`}
        </Button>
        <Button size='sm' variant='ghost' className='h-8' onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function PlanPreview({ plan, blockers }: { plan: PromotionPlan; blockers: PromotionBlocker[] }) {
  return (
    <div className='space-y-2'>
      {plan.lines.length > 0 && (
        <ul className='m-0 list-none space-y-1 p-0 text-[12px] text-slate-700 dark:text-slate-300'>
          {plan.lines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines are plain text and may repeat
            <li key={i} className='flex gap-2'>
              <ArrowRight className='mt-0.5 h-3 w-3 shrink-0 text-slate-400' aria-hidden />
              <span className='min-w-0 break-words'>{line}</span>
            </li>
          ))}
        </ul>
      )}
      {blockers.length > 0 && (
        <div
          role='alert'
          className='rounded-md border border-red-200 bg-red-50 px-3 py-2 dark:border-red-900/60 dark:bg-red-950/40'
        >
          <p className='m-0 text-[12px] font-semibold text-red-800 dark:text-red-200'>
            This cannot start yet
          </p>
          <ul className='m-0 mt-1 list-none space-y-1.5 p-0'>
            {blockers.map((b, i) => {
              const copy = blockerCopy(b)
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: the planner may repeat a code
                <li key={i} className='text-[12px]'>
                  <span className='block font-medium text-red-800 dark:text-red-200'>
                    {copy.title}
                  </span>
                  {copy.hint && (
                    <span className='block text-red-700/90 dark:text-red-300/90'>{copy.hint}</span>
                  )}
                  {blockerDetailLine(b, copy.title) && (
                    <span className='mt-0.5 block break-words text-[11px] text-slate-600 dark:text-slate-400'>
                      {blockerDetailLine(b, copy.title)}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

// ─── After start: steps, log, cancel ──────────────────────────────────────────

type StepState = 'done' | 'running' | 'failed' | 'stopped' | 'pending'
type Phase = 'push' | 'deploy' | 'verify'

interface StepRow {
  key: string
  phase: Phase
  component: string | null
  label: string
}

/**
 * The order the runner takes a plan's steps in (api promote-plan.ts runOrder): a promotion by
 * position, a rollback every frontend first, then the API.
 */
const runRank = (kind: PromotionKind, s: { kind: string }) =>
  kind === 'rollback' && s.kind === 'frontend' ? 0 : 1

/** The runner's steps for a plan: per component merge then deploy, then one check at the end. */
export function stepRows(plan: PromotionPlan | null, kind: PromotionKind = 'promote'): StepRow[] {
  const rows: StepRow[] = []
  const ordered = [...(plan?.steps ?? [])].sort(
    (a, b) => runRank(kind, a) - runRank(kind, b) || a.position - b.position
  )
  for (const s of ordered) {
    if (s.driver === 'docker' || s.kind === 'stack') {
      // A stack deploys through the Hub agent: one step, no merge or pin row.
      rows.push({
        key: `deploy-${s.position}`,
        phase: 'deploy',
        component: s.component,
        label: `${kind === 'rollback' ? 'Redeploy' : 'Deploy'} stack ${s.stack?.name ?? s.component}`
      })
      continue
    }
    // What the run really does for this step: a rollback reruns an earlier build (nothing is
    // merged or pinned); a no-op API step finds the version already running.
    const [push, deploy] =
      kind === 'rollback'
        ? [
            `Find ${s.component}'s earlier build on ${s.targetBranch}`,
            `Redeploy ${s.component}'s earlier build`
          ]
        : s.noop
          ? [
              `${s.component}: ${s.targetBranch} already holds this release and its pin`,
              `Already running ${s.want} — ${s.component} is not deployed again`
            ]
          : [
              s.kind === 'api'
                ? `Merge ${s.component} into ${s.targetBranch} and pin the version`
                : `Merge ${s.component} into ${s.targetBranch}`,
              `Deploy ${s.component}`
            ]
    rows.push({ key: `push-${s.position}`, phase: 'push', component: s.component, label: push })
    rows.push({
      key: `deploy-${s.position}`,
      phase: 'deploy',
      component: s.component,
      label: deploy
    })
  }
  rows.push({
    key: 'verify',
    phase: 'verify',
    component: null,
    label: 'Check the new version answers'
  })
  return rows
}

const PHASE_WORDS: [Phase, RegExp][] = [
  ['verify', /\b(verify|check)/],
  ['deploy', /\b(deploy|job|pipeline)/],
  ['push', /\b(push|merge|pin|branch)/]
]

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Which row the runner's `step` text names ("push api", "deploy frontend", "verify"): the phase
 * word that comes first, then the component named in it. -1 when it names none.
 */
export function currentStepIndex(rows: StepRow[], step: string | null): number {
  if (!step) return -1
  const text = step.toLowerCase()
  let phase: Phase | null = null
  let at = Number.POSITIVE_INFINITY
  for (const [p, re] of PHASE_WORDS) {
    const m = re.exec(text)
    if (m && m.index < at) {
      at = m.index
      phase = p
    }
  }
  if (!phase) return -1
  if (phase === 'verify') return rows.length - 1
  // The component as a whole token: `api` never matches `api-v2`.
  const named = rows.findIndex(
    (r) =>
      r.phase === phase &&
      r.component &&
      new RegExp(`(?:^|[\\s:,])${escapeRe(r.component.toLowerCase())}(?=$|[\\s:,])`).test(text)
  )
  return named >= 0 ? named : rows.findIndex((r) => r.phase === phase)
}

function stepStates(rows: StepRow[], status: string, step: string | null): StepState[] {
  if (status === 'success') return rows.map(() => 'done')
  const cur = currentStepIndex(rows, step)
  const atCur: StepState = isLivePromotion(status)
    ? 'running'
    : status === 'cancelled'
      ? 'stopped'
      : 'failed'
  const at = cur < 0 && isLivePromotion(status) ? 0 : cur
  return rows.map((_, i) => (i < at ? 'done' : i === at ? atCur : 'pending'))
}

const STEP_WORDS: Record<StepState, string> = {
  done: 'done',
  running: 'in progress',
  failed: 'failed',
  stopped: 'stopped here',
  pending: 'not started'
}

function StepIcon({ state }: { state: StepState }) {
  if (state === 'done')
    return <Check className='h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400' aria-hidden />
  if (state === 'running')
    return (
      <Loader2 className='h-3.5 w-3.5 animate-spin text-sky-600 dark:text-sky-400' aria-hidden />
    )
  if (state === 'failed')
    return <X className='h-3.5 w-3.5 text-red-600 dark:text-red-400' aria-hidden />
  if (state === 'stopped')
    return <Ban className='h-3.5 w-3.5 text-slate-500 dark:text-muted-foreground' aria-hidden />
  return <Circle className='h-3 w-3 text-slate-300 dark:text-slate-600' aria-hidden />
}

const MAX_READ_FAILURES = 3

function PromotionProgress({
  envId,
  deployId,
  canCancel,
  onClose
}: {
  envId: number
  deployId: number
  canCancel: boolean
  onClose: () => void
}) {
  const qc = useQueryClient()
  /** Reads that failed in a row: polling stops after MAX_READ_FAILURES. */
  const failures = useRef(0)
  const q = useQuery({
    queryKey: hubKeys.promotion(deployId),
    queryFn: async () => {
      try {
        const d = await fetchPromotion(deployId)
        failures.current = 0
        return d
      } catch (err) {
        failures.current += 1
        throw err
      }
    },
    // Live while it runs; one read once it has finished. A read that keeps failing (an id the
    // Hub does not know, the Hub gone) stops asking.
    refetchInterval: (query) => {
      if (query.state.status === 'error' && !query.state.data) return false
      if (failures.current >= MAX_READ_FAILURES) return false
      const s = query.state.data?.status
      return !s || isLivePromotion(s) ? 3000 : false
    }
  })
  const noun = q.data?.kind === 'rollback' ? 'rollback' : 'promotion'
  const cancel = useMutation({
    mutationFn: () => cancelPromotion(deployId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: hubKeys.promotion(deployId) }),
    onError: (err) => hubToast(err, `Could not cancel the ${noun}`)
  })

  // When it finishes, what the environment runs and its history have changed.
  const status = q.data?.status
  const wasLive = useRef<boolean | null>(null)
  useEffect(() => {
    if (!status) return
    const live = isLivePromotion(status)
    if (wasLive.current === true && !live) {
      void qc.invalidateQueries({ queryKey: hubKeys.envStatus(envId) })
      void qc.invalidateQueries({ queryKey: hubKeys.promotions(envId) })
      void qc.invalidateQueries({ queryKey: hubKeys.promotable(envId) })
      void qc.invalidateQueries({ queryKey: hubKeys.deploys(envId) })
    }
    wasLive.current = live
  }, [status, envId, qc])

  if (q.isPending) return <Skeleton className='h-24 w-full' />
  // A failed re-read keeps showing the last progress (with a note below); only a first read
  // that failed has nothing to show.
  if (!q.data)
    return (
      <ErrorNotice
        description={hubError(q.error, 'Could not read the promotion')}
        onRetry={() => {
          failures.current = 0
          void q.refetch()
        }}
      />
    )

  const d = q.data
  const rows = stepRows(promotionPlanOf(d), d.kind === 'rollback' ? 'rollback' : 'promote')
  const states = stepStates(rows, d.status, d.step)
  const live = isLivePromotion(d.status)

  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]'>
        <span className='font-mono text-slate-700 dark:text-slate-300'>
          {d.from_version ?? '—'}
          <ArrowRight className='mx-1 inline h-3 w-3 align-[-2px] text-slate-400' aria-hidden />
          <span className='font-semibold text-slate-900 dark:text-foreground'>{d.version}</span>
        </span>
        <span role='status' className={cn('font-medium', promotionStatusTone(d.status))}>
          {promotionStatusWords(d.status)}
        </span>
        <span
          className='text-slate-500 dark:text-muted-foreground'
          data-tip={formatDateTime(d.started_at)}
        >
          started {formatRelative(d.started_at)}
        </span>
      </div>

      <ol aria-label='Promotion steps' className='m-0 list-none space-y-1.5 p-0'>
        {rows.map((r, i) => (
          <li
            key={r.key}
            data-state={states[i]}
            className={cn(
              'flex min-w-0 items-start gap-2 text-[12px]',
              states[i] === 'pending'
                ? 'text-slate-500 dark:text-muted-foreground'
                : 'text-slate-800 dark:text-foreground',
              states[i] === 'failed' && 'font-medium text-red-700 dark:text-red-300'
            )}
          >
            <span className='mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center'>
              <StepIcon state={states[i]} />
            </span>
            <span className='min-w-0 break-words'>
              {r.label}
              <span className='sr-only'> — {STEP_WORDS[states[i]]}</span>
            </span>
          </li>
        ))}
      </ol>

      {q.isError && (
        <p className='m-0 flex flex-wrap items-center gap-2 text-[12px] text-amber-800 dark:text-amber-300'>
          Could not read the latest progress.
          <button
            type='button'
            className={ghostButton}
            onClick={() => {
              failures.current = 0
              void q.refetch()
            }}
          >
            Check again
          </button>
        </p>
      )}
      {d.error && (
        <div className='rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200'>
          <RunnerError text={d.error} />
        </div>
      )}
      {d.status === 'interrupted' && !d.error && (
        <p className='m-0 text-[12px] text-amber-800 dark:text-amber-300'>
          The Hub restarted while this ran. Check the environment, then start again.
        </p>
      )}

      <details className='group rounded-md border border-slate-200 bg-white dark:border-border dark:bg-card'>
        <summary className='cursor-pointer select-none px-3 py-1.5 text-[12px] font-medium text-slate-600 dark:text-slate-300'>
          Details
        </summary>
        {d.log.length === 0 ? (
          <p className='m-0 px-3 pb-2 text-[11px] text-slate-500 dark:text-muted-foreground'>
            Nothing logged yet.
          </p>
        ) : (
          <ol className='m-0 max-h-64 list-none space-y-0.5 overflow-y-auto px-3 pb-2 font-mono text-[11px] leading-snug'>
            {d.log.map((l) => (
              <li
                key={l.seq}
                className={cn(
                  'break-all',
                  l.level === 'error'
                    ? 'text-red-700 dark:text-red-300'
                    : l.level === 'warn'
                      ? 'text-amber-800 dark:text-amber-300'
                      : 'text-slate-600 dark:text-slate-300'
                )}
              >
                <span className='text-slate-500 dark:text-slate-400'>
                  {new Date(l.at).toLocaleTimeString()}{' '}
                </span>
                {l.line}
              </li>
            ))}
          </ol>
        )}
      </details>

      <div className='flex flex-wrap items-center gap-2'>
        {live && canCancel ? (
          <>
            <ConfirmButton
              title={`Cancel ${noun}`}
              confirmLabel='Stop after this step?'
              className={dangerGhost}
              armedClassName={dangerArmed}
              disabled={cancel.isPending}
              onConfirm={() => cancel.mutate()}
            >
              <Ban className='h-3.5 w-3.5' aria-hidden /> Cancel
            </ConfirmButton>
            <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
              {rows.some((r) => r.phase === 'push')
                ? 'Stops at the next safe point; a merge is never left without its pin.'
                : 'Stops at the next safe point; a stack Docker already has is left to settle first.'}
            </span>
          </>
        ) : !live ? (
          <Button size='sm' variant='ghost' className='h-8' onClick={onClose}>
            Close
          </Button>
        ) : null}
      </div>
    </div>
  )
}

// ─── History: what the Hub promoted and rolled back ───────────────────────────

/** One environment's Hub deploys, newest first: a table from sm, stacked entries on a phone. */
export function PromotionHistory({
  env,
  canPromote,
  onRollback,
  onWatch
}: {
  env: HubEnvironment
  canPromote: boolean
  onRollback: (version: string) => void
  onWatch: (deployId: number, kind: PromotionKind) => void
}) {
  const q = useQuery({
    queryKey: hubKeys.promotions(env.id),
    queryFn: () => fetchPromotions(env.id),
    staleTime: 15_000,
    refetchInterval: (query) =>
      query.state.data?.some((r) => isLivePromotion(r.status)) ? 5000 : false
  })
  const promotable = useQuery({
    queryKey: hubKeys.promotable(env.id),
    queryFn: () => fetchPromotableReleases(env.id),
    staleTime: 15_000,
    enabled: canPromote
  })
  const rollbackTo = new Set(promotable.data?.rollback ?? [])
  // One Roll back per version: on its newest successful deploy.
  const offered = new Set<number>()
  const seen = new Set<string>()
  for (const r of q.data ?? []) {
    // Phase 6: a move or shared-upgrade row never offers a rollback of its own.
    if (!isPromotionKind(r.kind)) continue
    if (r.status !== 'success' || seen.has(r.version)) continue
    seen.add(r.version)
    if (rollbackTo.has(r.version)) offered.add(r.id)
  }

  if (q.isPending) return <Skeleton className='h-14 w-full' />
  if (q.isError)
    return (
      <ErrorNotice
        description={hubError(q.error, 'Could not load the Hub deploys')}
        onRetry={() => void q.refetch()}
      />
    )
  if (q.data.length === 0)
    return (
      <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
        The Hub has not promoted or rolled back this environment yet.
      </p>
    )

  const label = `${env.key} Hub deploys`
  const actions = (r: HubPromotion) => (
    <RowActions
      row={r}
      canPromote={canPromote}
      rollback={offered.has(r.id)}
      onRollback={onRollback}
      onWatch={onWatch}
    />
  )

  return (
    <>
      <ul
        aria-label={label}
        className='m-0 list-none divide-y divide-slate-100 p-0 sm:hidden dark:divide-border'
      >
        {q.data.map((r) => (
          <li key={r.id} className='min-w-0 py-2'>
            <div className='flex items-center gap-2'>
              <span className='font-mono text-[12px] font-medium text-slate-900 dark:text-foreground'>
                {r.version}
              </span>
              {r.from_version && r.from_version !== r.version && (
                <span className='font-mono text-[11px] text-slate-500 dark:text-slate-400'>
                  from {r.from_version}
                </span>
              )}
              <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                {deployKindWords(r)}
              </span>
              <span className={cn('text-[12px] font-medium', promotionStatusTone(r.status))}>
                {promotionStatusWords(r.status)}
              </span>
              <div className='ml-auto'>{actions(r)}</div>
            </div>
            <p className='m-0 mt-0.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
              {[whoOf(r), formatRelative(r.started_at), r.step].filter(Boolean).join(' · ')}
            </p>
            {r.error && (
              <div className='mt-0.5 text-[11px] text-red-700 dark:text-red-300'>
                <RunnerError text={r.error} />
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className='hidden overflow-x-auto sm:block'>
        <table aria-label={label} className='w-full min-w-[720px] text-[12px]'>
          <thead>
            <tr className='border-b border-slate-200 text-left text-[11px] uppercase tracking-wide text-slate-500 dark:border-border dark:text-muted-foreground'>
              <th className='py-2 pr-4 font-medium'>Version</th>
              <th className='py-2 pr-4 font-medium'>Kind</th>
              <th className='py-2 pr-4 font-medium'>Status</th>
              <th className='py-2 pr-4 font-medium'>Who</th>
              <th className='py-2 pr-4 font-medium'>When</th>
              <th className='py-2 pr-4 font-medium'>Step</th>
              <th className='py-2 pr-4 font-medium'>Error</th>
              <th className='py-2'>
                <span className='sr-only'>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((r) => (
              <tr key={r.id} className='border-b border-slate-100 last:border-0 dark:border-border'>
                <td className='min-w-[104px] max-w-[220px] break-all py-2 pr-4 font-mono font-medium text-slate-900 dark:text-foreground'>
                  {r.version}
                  {r.from_version && r.from_version !== r.version && (
                    <span className='block text-[11px] font-normal text-slate-500 dark:text-slate-400'>
                      from {r.from_version}
                    </span>
                  )}
                </td>
                <td className='py-2 pr-4 text-slate-600 dark:text-slate-300'>
                  {deployKindWords(r)}
                </td>
                <td className={cn('py-2 pr-4 font-medium', promotionStatusTone(r.status))}>
                  {promotionStatusWords(r.status)}
                </td>
                <td className='whitespace-nowrap py-2 pr-4 text-slate-700 dark:text-slate-300'>
                  {whoOf(r)}
                </td>
                <td
                  className='whitespace-nowrap py-2 pr-4 text-slate-500 dark:text-muted-foreground'
                  data-tip={formatDateTime(r.started_at)}
                >
                  {formatRelative(r.started_at)}
                </td>
                <td
                  className='max-w-[140px] truncate py-2 pr-4 font-mono text-[11px] text-slate-500 dark:text-muted-foreground'
                  data-tip={r.step ?? undefined}
                >
                  {r.step ?? '—'}
                </td>
                <td className='w-full min-w-[160px] py-2 pr-4 text-[11px] text-red-700 dark:text-red-300'>
                  {r.error ? <RunnerError text={r.error} clamp /> : null}
                </td>
                <td className='whitespace-nowrap py-2'>{actions(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

/**
 * A runner error as a person may read it. Plain text shows as is; raw text (a stack, a driver
 * error, a status line) becomes one plain sentence with the text under "Details for support".
 */
export function RunnerError({ text, clamp }: { text: string; clamp?: boolean }) {
  if (!isRawErrorText(text))
    return <div className={cn('break-words', clamp && 'line-clamp-2')}>{text}</div>
  const d: ErrorDescription = {
    title: 'It stopped on an error the Hub could not put in plain words',
    technical: text
  }
  return (
    <div>
      <div className='break-words'>{d.title}</div>
      <ErrorDetails
        description={d}
        action='Hub promotion'
        rows={[{ label: 'Error', value: text }]}
        className='mt-1'
      />
    </div>
  )
}

/** Who started a run; nothing at all when the Hub has no starter for it. */
const whoOf = (r: HubPromotion) => r.started_by_name || (r.started_by ? 'Someone' : '')

function RowActions({
  row,
  canPromote,
  rollback,
  onRollback,
  onWatch
}: {
  row: HubPromotion
  canPromote: boolean
  rollback: boolean
  onRollback: (version: string) => void
  onWatch: (deployId: number, kind: PromotionKind) => void
}) {
  return (
    <div className='flex flex-nowrap items-center justify-end gap-0.5'>
      {isLivePromotion(row.status) && isPromotionKind(row.kind) && (
        <button
          type='button'
          aria-label={`Watch ${row.version}`}
          className={cn(ghostButton, 'shrink-0 whitespace-nowrap')}
          onClick={() => onWatch(row.id, row.kind)}
        >
          <Eye className='h-3.5 w-3.5' aria-hidden /> Watch
        </button>
      )}
      {canPromote && rollback && (
        <button
          type='button'
          aria-label={`Roll back to ${row.version}`}
          className={cn(ghostButton, 'shrink-0 whitespace-nowrap')}
          onClick={() => onRollback(row.version)}
        >
          <RotateCcw className='h-3.5 w-3.5' aria-hidden /> Roll back
        </button>
      )}
    </div>
  )
}

// ─── Card: every environment's Hub deploys ────────────────────────────────────

type PanelState =
  | { kind: 'rollback'; version: string }
  | { kind: 'promote' | 'rollback'; deployId: number }

export function PromotionsCard({
  envs,
  canPromote
}: {
  envs: HubEnvironment[]
  canPromote: boolean
}) {
  const managed = envs.filter((e) => e.placement_id != null)
  if (managed.length === 0) return null
  return (
    <SectionCard
      title='Hub deploys'
      description='Promotions, rollbacks and moves the Hub ran, newest first.'
    >
      <div className='divide-y divide-slate-200 dark:divide-border'>
        {managed.map((env) => (
          <EnvPromotions key={env.id} env={env} canPromote={canPromote} />
        ))}
      </div>
    </SectionCard>
  )
}

function EnvPromotions({ env, canPromote }: { env: HubEnvironment; canPromote: boolean }) {
  const [panel, setPanel] = useState<PanelState | null>(null)
  return (
    <div className='min-w-0 space-y-2 px-4 py-3'>
      <h4 className='m-0 font-mono text-[12px] font-semibold text-slate-800 dark:text-foreground'>
        {env.key}
      </h4>
      {panel && (
        <HubPromotePanel
          // A new pick starts a fresh panel (version, confirmation, plan).
          key={'deployId' in panel ? `d${panel.deployId}` : `v${panel.version}`}
          env={env}
          kind={panel.kind}
          initialVersion={'version' in panel ? panel.version : undefined}
          deployId={'deployId' in panel ? panel.deployId : undefined}
          canCancel={canPromote}
          idPrefix={`hub-rb-${env.id}`}
          onClose={() => setPanel(null)}
        />
      )}
      <PromotionHistory
        env={env}
        canPromote={canPromote}
        onRollback={(version) => setPanel({ kind: 'rollback', version })}
        onWatch={(deployId, kind) => setPanel({ kind, deployId })}
      />
    </div>
  )
}
