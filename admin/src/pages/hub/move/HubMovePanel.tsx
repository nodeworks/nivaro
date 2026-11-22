import { ConfirmButton, ErrorNotice } from '@nivaro/shared'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowRight,
  Ban,
  Check,
  ChevronsUpDown,
  Circle,
  Clock,
  Loader2,
  Play,
  RotateCcw,
  Undo2,
  X
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
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
import { cn, formatDateTime, formatRelative } from '@/lib/utils'
import { RunnerError } from '../HubPromotePanel'
import { type HubEnvironment, hubKeys } from '../hub-api'
import { CopyButton, dangerArmed, dangerGhost, Field, ghostButton } from '../hub-parts'
import { HubAppKeyField } from './HubAppKeyField'
import {
  cancelMove,
  changedMovePlanOf,
  confirmMoveRoute,
  createDedicatedPlacement,
  deletePlacement,
  fetchMove,
  fetchMovePlan,
  fetchMoves,
  fetchPlacement,
  formatBytes,
  type HubMove,
  type HubPlacement,
  isLiveMove,
  isOpenMove,
  isRollingBack,
  MOVE_KIND_WORDS,
  type MoveIssue,
  type MovePlan,
  type MoveStepState,
  moveChecklistOf,
  moveError,
  moveFilesOf,
  moveIssueCopy,
  moveKeys,
  movePlanOf,
  moveStatusTone,
  moveStatusWords,
  moveStepRows,
  moveToast,
  newestMove,
  pastRelease,
  readDismissedMove,
  resumeMove,
  rollbackMove,
  STACK_NAME_RE,
  setMoveChecklist,
  startMove,
  targetFromValue,
  uniqueStackName,
  useDrivers,
  usePlacement,
  useSharedList,
  writeDismissedMove
} from './move-api'

/**
 * Nivaro Hub (phase 6) — move one environment between a dedicated stack and a shared deployment
 * (or between two shared deployments). Pick the target, read the plan (blockers in red, warnings
 * in amber, files, how the address changes, the checklist), type `<app>/<env>`, start; then
 * follow each step, send the address request when the change is manual, and cancel, resume or
 * roll back. Hub admins only (the routes refuse everyone else). The server re-checks every
 * blocker at start, so the confirmation here is for the person, not the gate.
 */

// ─── A small searchable picker (shadcn Combobox) ──────────────────────────────

export interface ComboOption {
  value: string
  label: string
  hint?: string
  disabled?: boolean
}

