import { ConfirmButton, type ErrorDescription, ErrorNotice, isRawErrorText } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ban, Check, ChevronsUpDown, Circle, Loader2, X } from 'lucide-react'
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { HubRunTimeline } from '@/components/hub-brand/HubRunTimeline'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { cn, formatRelative } from '@/lib/utils'
import { type ChecklistState, PreDeployChecklist } from '../changes/PreDeployChecklist'
import { SharedWindowGate } from '../changes/WindowGate'
import {
  isLivePromotion,
  promotionStatusTone,
  promotionStatusWords,
  RUN_ERROR_COPY,
  splitRunError
} from '../hub-api'
import { dangerArmed, dangerGhost, SectionCard, segmentButton, segmentGroup } from '../hub-parts'
import { type SharedDeployment, sharedError, sharedKeys, WARNING_COPY } from './shared-api'
import {
  cancelSharedDeploy,
  defaultUpgradeVersion,
  fetchSharedDeploy,
  fetchSharedDeploys,
  fetchSharedVersions,
  heldByPlan,
  isDowngrade,
  isOverridable,
  KIND_WORDS,
  logLineWords,
  newestFirst,
  openBlockers,
  overrideId,
  planSharedUpgrade,
  refusedPlanOf,
  restatesTitle,
  runErrorText,
  runnerOf,
  type SharedDeploy,
  type SharedUpgradeKind,
  type SharedUpgradePlan,
  SILENT_WARNINGS,
  type StepState,
  startSharedUpgrade,
  stepStates,
  stepsOf,
  UPGRADE_COPY,
  upgradeCopy,
  upgradeKeys
} from './shared-upgrade-api'

/**
 * Upgrade or roll back a shared deployment the Hub runs (Docker) or upgrades through its GitLab
 * pipeline (registered with a GitLab driver): pick a version, read the plan
 * (which apps it touches and what holds each back), override an order or preflight hold where a
 * Hub administrator may, type the deployment's key, start; then watch each step. The server
 * re-checks everything at start, so the confirmation is for the person, not the gate.
 */
export function SharedUpgradePanel({ shared }: { shared: SharedDeployment }) {
  const [watching, setWatching] = useState<number | null>(null)
  const history = useQuery({
    queryKey: upgradeKeys.deploys(shared.id),
    queryFn: () => fetchSharedDeploys(shared.id),
    refetchInterval: (q) => ((q.state.data ?? []).some((d) => isLiveRun(d.status)) ? 10_000 : false)
  })
  // Runs the person closed with Done: the history can still list one as live for a moment after
  // its own read says it ended, and must not latch it again (one click closes it).
  const closed = useRef(new Set<number>())
  const live = (history.data ?? []).find((d) => isLiveRun(d.status) && !closed.current.has(d.id))
  // A run found running stays on screen after it ends, until the person closes it.
  useEffect(() => {
    if (live && watching == null) setWatching(live.id)
  }, [live, watching])
  const current = watching ?? live?.id ?? null

  return (
    <SectionCard
      title='Upgrade'
      description='Every app here moves to the new version together. Nothing is reverted on its own: a rollback is a new run to the earlier version.'
    >
      <div className='space-y-4 p-4'>
        {current != null ? (
          <UpgradeProgress
            sharedId={shared.id}
            deployId={current}
            onClose={() => {
              closed.current.add(current)
              setWatching(null)
            }}
          />
        ) : history.isPending ? (
          // Until the history answers, a run may be going: the form (and its plan read, which
          // calls the registry) waits for it. A failed history read still shows the form; the
          // server refuses a second run at start.
          <Skeleton className='h-24 w-full' />
        ) : (
          <UpgradeForm shared={shared} runs={history.data ?? []} onStarted={setWatching} />
        )}
        <UpgradeHistory query={history} onWatch={setWatching} current={current} />
      </div>
    </SectionCard>
  )
}

/** Planned or running (and any status this screen does not know, so a live view never freezes). */
const isLiveRun = (s: string) => isLivePromotion(s)

/** Versions this deployment ran after a finished Hub run (upgrade or rollback), newest first. */
export function rollbackVersions(runs: SharedDeploy[], current: string | null): string[] {
  const out: string[] = []
  for (const r of runs)
    if (
      r.status === 'success' &&
      (r.kind === 'upgrade' || r.kind === 'rollback') &&
      r.version !== current &&
      !out.includes(r.version)
    )
      out.push(r.version)
  return out
}

function upgradeError(err: unknown, fallback: string): ErrorDescription {
  const d = sharedError(err, fallback)
  const copy = d.code ? UPGRADE_COPY[d.code] : undefined
  if (!copy) return d
  const out: ErrorDescription = { ...d, title: copy.title }
  if (copy.hint) out.hint = copy.hint
  else delete out.hint
  return out
}