export function OptionCombobox({
  id,
  label,
  value,
  onChange,
  options,
  placeholder = 'Pick one…',
  emptyText = 'Nothing to pick',
  className,
  disabled
}: {
  id?: string
  /** The accessible name of the trigger. */
  label: string
  value: string
  onChange: (v: string) => void
  options: ComboOption[]
  placeholder?: string
  emptyText?: string
  className?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.value === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type='button'
          variant='outline'
          role='combobox'
          aria-label={label}
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            'h-8 w-full justify-between bg-white px-2 text-[13px] font-normal dark:bg-background',
            className
          )}
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? selected.label : placeholder}
          </span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[--radix-popover-trigger-width] min-w-[260px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              {emptyText}
            </CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={o.value}
                  keywords={[o.label, o.hint ?? '']}
                  disabled={o.disabled}
                  onSelect={() => {
                    onChange(o.value)
                    setOpen(false)
                  }}
                  className='text-[12px]'
                >
                  <Check
                    className={cn(
                      'mr-2 h-3 w-3 shrink-0',
                      value === o.value ? 'opacity-100' : 'opacity-0'
                    )}
                    aria-hidden
                  />
                  <span className='min-w-0'>
                    <span className='block truncate'>{o.label}</span>
                    {o.hint && (
                      <span className='block truncate text-[11px] text-slate-500 dark:text-muted-foreground'>
                        {o.hint}
                      </span>
                    )}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// ─── The panel ────────────────────────────────────────────────────────────────

export function HubMovePanel({
  appKey,
  env,
  idPrefix,
  onClose
}: {
  appKey: string
  env: HubEnvironment
  /** Unique per layout (the table and the phone list can both hold a panel). */
  idPrefix: string
  onClose: () => void
}) {
  const [started, setStarted] = useState<number | null>(null)
  // While a start or a stack-placement request is out, the panel cannot be closed (closing would
  // drop the request's answer: a placement then leaks, or is deleted under a starting move).
  const [busy, setBusy] = useState(false)
  // The move on screen stays there after it ends (its result, error and open checklist items)
  // until the person dismisses it: a refetched list no longer naming it open never hides it.
  const [latched, setLatched] = useState<number | null>(null)
  const [dismissed, setDismissed] = useState<number | null>(() => readDismissedMove(env.id))
  const moves = useQuery({
    queryKey: moveKeys.moves(env.id),
    queryFn: () => fetchMoves(env.id),
    refetchInterval: (q) => (q.state.data?.some((m) => isLiveMove(m.status)) ? 5000 : false)
  })
  const open = moves.data?.find((m) => isOpenMove(m.status))
  const latest = newestMove(moves.data)
  const unseen = latest && latest.id !== dismissed ? latest.id : null
  const watching = started ?? latched ?? open?.id ?? unseen
  useEffect(() => {
    if (watching != null && latched !== watching) setLatched(watching)
  }, [watching, latched])
  const dismiss = (moveId: number) => {
    writeDismissedMove(env.id, moveId)
    setDismissed(moveId)
    setStarted(null)
    setLatched(null)
  }
  const title = `Move ${env.key}`

  return (
    <section
      aria-label={title}
      className='min-w-0 space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:p-4 dark:border-border dark:bg-muted/40'
    >
      <div className='flex items-center gap-2'>
        <h4 className='m-0 min-w-0 flex-1 truncate text-[13px] font-semibold text-slate-900 dark:text-foreground'>
          Move <span className='font-mono'>{env.key}</span>
        </h4>
        <button
          type='button'
          aria-label='Close'
          className={ghostButton}
          disabled={busy}
          data-tip={busy ? 'Wait for the request to finish' : undefined}
          onClick={onClose}
        >
          <X className='h-3.5 w-3.5' aria-hidden />
        </button>
      </div>
      {moves.isPending ? (
        <Skeleton className='h-24 w-full' />
      ) : moves.isError && !moves.data && watching == null ? (
        // Without the list the panel cannot tell whether a move is already open here: it shows
        // no form until the list reads.
        <ErrorNotice
          description={moveError(moves.error, "Could not read this environment's moves")}
          onRetry={() => void moves.refetch()}
        />
      ) : watching != null ? (
        <MoveProgress moveId={watching} env={env} onDismiss={() => dismiss(watching)} />
      ) : (
        <MoveForm
          appKey={appKey}
          env={env}
          idPrefix={idPrefix}
          pastMoves={moves.data ?? []}
          onStarted={setStarted}
          onBusy={setBusy}
          onClose={onClose}
        />
      )}
      {moves.isError && moves.data && (
        <ErrorNotice
          description={moveError(moves.error, "Could not read this environment's moves")}
          onRetry={() => void moves.refetch()}
        />
      )}
    </section>
  )
}

// ─── Before start: target, plan, checklist, confirmation ─────────────────────

const POOL_MIN = 2
const POOL_MAX = 20

function MoveForm({
  appKey,
  env,
  idPrefix,
  pastMoves,
  onStarted,
  onBusy,
  onClose
}: {
  appKey: string
  env: HubEnvironment
  idPrefix: string
  pastMoves: HubMove[]
  onStarted: (moveId: number) => void
  /** A start or a stack-placement request is out (the panel then cannot be closed). */
  onBusy?: (busy: boolean) => void
  onClose: () => void
}) {
  const qc = useQueryClient()
  const current = usePlacement(env.placement_id)
  const shared = useSharedList()
  const drivers = useDrivers()

  // Dedicated placements of this environment it could go back to: the homes earlier moves took
  // it from (a placement is never shared between environments).
  // Also the dedicated target of a move to a dedicated stack that did not finish: its placement
  // is still there (only a shared target's placement is removed on rollback).
  const homeIds = useMemo(
    () =>
      [
        ...new Set(
          pastMoves.flatMap((m) => [
            m.from_placement_id,
            ...(m.kind === 'to_dedicated' && m.status !== 'success' && !isOpenMove(m.status)
              ? [m.to_placement_id]
              : [])
          ])
        )
      ].filter((id) => id != null && id !== env.placement_id),
    [pastMoves, env.placement_id]
  )
  const homes = useQueries({
    queries: homeIds.map((id) => ({
      queryKey: moveKeys.placement(id),
      queryFn: () => fetchPlacement(id),
      staleTime: 60_000
    }))
  })

  const [pick, setPickRaw] = useState('')
  const pickRef = useRef(pick)
  pickRef.current = pick
  const aliveRef = useRef(true)
  /** A start is out: the placement may already belong to a move the server just started. */
  const startingRef = useRef(false)
  // A placement this form made for a new stack: removed again unless a move starts on it.
  const [made, setMade] = useState<{ id: number; driver: string; stack: string } | null>(null)
  const madeRef = useRef<{ id: number; started: boolean } | null>(null)
  const forgetMade = () => {
    const m = madeRef.current
    madeRef.current = null
    setMade(null)
    // Never while a start is out: the server may have started a move on it (and refuses to delete
    // a placement an open move names; a rollback removes one it never deployed).
    if (m && !m.started && !startingRef.current) {
      void deletePlacement(m.id).catch(() => undefined)
      qc.removeQueries({ queryKey: moveKeys.placement(m.id) })
    }
  }
  const setPick = (v: string) => {
    if (made && v !== `dedicated:${made.id}`) forgetMade()
    // Each new-stack attempt gets its own name (a leftover never blocks the next one).
    if (v.startsWith('new:') && v !== pick) setStackName(uniqueStackName(appKey, env.key))
    setPickRaw(v)
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: on unmount only
  useEffect(
    () => () => {
      aliveRef.current = false
      forgetMade()
    },
    []
  )
  const newOn = /^new:(\d+)$/.exec(pick)
  const newDriver = newOn ? drivers.data?.find((d) => d.id === Number(newOn[1])) : undefined
  const [stackName, setStackName] = useState(() => uniqueStackName(appKey, env.key))
  const stackBad = !STACK_NAME_RE.test(stackName.trim())
  const makeStack = useMutation({
    mutationFn: (v: { driverId: number; stack: string; askedPick: string }) =>
      createDedicatedPlacement(v.driverId, v.stack),
    onSuccess: (r, v) => {
      // An answer for a form that is gone, or for a pick that changed meanwhile, is not used:
      // its placement is removed at once.
      if (!aliveRef.current || pickRef.current !== v.askedPick) {
        void deletePlacement(r.id).catch(() => undefined)
        return
      }
      madeRef.current = { id: r.id, started: false }
      setMade({ id: r.id, driver: newDriver?.name ?? 'driver', stack: stackName.trim() })
      setPickRaw(`dedicated:${r.id}`)
    },
    onError: (err) => moveToast(err, 'Could not make the stack placement')
  })

  const currentShared = current.data?.kind === 'shared' ? current.data.shared_deployment_id : null
  const options: ComboOption[] = [
    ...(shared.data ?? [])
      .filter((s) => s.status !== 'retired' && s.id !== currentShared)
      .map((s) => ({
        value: `shared:${s.id}`,
        label: `Shared · ${s.key}`,
        hint: [s.name, s.version_pin].filter(Boolean).join(' · ')
      })),
    // Back to a dedicated stack only from a shared deployment (dedicated → dedicated is not a
    // move: the planner answers NOT_A_MOVE).
    ...homes
      .filter(() => currentShared != null)
      .map((h) => h.data)
      .filter((p): p is Extract<HubPlacement, { kind: 'dedicated' }> => p?.kind === 'dedicated')
      .map((p) => {
        const driver = drivers.data?.find((d) => d.id === p.driver_id)
        const where = p.target.stack ?? p.target.branch
        return {
          value: `dedicated:${p.id}`,
          label: `Dedicated · ${driver?.name ?? 'driver'}${where ? ` · ${where}` : ''}`,
          hint: 'Where this environment ran before'
        }
      }),
    // Never ran on a stack of its own (placed on shared from the start): a new stack on any
    // Docker driver (ruling P6-17 gap a).
    ...(currentShared != null
      ? (drivers.data ?? [])
          .filter((d) => d.kind === 'docker')
          .map((d) => ({
            value: `new:${d.id}`,
            label: `New stack on ${d.name}`,
            hint: 'A dedicated Docker stack for this environment'
          }))
      : []),
    ...(made
      ? [
          {
            value: `dedicated:${made.id}`,
            label: `Dedicated · ${made.driver} · ${made.stack}`,
            hint: 'The new stack placement'
          }
        ]
      : [])
  ]

  const [pool, setPool] = useState('5')
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [confirm, setConfirm] = useState('')
  const [changed, setChanged] = useState(false)
  const poolN = Number(pool)
  const poolBad = !Number.isInteger(poolN) || poolN < POOL_MIN || poolN > POOL_MAX
  const base = targetFromValue(pick)
  const target =
    base?.kind === 'shared' ? { ...base, ...(poolBad ? {} : { pool_max: poolN }) } : base
  const planKey = moveKeys.plan(env.id, `${pick}|${base?.kind === 'shared' ? pool : ''}`)

  const plan = useQuery({
    queryKey: planKey,
    queryFn: () => fetchMovePlan(env.id, target as NonNullable<typeof target>),
    enabled: !!target && !(base?.kind === 'shared' && poolBad),
    // A plan reads both sides live (30–50 s into a shared deployment): read on demand only —
    // never on focus or a timer. "Plan again" (or a refused start) asks for a fresh one.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // A closed panel forgets its plan: opening it again plans afresh (hashes change).
    gcTime: 0,
    retry: false
  })

  // A new target (or a new plan) starts the checklist and the confirmation afresh.
  // A new target or a new connections count is a new plan: tick and confirm it afresh.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on the pick and pool only
  useEffect(() => {
    setChecked({})
    setConfirm('')
    setChanged(false)
  }, [pick, pool])

  const expected = `${appKey}/${env.key}`
  const p = plan.data
  // A plan read again with another hash (Plan again, a refused start, a saved app key) is a new
  // plan: its checklist and the confirmation start afresh.
  const planHash = p?.plan_hash
  const seenHash = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (planHash && seenHash.current && planHash !== seenHash.current) {
      setChecked({})
      setConfirm('')
    }
    if (planHash) seenHash.current = planHash
  }, [planHash])
  const requiredOpen = (p?.checklist ?? []).some((c) => c.required && !checked[c.id])
  const ready =
    !!p && !!p.plan_hash && p.blockers.length === 0 && !requiredOpen && confirm.trim() === expected

  const start = useMutation({
    onMutate: () => {
      startingRef.current = true
    },
    onSettled: () => {
      startingRef.current = false
    },
    mutationFn: () =>
      startMove(env.id, {
        to: target as NonNullable<typeof target>,
        plan_hash: (p as MovePlan).plan_hash,
        confirm: confirm.trim(),
        checklist: Object.fromEntries((p?.checklist ?? []).map((c) => [c.id, !!checked[c.id]]))
      }),
    onSuccess: (r) => {
      // The move owns the placement it starts on: it is never removed by this form.
      if (madeRef.current) madeRef.current.started = true
      void qc.invalidateQueries({ queryKey: moveKeys.moves(env.id) })
      onStarted(r.move_id)
    },
    onError: (err) => {
      const now = changedMovePlanOf(err)
      if (now) {
        qc.setQueryData(planKey, now)
        setChanged(true)
        setConfirm('')
        setChecked({})
        return
      }
      void qc.invalidateQueries({ queryKey: planKey })
      moveToast(err, `Could not move ${env.key}`)
    }
  })

  const busy = start.isPending || makeStack.isPending
  useEffect(() => onBusy?.(busy), [busy, onBusy])
  // biome-ignore lint/correctness/useExhaustiveDependencies: on unmount only
  useEffect(() => () => onBusy?.(false), [])

  return (
    <div className='space-y-3'>
      <div className='grid grid-cols-1 gap-3 sm:grid-cols-[minmax(220px,1fr)_120px]'>
        <Field id={`${idPrefix}-target`} label='Move to'>
          <OptionCombobox
            id={`${idPrefix}-target`}
            label='Move to'
            value={pick}
            onChange={setPick}
            disabled={busy}
            options={options}
            placeholder='Pick a shared deployment or stack…'
            emptyText='No other place to move to'
          />
        </Field>
        {newOn && (
          <Field
            id={`${idPrefix}-stack`}
            label='Stack name'
            hint='Lower-case letters, digits and dashes.'
            error={stackBad ? '2–41 characters, starting with a letter.' : null}
          >
            <Input
              id={`${idPrefix}-stack`}
              value={stackName}
              onChange={(e) => setStackName(e.target.value)}
              spellCheck={false}
              className='h-8 bg-white font-mono text-[13px] dark:bg-background'
            />
          </Field>
        )}
        {base?.kind === 'shared' && (
          <Field
            id={`${idPrefix}-pool`}
            label='Database connections'
            hint='How many the app may open there.'
            error={poolBad ? `Between ${POOL_MIN} and ${POOL_MAX}.` : null}
          >
            <Input
              id={`${idPrefix}-pool`}
              inputMode='numeric'
              value={pool}
              onChange={(e) => setPool(e.target.value)}
              className='h-8 bg-white font-mono text-[13px] dark:bg-background'
            />
          </Field>
        )}
      </div>
      {newOn && (
        <div className='flex flex-wrap items-center gap-2'>
          <Button
            size='sm'
            variant='outline'
            className='h-8'
            disabled={stackBad || makeStack.isPending || !newDriver}
            onClick={() =>
              makeStack.mutate({
                driverId: Number(newOn?.[1]),
                stack: stackName.trim(),
                askedPick: pick
              })
            }
          >
            {makeStack.isPending ? 'Making…' : 'Make the stack placement and plan'}
          </Button>
          <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
            The Hub records where the stack will run; nothing is deployed until the move starts. It
            is removed again if you leave without starting.
          </span>
        </div>
      )}
      {shared.isError && (
        <ErrorNotice
          description={moveError(shared.error, 'Could not read the shared deployments')}
          onRetry={() => void shared.refetch()}
        />
      )}

      {changed && (
        <p
          role='status'
          className='m-0 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] font-medium text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200'
        >
          The plan changed — check it again. This is the plan as it stands now; tick the checklist
          and type <code className='font-mono font-semibold'>{expected}</code> again to start it.
        </p>
      )}

      {target &&
        (p ? (
          <MovePlanView
            plan={p}
            env={env}
            idPrefix={idPrefix}
            checked={checked}
            onCheck={(id, v) => setChecked((c) => ({ ...c, [id]: v }))}
          />
        ) : plan.isError ? (
          <ErrorNotice
            description={moveError(plan.error, 'Could not plan this move')}
            onRetry={() => void plan.refetch()}
          />
        ) : plan.fetchStatus !== 'idle' ? (
          <PlanReading />
        ) : null)}
      {target && p && (
        <div className='flex items-center gap-2'>
          <button
            type='button'
            className={ghostButton}
            disabled={plan.isFetching}
            onClick={() => void plan.refetch()}
          >
            <RotateCcw
              className={cn('h-3.5 w-3.5', plan.isFetching && 'animate-spin')}
              aria-hidden
            />
            {plan.isFetching ? 'Checking again…' : 'Plan again'}
          </button>
          <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
            The plan is read once; ask again after you change something.
          </span>
        </div>
      )}

      {target && (
        <div className='space-y-1.5'>
          <label
            htmlFor={`${idPrefix}-confirm`}
            className='block text-[12px] font-medium text-slate-700 dark:text-foreground'
          >
            Type <code className='font-mono font-semibold'>{expected}</code> to move it
          </label>
          <Input
            id={`${idPrefix}-confirm`}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete='off'
            spellCheck={false}
            placeholder={expected}
            className='h-8 max-w-[320px] bg-white font-mono text-[13px] dark:bg-background'
          />
        </div>
      )}

      <div className='flex flex-wrap items-center gap-2'>
        <Button
          size='sm'
          className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
          disabled={!ready || start.isPending}
          onClick={() => start.mutate()}
        >
          {start.isPending ? 'Starting…' : 'Start move'}
        </Button>
        <Button size='sm' variant='ghost' className='h-8' disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        {p && p.blockers.length === 0 && requiredOpen && (
          <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
            Tick every required item first.
          </span>
        )}
      </div>
    </div>
  )
}

/** While a plan is read: both sides are asked live, which can take most of a minute. */
function PlanReading() {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => setSeconds((n) => n + 1), 1000)
    return () => window.clearInterval(t)
  }, [])
  return (
    <div role='status' className='space-y-2'>
      <p className='m-0 flex items-center gap-2 text-[12px] text-slate-600 dark:text-slate-300'>
        <Loader2 className='h-3.5 w-3.5 animate-spin text-sky-600 dark:text-sky-400' aria-hidden />
        Checking both sides: the app, its database and the target. This can take up to a minute
        {seconds >= 5 ? ` (${seconds} s so far)` : ''}.
      </p>
      <Skeleton className='h-20 w-full' />
    </div>
  )
}

const ROUTING_BADGE = {
  automatic: {
    label: 'Automatic address change',
    tip: 'The Hub changes the routing itself.',
    tone: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300'
  },
  manual: {
    label: 'Manual address change',
    tip: 'Someone outside the Hub changes DNS or the proxy; the Hub waits up to 24 hours.',
    tone: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300'
  }
} as const

function MovePlanView({
  plan,
  env,
  idPrefix,
  checked,
  onCheck
}: {
  plan: MovePlan
  env: HubEnvironment
  idPrefix: string
  checked: Record<string, boolean>
  onCheck: (id: string, v: boolean) => void
}) {
  const badge = ROUTING_BADGE[plan.routing] ?? ROUTING_BADGE.manual
  const needsKey = plan.blockers.some(
    (b) => b.code === 'APP_KEY_UNKNOWN' || b.code === 'APP_KEY_MISMATCH'
  )
  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-slate-700 dark:text-slate-300'>
        <span className='font-medium text-slate-900 dark:text-foreground'>
          {MOVE_KIND_WORDS[plan.kind] ?? plan.kind}
        </span>
        <span
          data-tip={badge.tip}
          className={cn('rounded-full border px-2 py-px text-[11px] font-medium', badge.tone)}
        >
          {badge.label}
        </span>
        <span>
          Version <span className='font-mono'>{plan.version}</span> (unchanged)
        </span>
        <span>
          {plan.files.count.toLocaleString()} {plan.files.count === 1 ? 'file' : 'files'} ·{' '}
          {formatBytes(plan.files.bytes)}
        </span>
      </div>

      {plan.blockers.length > 0 && (
        <div
          role='alert'
          className='rounded-md border border-red-200 bg-red-50 px-3 py-2 dark:border-red-900/60 dark:bg-red-950/40'
        >
          <p className='m-0 text-[12px] font-semibold text-red-800 dark:text-red-200'>
            This cannot start yet
          </p>
          <IssueList issues={plan.blockers} level='blocker' />
        </div>
      )}
      {needsKey && <HubAppKeyField envId={env.id} idPrefix={`${idPrefix}-plan`} />}

      {plan.warnings.length > 0 && (
        <div className='rounded-md border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-900/60 dark:bg-amber-950/40'>
          <p className='m-0 text-[12px] font-semibold text-amber-900 dark:text-amber-200'>
            Good to know before you move
          </p>
          <IssueList issues={plan.warnings} level='warning' />
        </div>
      )}

      {plan.routing === 'manual' && plan.manual_request && (
        <ManualRequest text={plan.manual_request} />
      )}

      <ChecklistGroup
        title='Confirm before moving'
        note={(n) => `${n.done} of ${n.total} ticked. Start stays off until every one is.`}
        items={plan.checklist.filter((c) => c.required)}
        idPrefix={idPrefix}
        checked={checked}
        onCheck={onCheck}
      />
      <ChecklistGroup
        title='After the move'
        items={plan.checklist.filter((c) => !c.required)}
        idPrefix={idPrefix}
        checked={checked}
        onCheck={onCheck}
      />
    </div>
  )
}