// ─── Before start ────────────────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<SharedUpgradeKind, { title: string; verb: string; start: string }> = {
  upgrade: { title: 'Upgrade', verb: 'upgrade', start: 'Start upgrade' },
  rollback: { title: 'Roll back', verb: 'roll back', start: 'Start rollback' }
}
/** An upgrade to an older version says what it is (P6-29). */
const DOWNGRADE_LABEL = { title: 'Downgrade', verb: 'downgrade', start: 'Start downgrade' }

function UpgradeForm({
  shared,
  runs,
  onStarted
}: {
  shared: SharedDeployment
  /** The deployment's runs, newest first: a rollback goes only to a version it ran before. */
  runs: SharedDeploy[]
  onStarted: (deployId: number) => void
}) {
  const qc = useQueryClient()
  const idPrefix = `shared-upgrade-${shared.id}`
  const [kind, setKind] = useState<SharedUpgradeKind>('upgrade')
  const versions = useQuery({
    queryKey: upgradeKeys.versions(shared.id),
    queryFn: () => fetchSharedVersions(shared.id),
    staleTime: 60_000
  })
  // Upgrade: the published versions. Roll back: only versions a run of the Hub deployed here
  // and finished (NOT_DEPLOYED_BEFORE otherwise), newest first, never the one it runs.
  const choices = useMemo(
    () =>
      kind === 'rollback'
        ? rollbackVersions(runs, shared.version_pin)
        : newestFirst(versions.data?.versions ?? []),
    [kind, runs, shared.version_pin, versions.data]
  )
  // What a first load picks: an upgrade the newest published version, and only when it is newer
  // than what runs (never a downgrade by default, P6-29); a rollback the newest it ran before.
  const firstPick =
    kind === 'rollback' ? (choices[0] ?? null) : defaultUpgradeVersion(choices, shared.version_pin)
  const [picked, setPicked] = useState('')
  // Pinned on first load: a refetch listing a newer version never swaps it under a typed key.
  useEffect(() => {
    if (picked || !firstPick) return
    setPicked(firstPick)
  }, [picked, firstPick])
  const runsNewest =
    kind === 'upgrade' && !picked && versions.isSuccess && choices.length > 0 && !firstPick
  // Upgrade and roll back offer different versions: switching starts the pick again. Done in the
  // click, not an effect: an effect clearing it in the same commit as the first pick (versions
  // not read yet when the person switched) left nothing picked for good.
  const chooseKind = (k: SharedUpgradeKind) => {
    if (k === kind) return
    setKind(k)
    setPicked('')
  }
  const version = picked.trim()

  const [confirm, setConfirm] = useState('')
  const [overrides, setOverrides] = useState<Set<string>>(() => new Set())
  const [changed, setChanged] = useState(false)
  const [failure, setFailure] = useState<ErrorDescription | null>(null)
  const [downgradeOk, setDowngradeOk] = useState(false)
  // The confirmation names one version and one kind: changing either clears it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: clearing is the point
  useEffect(() => {
    setConfirm('')
    setChanged(false)
    setFailure(null)
    setOverrides(new Set())
    setDowngradeOk(false)
  }, [kind, version])

  const plan = useQuery({
    queryKey: upgradeKeys.plan(shared.id, kind, version),
    queryFn: () => planSharedUpgrade(shared.id, kind, version),
    enabled: !!version,
    staleTime: 0,
    // A plan reads the registry and every app live: only a version pick or Plan again asks again.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false
  })
  // The confirmation and the overrides name one plan: a re-read that plans differently clears them.
  const shownHash = useRef<string | undefined>(undefined)
  const planHash = plan.data?.plan_hash
  useEffect(() => {
    if (shownHash.current && planHash && planHash !== shownHash.current) {
      setConfirm('')
      setOverrides(new Set())
    }
    if (planHash) shownHash.current = planHash
  }, [planHash])

  // The server's word once the plan is read (it also counts a version that is not semver); the
  // client's own reading before that.
  const downgrade = plan.data
    ? plan.data.downgrade === true
    : isDowngrade(kind, version, shared.version_pin)
  /** An administrator's emergency start outside the Hub-wide deploy windows: the reason. */
  const [outsideReason, setOutsideReason] = useState<string | null>(null)
  /**
   * The pre-deploy checklist of the production apps on this deployment: an upgrade, or a
   * rollback the Hub judges a forward deploy (not below what the deployment runs).
   */
  const [preDeploy, setPreDeploy] = useState<ChecklistState>({
    required: false,
    ready: true,
    runId: null
  })
  const start = useMutation({
    mutationFn: () =>
      startSharedUpgrade(shared.id, {
        kind,
        version,
        plan_hash: plan.data?.plan_hash ?? '',
        confirm: confirm.trim(),
        overrides: [...overrides].sort(),
        ...(downgrade && downgradeOk ? { downgrade: true as const } : {}),
        ...(preDeploy.runId != null ? { checklist_run_id: preDeploy.runId } : {}),
        ...(outsideReason ? { outside_window_reason: outsideReason } : {})
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: upgradeKeys.deploys(shared.id) })
      void qc.invalidateQueries({ queryKey: sharedKeys.detail(shared.id) })
      onStarted(r.shared_deploy_id)
    },
    onError: (err) => {
      const refused = refusedPlanOf(err)
      if (refused) {
        // The plan as it stands now replaces the one on screen (PLAN_CHANGED, BLOCKED,
        // APP_BLOCKED): it must be read and confirmed again.
        qc.setQueryData(upgradeKeys.plan(shared.id, kind, version), refused.plan)
        setChanged(refused.code === 'PLAN_CHANGED')
        setConfirm('')
        setOverrides(new Set())
        setDowngradeOk(false)
        setFailure(
          refused.code === 'PLAN_CHANGED'
            ? null
            : upgradeError(err, `Could not ${KIND_LABEL[kind].verb} ${shared.key}`)
        )
        return
      }
      setFailure(upgradeError(err, `Could not ${KIND_LABEL[kind].verb} ${shared.key}`))
      void qc.invalidateQueries({ queryKey: upgradeKeys.plan(shared.id, kind, version) })
    }
  })

  const open = plan.data ? openBlockers(plan.data, overrides) : null
  const ready =
    !!plan.data?.plan_hash &&
    open === 0 &&
    confirm.trim() === shared.key &&
    (!downgrade || downgradeOk) &&
    !(preDeploy.required && !preDeploy.ready) &&
    !start.isPending
  const label = downgrade ? DOWNGRADE_LABEL : KIND_LABEL[kind]
  const downgradeNote = plan.data?.warnings.find((w) => w.code === 'DOWNGRADE')?.text
  // The planner's own sentence only when the client cannot order the versions itself.
  const plannerSaysWhy =
    !!downgradeNote &&
    !isRawErrorText(downgradeNote) &&
    !isDowngrade(kind, version, shared.version_pin)

  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-end gap-3'>
        <fieldset className='m-0 border-0 p-0'>
          <legend className='mb-1.5 text-[12px] font-medium text-slate-700 dark:text-foreground'>
            What to do
          </legend>
          <div className={segmentGroup}>
            {(['upgrade', 'rollback'] as const).map((k) => (
              <button
                key={k}
                type='button'
                aria-pressed={kind === k}
                onClick={() => chooseKind(k)}
                className={segmentButton(kind === k)}
              >
                {KIND_LABEL[k].title}
              </button>
            ))}
          </div>
        </fieldset>
        <div className='w-[240px] max-w-full space-y-1.5'>
          <label
            htmlFor={`${idPrefix}-version`}
            className='block text-[12px] font-medium text-slate-700 dark:text-foreground'
          >
            Version
          </label>
          <VersionPicker
            id={`${idPrefix}-version`}
            value={version}
            current={shared.version_pin}
            markOlder={kind === 'upgrade'}
            options={choices}
            onChange={setPicked}
          />
        </div>
        <p className='m-0 pb-1.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
          Runs now: <span className='font-mono'>{shared.version_pin ?? 'no version yet'}</span>
        </p>
      </div>
      {versions.isError && (
        <ErrorNotice
          description={sharedError(versions.error, 'Could not read the published versions')}
          onRetry={() => void versions.refetch()}
        />
      )}
      {versions.data?.error && (
        <p role='status' className='m-0 text-[12px] text-amber-800 dark:text-amber-300'>
          Couldn't read the published releases. Type a version to check it.
        </p>
      )}

      {changed && (
        <p
          role='status'
          className='m-0 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] font-medium text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200'
        >
          The plan changed — check it again. This is the plan as it stands now; type{' '}
          <code className='font-mono font-semibold'>{shared.key}</code> again to start it.
        </p>
      )}

      {downgrade && version && (
        <div
          role='status'
          aria-labelledby={`${idPrefix}-downgrade`}
          className='space-y-1.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-900/60 dark:bg-amber-950/40'
        >
          <p
            id={`${idPrefix}-downgrade`}
            className='m-0 text-[12px] font-semibold text-amber-900 dark:text-amber-200'
          >
            This is a downgrade
          </p>
          {/* Said once (design N-r2-1): the client's sentence when it can order the two
              versions, else the planner's (a version that is not x.y.z), never both. */}
          {!plannerSaysWhy && (
            <p className='m-0 text-[12px] text-amber-900 dark:text-amber-200'>
              <span className='font-mono'>{version}</span> is older than the version it runs (
              <span className='font-mono'>{shared.version_pin ?? 'unknown'}</span>).
            </p>
          )}
          {plannerSaysWhy && (
            <p className='m-0 text-[12px] text-amber-900 dark:text-amber-200'>{downgradeNote}</p>
          )}
          <p className='m-0 text-[12px] text-amber-900 dark:text-amber-200'>
            Every app on it goes back, and an older version may not read data a newer one wrote. To
            return to a version this deployment ran before, use Roll back.
          </p>
          <div className='flex items-center gap-1.5'>
            <Checkbox
              id={`${idPrefix}-downgrade-ok`}
              checked={downgradeOk}
              onCheckedChange={(v) => setDowngradeOk(v === true)}
            />
            <label
              htmlFor={`${idPrefix}-downgrade-ok`}
              className='text-[12px] text-amber-900 dark:text-amber-200'
            >
              I mean to downgrade to <span className='font-mono'>{version}</span>
            </label>
          </div>
        </div>
      )}

      {runsNewest ? (
        <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
          Runs the newest published version. Pick a version to apply this one again or to go to
          another.
        </p>
      ) : !version ? (
        <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
          Pick a version to see what the {label.verb} would do.
        </p>
      ) : plan.data ? (
        <PlanPreview
          plan={plan.data}
          overrides={overrides}
          onOverride={(id, on) =>
            setOverrides((s) => {
              const next = new Set(s)
              if (on) next.add(id)
              else next.delete(id)
              return next
            })
          }
        />
      ) : plan.isPending ? (
        <Skeleton className='h-16 w-full' />
      ) : (
        <ErrorNotice
          description={upgradeError(plan.error, 'Could not check this version')}
          onRetry={() => void plan.refetch()}
        />
      )}

      <SharedWindowGate sharedId={shared.id} onReason={setOutsideReason} />

      {version && (
        <PreDeployChecklist
          key={kind}
          target={{ kind: 'shared', sharedId: shared.id }}
          action='upgrade'
          version={version}
          kind={kind === 'rollback' ? 'rollback' : null}
          onState={setPreDeploy}
        />
      )}

      <div className='space-y-1.5'>
        <label
          htmlFor={`${idPrefix}-confirm`}
          className='block text-[12px] font-medium text-slate-700 dark:text-foreground'
        >
          Type <code className='font-mono font-semibold'>{shared.key}</code> to {label.verb}
        </label>
        <Input
          id={`${idPrefix}-confirm`}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete='off'
          spellCheck={false}
          // Not the required text itself: a grey copy of it reads as already filled in.
          placeholder='Type it here'
          className='h-8 max-w-[280px] bg-white font-mono text-[13px] dark:bg-background'
        />
      </div>

      {failure && <ErrorNotice description={failure} />}

      <div className='flex flex-wrap items-center gap-2'>
        <Button
          size='sm'
          className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
          disabled={!ready}
          onClick={() => start.mutate()}
        >
          {start.isPending ? 'Starting…' : label.start}
        </Button>
        {plan.data && open !== null && open > 0 && (
          <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            {open === 1 ? '1 thing holds it back' : `${open} things hold it back`}
          </span>
        )}
      </div>
    </div>
  )
}