/**
 * Checklist items in one block. Required ones (each fact the Hub could not check adds one, so a
 * move may carry several) gate Start; the others are reminders for after the move.
 */
function ChecklistGroup({
  title,
  note,
  items,
  idPrefix,
  checked,
  onCheck
}: {
  title: string
  note?: (n: { done: number; total: number }) => string
  items: { id: string; text: string; required: boolean }[]
  idPrefix: string
  checked: Record<string, boolean>
  onCheck: (id: string, v: boolean) => void
}) {
  if (items.length === 0) return null
  const done = items.filter((c) => checked[c.id]).length
  return (
    <fieldset className='m-0 space-y-1.5 rounded-md border border-slate-200 bg-white px-3 py-2 dark:border-border dark:bg-card'>
      <legend className='px-1 text-[12px] font-semibold text-slate-800 dark:text-foreground'>
        {title}
      </legend>
      {note && (
        <p className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
          {note({ done, total: items.length })}
        </p>
      )}
      {items.map((c) => {
        const id = `${idPrefix}-check-${c.id}`
        return (
          <div key={c.id} className='flex items-start gap-2 text-[12px]'>
            <Checkbox
              id={id}
              checked={!!checked[c.id]}
              onCheckedChange={(v) => onCheck(c.id, v === true)}
              className='mt-0.5'
            />
            <label htmlFor={id} className='min-w-0 break-words text-slate-700 dark:text-slate-300'>
              {c.text}
            </label>
          </div>
        )
      })}
    </fieldset>
  )
}