/** A searchable version list that also takes a typed version (the plan judges it). */
function VersionPicker({
  id,
  value,
  current,
  markOlder,
  options,
  onChange
}: {
  id: string
  value: string
  current: string | null
  /** Upgrade: a version older than the one running says so in the list. */
  markOlder: boolean
  options: string[]
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const typed = search.trim()
  const offerTyped =
    typed && !options.includes(typed) && /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(typed)
  const pick = (v: string) => {
    onChange(v)
    setSearch('')
    setOpen(false)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type='button'
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className='h-8 w-full justify-between bg-white px-2 font-mono text-[13px] font-normal dark:bg-background'
        >
          <span className={cn('truncate', !value && 'text-muted-foreground')}>
            {value || 'Pick a version'}
          </span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[260px] p-0' align='start'>
        <Command>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder='Search or type a version…'
            className='h-8 text-[12px]'
          />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No published version matches
            </CommandEmpty>
            <CommandGroup>
              {offerTyped && (
                <CommandItem value={typed} onSelect={() => pick(typed)} className='text-[12px]'>
                  Use <span className='ml-1 font-mono'>{typed}</span>
                </CommandItem>
              )}
              {options.map((v) => (
                <CommandItem
                  key={v}
                  value={v}
                  onSelect={() => pick(v)}
                  className='font-mono text-[12px]'
                >
                  <Check
                    className={cn('mr-2 h-3 w-3', value === v ? 'opacity-100' : 'opacity-0')}
                    aria-hidden
                  />
                  {v}
                  {v === current ? (
                    <span className='ml-auto font-sans text-[11px] text-muted-foreground'>
                      runs now
                    </span>
                  ) : (
                    markOlder &&
                    isDowngrade('upgrade', v, current) && (
                      <span className='ml-auto font-sans text-[11px] text-amber-700 dark:text-amber-300'>
                        older
                      </span>
                    )
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/**
 * What a run through the deployment's GitLab pipeline does, one labelled line per step in the
 * order it does them (the plan reads in two seconds; every machine value in mono).
 */
function GitlabLine({
  gitlab,
  plan
}: {
  gitlab: NonNullable<SharedUpgradePlan['gitlab']>
  plan: SharedUpgradePlan
}) {
  const sha = gitlab.commit ? gitlab.commit.slice(0, 8) : null
  const mono = 'font-mono text-[12px] text-slate-900 dark:text-foreground'
  const rows: { label: string; value: ReactNode }[] = [
    {
      label: 'Through',
      value: (
        <>
          {gitlab.driver} · <span className={mono}>{gitlab.project}</span>
        </>
      )
    },
    ...(plan.kind === 'rollback'
      ? [
          {
            label: 'Rerun',
            value: (
              <>
                <span className={mono}>{gitlab.deploy_job}</span> of pipeline{' '}
                <span className={mono}>{gitlab.build_pipeline_id ?? '?'}</span>
                {sha && (
                  <>
                    {' '}
                    (build <span className={mono}>{sha}</span>)
                  </>
                )}
              </>
            )
          }
        ]
      : [
          {
            label: 'Merge',
            value: (
              <>
                <span className={mono}>{sha ?? 'the release commit'}</span> from{' '}
                <span className={mono}>{gitlab.source_branch}</span> onto{' '}
                <span className={mono}>{gitlab.target_branch}</span>
              </>
            )
          },
          {
            label: 'Pin',
            value: (
              <>
                <span className={mono}>{plan.version}</span> in{' '}
                <span className={mono}>{gitlab.pin_file}</span>
              </>
            )
          },
          {
            label: 'Run',
            value: (
              <>
                {gitlab.before_job && (
                  <>
                    <span className={mono}>{gitlab.before_job}</span> first, then{' '}
                  </>
                )}
                <span className={mono}>{gitlab.deploy_job}</span>
              </>
            )
          }
        ])
  ]
  return (
    <dl
      aria-label='What GitLab does'
      className='m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px] text-slate-600 dark:text-slate-300'
    >
      {rows.map((r) => (
        <Fragment key={r.label}>
          <dt className='text-slate-500 dark:text-muted-foreground'>{r.label}</dt>
          <dd className='m-0 min-w-0 break-words'>{r.value}</dd>
        </Fragment>
      ))}
    </dl>
  )
}

function PlanPreview({
  plan,
  overrides,
  onOverride
}: {
  plan: SharedUpgradePlan
  overrides: ReadonlySet<string>
  onOverride: (id: string, on: boolean) => void
}) {
  return (
    <div className='space-y-3'>
      <p className='m-0 text-[12px] text-slate-600 dark:text-slate-300'>
        <span className='font-mono'>{plan.from_version ?? 'nothing'}</span> →{' '}
        <span className='font-mono font-semibold'>{plan.version}</span> on{' '}
        {plan.apps.length === 1 ? '1 app' : `${plan.apps.length} apps`}
      </p>

      {plan.runner === 'gitlab' && plan.gitlab && <GitlabLine gitlab={plan.gitlab} plan={plan} />}

      {plan.blockers.length > 0 && (
        <ul aria-label='What holds it back' className='m-0 list-none space-y-1.5 p-0'>
          {plan.blockers.map((b, i) => (
            <PlannerNote
              // biome-ignore lint/suspicious/noArrayIndexKey: planner rows have no id and a code repeats (BUSY per held environment, one per refused host); a new plan re-renders the list
              key={`${i}-${b.code}`}
              tone='bad'
              copy={upgradeCopy(b.code, b.text)}
              text={b.text}
            />
          ))}
        </ul>
      )}

      {plan.warnings.some((w) => !SILENT_WARNINGS.has(w.code)) && (
        <ul aria-label='Warnings' className='m-0 list-none space-y-1.5 p-0'>
          {plan.warnings
            .filter((w) => !SILENT_WARNINGS.has(w.code))
            .map((w, i) => (
              <PlannerNote
                // biome-ignore lint/suspicious/noArrayIndexKey: planner rows have no id and a code repeats (BUSY per held environment, one per refused host); a new plan re-renders the list
                key={`${i}-${w.code}`}
                tone='warn'
                copy={WARNING_COPY[w.code] ?? { title: w.text }}
                text={w.text}
              />
            ))}
        </ul>
      )}

      <div className='overflow-x-auto rounded-md border border-slate-200 dark:border-border'>
        <table aria-label='Apps this upgrade touches' className='w-full text-[12px]'>
          <thead className='bg-slate-50 text-left text-[11px] text-slate-500 dark:bg-muted/40 dark:text-muted-foreground'>
            <tr>
              <th className='px-3 py-1.5 font-medium'>App</th>
              <th className='hidden px-3 py-1.5 font-medium sm:table-cell'>Tenant</th>
              <th className='px-3 py-1.5 font-medium'>Holds it back</th>
            </tr>
          </thead>
          <tbody className='divide-y divide-slate-100 bg-white dark:divide-border dark:bg-card'>
            {plan.apps.map((a) => (
              <tr key={a.env_id}>
                <td className='px-3 py-1.5 text-slate-900 dark:text-foreground'>
                  <span className='whitespace-nowrap'>
                    {a.app} <span className='text-slate-400 dark:text-muted-foreground'>/</span>{' '}
                    {a.env}
                  </span>
                  {/* Design N-r2-7: on a phone the tenant goes under the app (its column is
                      for wider screens), so the app and environment never wrap word by word. */}
                  <span className='block break-all font-mono text-[11px] text-slate-500 sm:hidden dark:text-muted-foreground'>
                    {`Tenant ${a.tenant_id}`}
                  </span>
                </td>
                <td className='hidden px-3 py-1.5 font-mono text-slate-600 sm:table-cell dark:text-slate-300'>
                  {a.tenant_id}
                </td>
                <td className='px-3 py-1.5'>
                  {a.blockers.length === 0 ? (
                    heldByPlan(plan.blockers, a) ? (
                      // A plan-wide BUSY names this environment: it is held, not ready.
                      <span
                        data-tip='Something else holds this environment (see above)'
                        className='font-medium text-amber-700 dark:text-amber-300'
                      >
                        Busy
                      </span>
                    ) : (
                      <span className='text-emerald-700 dark:text-emerald-300'>Ready</span>
                    )
                  ) : (
                    <ul className='m-0 list-none space-y-1 p-0'>
                      {a.blockers.map((code, i) => (
                        <AppBlocker
                          // biome-ignore lint/suspicious/noArrayIndexKey: index pairs a code with its note; planner rows have no id
                          key={`${i}-${code}`}
                          app={a}
                          code={code}
                          note={a.notes?.[i]}
                          overridable={isOverridable(plan, code)}
                          overridden={overrides.has(overrideId(a, code))}
                          onOverride={onOverride}
                        />
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const NOTE_TONE = {
  bad: {
    box: 'border-red-200 bg-red-50 dark:border-red-900/60 dark:bg-red-950/40',
    title: 'text-red-800 dark:text-red-200',
    text: 'text-red-800/90 dark:text-red-200/90',
    hint: 'text-red-700/90 dark:text-red-300/90'
  },
  warn: {
    box: 'border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/40',
    title: 'text-amber-900 dark:text-amber-200',
    text: 'text-amber-900/90 dark:text-amber-200/90',
    hint: 'text-amber-900/80 dark:text-amber-200/80'
  }
} as const

/**
 * One planner row: the plain copy for its code, then the planner's own sentence (which app,
 * environment, extension or host; which case of the code), then what to do.
 */
function PlannerNote({
  tone,
  copy,
  text
}: {
  tone: keyof typeof NOTE_TONE
  copy: { title: string; hint?: string }
  text: string
}) {
  const t = NOTE_TONE[tone]
  // One clear sentence per row: the planner's own only when it adds something (a name, a case).
  const detail =
    text && text !== copy.title && !isRawErrorText(text) && !restatesTitle(copy.title, text)
      ? text
      : null
  return (
    <li className={cn('rounded-md border px-3 py-2', t.box)}>
      <p className={cn('m-0 text-[12px] font-medium', t.title)}>{copy.title}</p>
      {detail && <p className={cn('m-0 mt-0.5 text-[12px]', t.text)}>{detail}</p>}
      {copy.hint && <p className={cn('m-0 mt-0.5 text-[12px]', t.hint)}>{copy.hint}</p>}
    </li>
  )
}

function AppBlocker({
  app,
  code,
  note,
  overridable,
  overridden,
  onOverride
}: {
  app: SharedUpgradePlan['apps'][number]
  code: string
  /** The plan's own sentence for this blocker (names the app's detail). */
  note?: string
  overridable: boolean
  overridden: boolean
  onOverride: (id: string, on: boolean) => void
}) {
  const c = upgradeCopy(code)
  const id = overrideId(app, code)
  const boxId = `ovr-${app.env_id}-${code}`
  return (
    <li>
      <p
        data-tip={c.hint}
        className={cn(
          'm-0 font-medium',
          overridden
            ? 'text-slate-500 line-through dark:text-muted-foreground'
            : 'text-red-700 dark:text-red-300'
        )}
      >
        {c.title}
      </p>
      {note && !isRawErrorText(note) && !restatesTitle(c.title, note) && (
        <p className='m-0 mt-0.5 text-[11.5px] text-slate-600 dark:text-slate-300'>{note}</p>
      )}
      {overridable && (
        <div className='mt-1 flex items-center gap-1.5'>
          <Checkbox
            id={boxId}
            checked={overridden}
            onCheckedChange={(v) => onOverride(id, v === true)}
          />
          <label htmlFor={boxId} className='text-[11.5px] text-slate-600 dark:text-slate-300'>
            Go ahead anyway (logged)
          </label>
        </div>
      )}
    </li>
  )
}

// ─── After start ─────────────────────────────────────────────────────────────────────────────

const STEP_ICON: Record<StepState, typeof Check> = {
  done: Check,
  running: Loader2,
  failed: X,
  stopped: Ban,
  pending: Circle
}

const STEP_TONE: Record<StepState, string> = {
  done: 'text-emerald-600 dark:text-emerald-400',
  running: 'text-sky-600 dark:text-sky-400 animate-spin',
  failed: 'text-red-600 dark:text-red-400',
  stopped: 'text-amber-700 dark:text-amber-300',
  pending: 'text-slate-300 dark:text-slate-600'
}

function UpgradeProgress({
  sharedId,
  deployId,
  onClose
}: {
  sharedId: number
  deployId: number
  onClose: () => void
}) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: upgradeKeys.deploy(deployId),
    queryFn: () => fetchSharedDeploy(deployId),
    refetchInterval: (query) => {
      if (query.state.status === 'error' && !query.state.data) return false
      const s = query.state.data?.status
      return !s || isLiveRun(s) ? 2_000 : false
    }
  })
  const d = q.data
  const live = d ? isLiveRun(d.status) : true
  const wasLive = useRef(live)
  // When the run ends, the deployment, its apps and the history are read again.
  useEffect(() => {
    if (wasLive.current && !live) {
      void qc.invalidateQueries({ queryKey: upgradeKeys.deploys(sharedId) })
      void qc.invalidateQueries({ queryKey: sharedKeys.detail(sharedId) })
      void qc.invalidateQueries({ queryKey: sharedKeys.list() })
    }
    wasLive.current = live
  }, [live, qc, sharedId])
  const [cancelFailure, setCancelFailure] = useState<ErrorDescription | null>(null)
  const cancel = useMutation({
    mutationFn: () => cancelSharedDeploy(deployId),
    onSuccess: () => {
      setCancelFailure(null)
      void qc.invalidateQueries({ queryKey: upgradeKeys.deploy(deployId) })
    },
    onError: (err) => setCancelFailure(upgradeError(err, 'Could not cancel the upgrade'))
  })

  if (!d)
    return q.isError ? (
      <ErrorNotice
        description={upgradeError(q.error, 'Could not read the upgrade')}
        onRetry={() => void q.refetch()}
      />
    ) : (
      <Skeleton className='h-24 w-full' />
    )

  const states = stepStates(d)
  const steps = stepsOf(d)
  const kindWord = KIND_WORDS[d.kind] ?? d.kind
  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center gap-2'>
        <p className='m-0 min-w-0 flex-1 text-[13px] text-slate-900 dark:text-foreground'>
          {kindWord} to <span className='font-mono font-semibold'>{d.version}</span>
          {d.from_version && (
            <span className='text-slate-500 dark:text-muted-foreground'>
              {' '}
              from <span className='font-mono'>{d.from_version}</span>
            </span>
          )}
          {' · '}
          <span className={cn('font-medium', promotionStatusTone(d.status))}>
            {promotionStatusWords(d.status)}
          </span>
        </p>
        {live ? (
          <ConfirmButton
            onConfirm={() => cancel.mutate()}
            title='Cancel upgrade'
            confirmLabel='Cancel now?'
            disabled={cancel.isPending}
            className={dangerGhost}
            armedClassName={cn(dangerGhost, dangerArmed)}
          >
            <Ban className='h-3.5 w-3.5' aria-hidden /> Cancel
          </ConfirmButton>
        ) : (
          <Button type='button' variant='outline' size='sm' className='h-8' onClick={onClose}>
            Done
          </Button>
        )}
      </div>

      {/* Standalone Hub: the upgrade as a track (renders nothing otherwise). */}
      <HubRunTimeline
        what={d.kind === 'rollback' ? 'Rollback' : 'Upgrade'}
        live={live}
        steps={steps.map((s, i) => ({
          key: s.key,
          label: s.label,
          short: s.short,
          state: states[i]
        }))}
      />
      <ol aria-label='Upgrade steps' className='hub-run-steps m-0 list-none space-y-1.5 p-0'>
        {steps.map((s, i) => {
          const st = states[i]
          const Icon = STEP_ICON[st]
          return (
            <li key={s.key} data-state={st} className='flex items-center gap-2 text-[12px]'>
              <Icon className={cn('h-3.5 w-3.5 shrink-0', STEP_TONE[st])} aria-hidden />
              <span
                className={
                  st === 'pending'
                    ? 'text-slate-500 dark:text-muted-foreground'
                    : 'text-slate-900 dark:text-foreground'
                }
              >
                {s.label}
              </span>
            </li>
          )
        })}
      </ol>
      {live && d.step === 'deploy' && runnerOf(d) === 'gitlab' && (
        <p className='m-0 text-[12px] text-slate-600 dark:text-slate-300'>
          Cancel stops the Hub waiting. A deploy job GitLab already started keeps running there.
        </p>
      )}
      {live && d.step && !steps.some((s) => s.key === d.step) && (
        // A step this screen does not know (a newer server): never its raw key.
        <p className='m-0 text-[12px] text-slate-600 dark:text-slate-300'>Working…</p>
      )}

      {d.log && d.log.length > 0 && (
        <ol
          aria-label='Upgrade log'
          className='m-0 max-h-[160px] list-none space-y-0.5 overflow-y-auto rounded-md border border-slate-200 bg-white p-2 font-mono text-[11px] dark:border-border dark:bg-card'
        >
          {d.log.slice(-12).map((l) => (
            <li
              key={l.seq}
              className={cn(
                l.level === 'error'
                  ? 'text-red-700 dark:text-red-300'
                  : l.level === 'warn'
                    ? 'text-amber-800 dark:text-amber-300'
                    : 'text-slate-600 dark:text-slate-300'
              )}
            >
              {isRawErrorText(logLineWords(l.line))
                ? 'A step reported an error (see the job run).'
                : logLineWords(l.line)}
            </li>
          ))}
        </ol>
      )}

      {d.error && <RunStopped error={d.error} />}
      {d.status === 'failed' &&
        (splitRunError(d.error ?? '').code === 'SWARM_ROLLED_BACK' ? (
          // Swarm itself put the earlier spec back: saying "nothing was reverted" would be wrong.
          <p className='m-0 text-[12px] text-slate-600 dark:text-slate-300'>
            Swarm put the previous version back: the apps still run{' '}
            <span className='font-mono'>{d.from_version ?? 'the earlier version'}</span>. Fix what
            failed and upgrade again.
          </p>
        ) : (
          <p className='m-0 text-[12px] text-slate-600 dark:text-slate-300'>
            Nothing was reverted. Fix what failed and upgrade again, or roll back to{' '}
            <span className='font-mono'>{d.from_version ?? 'the earlier version'}</span>.
          </p>
        ))}
      {cancelFailure && <ErrorNotice description={cancelFailure} />}
    </div>
  )
}

/** How a run stopped: plain words for its code, then its own sentence (never the code). */
function RunStopped({ error }: { error: string }) {
  const { code } = splitRunError(error)
  const title = code ? RUN_ERROR_COPY[code]?.title : undefined
  const sentence = runErrorText(error)
  const raw = isRawErrorText(sentence)
  return (
    <div
      role='status'
      className='m-0 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200'
    >
      {title && <p className='m-0 font-medium'>{title}</p>}
      {raw
        ? !title && (
            <p className='m-0'>The run stopped with an error. Its job run has the details.</p>
          )
        : sentence !== title && <p className='m-0'>{sentence}</p>}
    </div>
  )
}

function UpgradeHistory({
  query,
  onWatch,
  current
}: {
  query: {
    data?: SharedDeploy[]
    isPending: boolean
    isError: boolean
    error: unknown
    refetch: () => unknown
  }
  onWatch: (id: number) => void
  current: number | null
}) {
  if (query.isPending) return <Skeleton className='h-10 w-full' />
  if (query.isError)
    return (
      <ErrorNotice
        description={sharedError(query.error, 'Could not read the upgrade history')}
        onRetry={() => void query.refetch()}
      />
    )
  const rows = query.data ?? []
  return (
    <div className='space-y-1.5'>
      <h4 className='m-0 text-[12px] font-medium text-slate-500 dark:text-muted-foreground'>
        History
      </h4>
      {rows.length === 0 ? (
        <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
          No upgrades recorded yet.
        </p>
      ) : (
        <ul
          aria-label='Upgrade history'
          className='m-0 list-none divide-y divide-slate-100 rounded-md border border-slate-200 bg-white p-0 dark:divide-border dark:border-border dark:bg-card'
        >
          {rows.map((d) => (
            <li key={d.id} className='flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5'>
              <span className='w-[92px] shrink-0 text-[12px] text-slate-900 dark:text-foreground'>
                {KIND_WORDS[d.kind] ?? d.kind}
              </span>
              {/* Phone: its own full-width line after the rest (it was cut to "0.…"). */}
              <span className='order-last min-w-0 basis-full break-words font-mono text-[12px] text-slate-700 sm:order-none sm:basis-0 sm:flex-1 sm:truncate dark:text-slate-300'>
                {d.from_version ? `${d.from_version} → ${d.version}` : d.version}
              </span>
              <span className={cn('text-[12px] font-medium', promotionStatusTone(d.status))}>
                {promotionStatusWords(d.status)}
              </span>
              {d.started_at && (
                <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                  {formatRelative(d.started_at)}
                  {d.started_by_name ? ` · ${d.started_by_name}` : ''}
                </span>
              )}
              {d.id !== current && d.kind !== 'observed' && (
                <button
                  type='button'
                  onClick={() => onWatch(d.id)}
                  className='text-[11.5px] font-medium text-nvr-cyan hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50'
                >
                  Details
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