function IssueList({ issues, level }: { issues: MoveIssue[]; level: 'blocker' | 'warning' }) {
  const red = level === 'blocker'
  return (
    <ul className='m-0 mt-1 list-none space-y-1.5 p-0'>
      {issues.map((b, i) => {
        const copy = moveIssueCopy(b, level)
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: the planner may repeat a code
          <li key={i} className='text-[12px]'>
            <span
              className={cn(
                'block font-medium',
                red ? 'text-red-800 dark:text-red-200' : 'text-amber-900 dark:text-amber-200'
              )}
            >
              {copy.title}
            </span>
            {copy.hint && (
              <span
                className={cn(
                  'block',
                  red
                    ? 'text-red-700/90 dark:text-red-300/90'
                    : 'text-amber-800 dark:text-amber-300'
                )}
              >
                {copy.hint}
              </span>
            )}
            {copy.detail && (
              <span className='mt-0.5 block break-words text-[11px] text-slate-600 dark:text-slate-400'>
                {copy.detail}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function ManualRequest({ text }: { text: string }) {
  return (
    <div className='space-y-1.5 rounded-md border border-slate-200 bg-white px-3 py-2 dark:border-border dark:bg-card'>
      <div className='flex items-center gap-2'>
        <p className='m-0 flex-1 text-[12px] font-semibold text-slate-800 dark:text-foreground'>
          Address change request
        </p>
        <CopyButton value={text} label='Copy the request' />
      </div>
      <p className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
        Send this to whoever runs DNS and the proxy. The old home keeps serving until the address
        answers from the target.
      </p>
      <pre className='m-0 whitespace-pre-wrap break-words rounded bg-slate-50 px-2 py-1.5 font-mono text-[11px] text-slate-800 dark:bg-muted dark:text-slate-200'>
        {text}
      </pre>
    </div>
  )
}

// ─── After start: steps, files, address wait, cancel / resume / roll back ─────

function StepIcon({ state }: { state: MoveStepState }) {
  if (state === 'done')
    return <Check className='h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400' aria-hidden />
  if (state === 'running')
    return (
      <Loader2 className='h-3.5 w-3.5 animate-spin text-sky-600 dark:text-sky-400' aria-hidden />
    )
  if (state === 'waiting')
    return <Clock className='h-3.5 w-3.5 text-amber-600 dark:text-amber-400' aria-hidden />
  if (state === 'failed')
    return <X className='h-3.5 w-3.5 text-red-600 dark:text-red-400' aria-hidden />
  if (state === 'undone')
    return <Undo2 className='h-3.5 w-3.5 text-slate-500 dark:text-muted-foreground' aria-hidden />
  return <Circle className='h-3 w-3 text-slate-300 dark:text-slate-600' aria-hidden />
}

const STEP_STATE_WORDS: Record<MoveStepState, string> = {
  done: 'done',
  running: 'in progress',
  waiting: 'waiting',
  failed: 'failed',
  undone: 'undone',
  pending: 'not started'
}

const MAX_READ_FAILURES = 3

function MoveProgress({
  moveId,
  env,
  onDismiss
}: {
  moveId: number
  env: HubEnvironment
  /** The move ended and the person is done with it: show the form for a new move. */
  onDismiss: () => void
}) {
  const qc = useQueryClient()
  const failures = useRef(0)
  const q = useQuery({
    queryKey: moveKeys.move(moveId),
    queryFn: async () => {
      try {
        const m = await fetchMove(moveId)
        failures.current = 0
        return m
      } catch (err) {
        failures.current += 1
        throw err
      }
    },
    refetchInterval: (query) => {
      if (query.state.status === 'error' && !query.state.data) return false
      if (failures.current >= MAX_READ_FAILURES) return false
      const s = query.state.data?.status
      return !s || isLiveMove(s) ? 3000 : false
    }
  })
  const [routeNote, setRouteNote] = useState<string | null>(null)

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: moveKeys.move(moveId) })
    void qc.invalidateQueries({ queryKey: moveKeys.moves(env.id) })
  }
  const cancel = useMutation({
    mutationFn: () => cancelMove(moveId),
    onSuccess: refresh,
    onError: (err) => {
      refresh()
      moveToast(err, 'Could not cancel the move')
    }
  })
  const resume = useMutation({
    mutationFn: () => resumeMove(moveId),
    onSuccess: refresh,
    onError: (err) => moveToast(err, 'Could not resume the move')
  })
  const rollback = useMutation({
    mutationFn: () => rollbackMove(moveId),
    onSuccess: refresh,
    onError: (err) => moveToast(err, 'Could not roll the move back')
  })
  const checkRoute = useMutation({
    mutationFn: () => confirmMoveRoute(moveId),
    onSuccess: (r) => {
      setRouteNote(
        r.serving
          ? 'The address answers from the target. The move goes on.'
          : 'The address still answers from the old home. Check again once the change is made.'
      )
      refresh()
    },
    onError: (err) => moveToast(err, 'Could not check the address')
  })
  const tick = useMutation({
    mutationFn: (v: { item: string; done: boolean }) => setMoveChecklist(moveId, v.item, v.done),
    onSuccess: refresh,
    onError: (err) => moveToast(err, 'Could not save the checklist')
  })

  // When it finishes, where the environment runs and its history have changed.
  const status = q.data?.status
  const wasLive = useRef<boolean | null>(null)
  useEffect(() => {
    if (!status) return
    const live = isLiveMove(status)
    if (wasLive.current === true && !live) {
      void qc.invalidateQueries({ queryKey: hubKeys.app(env.app_id) })
      void qc.invalidateQueries({ queryKey: hubKeys.envStatus(env.id) })
      void qc.invalidateQueries({ queryKey: hubKeys.promotions(env.id) })
      void qc.invalidateQueries({ queryKey: moveKeys.moves(env.id) })
      if (status === 'success') toast.success(`${env.key} moved`)
    }
    wasLive.current = live
  }, [status, env, qc])

  if (q.isPending) return <Skeleton className='h-24 w-full' />
  if (!q.data)
    return (
      <ErrorNotice
        description={moveError(q.error, 'Could not read the move')}
        onRetry={() => {
          failures.current = 0
          void q.refetch()
        }}
      />
    )

  const m = q.data
  const rows = moveStepRows(m)
  const plan = movePlanOf(m)
  const files = moveFilesOf(m)
  const past = pastRelease(m)
  const live = isLiveMove(m.status)
  const undoing = live && isRollingBack(m)
  const checklist = moveChecklistOf(m)
  const total = files?.total ?? 0
  const moved = (files?.copied ?? 0) + (files?.skipped ?? 0)
  const pct = total > 0 ? Math.min(100, Math.round((moved / total) * 100)) : 0

  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]'>
        <span className='font-medium text-slate-900 dark:text-foreground'>
          {MOVE_KIND_WORDS[m.kind] ?? m.kind}
        </span>
        <span role='status' className={cn('font-medium', moveStatusTone(m.status))}>
          {moveStatusWords(m.status)}
        </span>
        {m.started_at && (
          <span
            className='text-slate-500 dark:text-muted-foreground'
            data-tip={formatDateTime(m.started_at)}
          >
            started {formatRelative(m.started_at)}
          </span>
        )}
      </div>

      <ol aria-label='Move steps' className='m-0 list-none space-y-1.5 p-0'>
        {rows.map((r) => (
          <li
            key={r.key}
            data-state={r.state}
            className={cn(
              'flex min-w-0 items-start gap-2 text-[12px]',
              r.state === 'pending'
                ? 'text-slate-500 dark:text-muted-foreground'
                : 'text-slate-800 dark:text-foreground',
              r.state === 'failed' && 'font-medium text-red-700 dark:text-red-300'
            )}
          >
            <span className='mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center'>
              <StepIcon state={r.state} />
            </span>
            <span className='min-w-0 break-words'>
              {r.label}
              <span className='sr-only'> — {STEP_STATE_WORDS[r.state]}</span>
            </span>
          </li>
        ))}
      </ol>

      {files && total > 0 && (
        <div className='space-y-1'>
          <div
            role='progressbar'
            aria-label='Files copied'
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            className='h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-muted'
          >
            <div
              className={cn(
                'h-full rounded-full transition-[width]',
                files.state === 'failed' ? 'bg-red-500' : 'bg-nvr-cyan'
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
            {moved.toLocaleString()} of {total.toLocaleString()} files ·{' '}
            {formatBytes(files.bytes ?? 0)} copied
            {(files.failed ?? 0) > 0 && (
              <span className='text-red-700 dark:text-red-300'>
                {' '}
                · {files.failed} could not be copied
              </span>
            )}
          </p>
        </div>
      )}

      {m.status === 'waiting' && (
        <section
          aria-label='Waiting for the address'
          className='space-y-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-900/60 dark:bg-amber-950/40'
        >
          <p className='m-0 text-[12px] font-semibold text-amber-900 dark:text-amber-200'>
            Waiting for the address to change
          </p>
          <p className='m-0 text-[12px] text-amber-900 dark:text-amber-200'>
            The Hub cannot change this address itself. Send the request below; the old home keeps
            serving until the address answers from the target. The Hub checks on its own and gives
            up after 24 hours.
          </p>
          {plan?.manual_request && (
            <div className='flex flex-wrap items-start gap-2'>
              <pre className='m-0 min-w-0 flex-1 whitespace-pre-wrap break-words rounded bg-white px-2 py-1.5 font-mono text-[11px] text-slate-800 dark:bg-card dark:text-slate-200'>
                {plan.manual_request}
              </pre>
              <CopyButton value={plan.manual_request} label='Copy the request' />
            </div>
          )}
          <div className='flex flex-wrap items-center gap-2'>
            <Button
              size='sm'
              variant='outline'
              className='h-8'
              disabled={checkRoute.isPending}
              onClick={() => checkRoute.mutate()}
            >
              {checkRoute.isPending ? 'Checking…' : 'Check now'}
            </Button>
            {routeNote && (
              <span role='status' className='text-[12px] text-amber-900 dark:text-amber-200'>
                {routeNote}
              </span>
            )}
          </div>
        </section>
      )}

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
      {m.error && (
        // A move that succeeded with an error (the old home could not be retired) is a warning
        // to act on, not a failure: amber, with its checklist item below.
        <div
          className={cn(
            'rounded-md border px-3 py-2 text-[12px]',
            m.status === 'success'
              ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200'
              : 'border-red-200 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200'
          )}
          data-tone={m.status === 'success' ? 'warning' : 'error'}
        >
          <RunnerError text={m.error} />
        </div>
      )}
      {m.status === 'rolled_back' && (
        <p className='m-0 text-[12px] text-slate-600 dark:text-slate-300'>
          Rolled back: the app serves from its old home again. Files already copied stay on the
          target.
        </p>
      )}

      {m.status === 'interrupted' && (
        <div className='space-y-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-900/60 dark:bg-amber-950/40'>
          <p className='m-0 text-[12px] text-amber-900 dark:text-amber-200'>
            The Hub stopped hearing from this move (it restarted, or the run was cut off).{' '}
            {past
              ? 'The app already serves from its new home; Resume finishes what is left.'
              : isRollingBack(m)
                ? 'It was rolling back when it stopped. Resume and Roll back both go on undoing its steps; the app ends on its old home.'
                : 'Resume goes on from the step it stopped at; Roll back puts the app back on its old home.'}
          </p>
          <div className='flex flex-wrap items-center gap-2'>
            <Button
              size='sm'
              aria-label='Resume'
              className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
              disabled={resume.isPending || rollback.isPending}
              onClick={() => resume.mutate()}
            >
              <Play className='h-3.5 w-3.5' aria-hidden /> Resume
            </Button>
            {!past && (
              <ConfirmButton
                title='Roll back'
                confirmLabel='Roll back the move?'
                className={dangerGhost}
                armedClassName={dangerArmed}
                disabled={rollback.isPending || resume.isPending}
                onConfirm={() => rollback.mutate()}
              >
                <RotateCcw className='h-3.5 w-3.5' aria-hidden /> Roll back
              </ConfirmButton>
            )}
          </div>
        </div>
      )}

      {m.status === 'success' && checklist.some((c) => !c.done) && (
        <fieldset className='m-0 space-y-1.5 border-0 p-0'>
          <legend className='mb-1 p-0 text-[12px] font-semibold text-slate-800 dark:text-foreground'>
            Still to do
          </legend>
          {checklist
            .filter((c) => !c.done)
            .map((c) => {
              const id = `move-${moveId}-done-${c.id}`
              return (
                <div key={c.id} className='flex items-start gap-2 text-[12px]'>
                  <Checkbox
                    id={id}
                    checked={false}
                    disabled={tick.isPending}
                    onCheckedChange={(v) => tick.mutate({ item: c.id, done: v === true })}
                    className='mt-0.5'
                  />
                  <label
                    htmlFor={id}
                    className='min-w-0 break-words text-slate-700 dark:text-slate-300'
                  >
                    {c.text}
                  </label>
                </div>
              )
            })}
        </fieldset>
      )}

      <div className='flex flex-wrap items-center gap-2'>
        {undoing ? (
          <span role='status' className='text-[12px] text-slate-600 dark:text-slate-300'>
            Rolling back: undoing each step it took, newest first.
          </span>
        ) : live && past ? (
          // After release there is nothing to roll back to and the Hub refuses a cancel
          // (TOO_LATE): say so instead of offering a button that can only refuse.
          <span role='status' className='text-[12px] text-slate-600 dark:text-slate-300'>
            The app already serves from its new home, so this move can no longer be cancelled or
            rolled back. The Hub finishes retiring the old home.
          </span>
        ) : live ? (
          <>
            <ConfirmButton
              title='Cancel move'
              confirmLabel='Roll back?'
              className={dangerGhost}
              armedClassName={dangerArmed}
              disabled={cancel.isPending}
              onConfirm={() => cancel.mutate()}
            >
              <Ban className='h-3.5 w-3.5' aria-hidden /> Cancel
            </ConfirmButton>
            <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
              Cancel rolls the move back: the app stays on its old home and leaves maintenance.
            </span>
          </>
        ) : m.status !== 'interrupted' ? (
          <Button size='sm' variant='ghost' className='h-8' onClick={onDismiss}>
            Dismiss
          </Button>
        ) : null}
        {plan && (
          <span className='ml-auto flex items-center gap-1 text-[11px] text-slate-500 dark:text-muted-foreground'>
            <span className='font-mono'>{plan.version}</span>
            <ArrowRight className='h-3 w-3' aria-hidden />
            {plan.hostnames.join(', ') || env.base_url}
          </span>
        )}
      </div>
    </div>
  )
}
