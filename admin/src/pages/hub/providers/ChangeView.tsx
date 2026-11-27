import { ConfirmButton, ErrorNotice } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Ban,
  Check,
  Circle,
  CircleDashed,
  Loader2,
  ShieldAlert,
  X
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { HubRunTimeline, type RunStep } from '@/components/hub-brand/HubRunTimeline'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { cn, formatDateTime, formatRelative } from '@/lib/utils'
import { dangerArmed, dangerGhost, ghostButton, SectionCard, ToneChip } from '../hub-parts'
import {
  CHANGE_STATUS_COPY,
  CHANGE_STATUS_TONE,
  type ChangeFilter,
  type ChangeModel,
  type ChangeStep,
  type ChangeVerb,
  changeAction,
  changeFromPlan,
  changeFromRow,
  displayValue,
  type FieldSpec,
  fetchChange,
  fetchChanges,
  fetchProviderTypes,
  fieldLabel,
  fieldSpecAt,
  type HubResourceChange,
  isLiveChange,
  isResumable,
  OP_KIND_COPY,
  OPEN_CHANGE_STATUSES,
  type PlannedOp,
  PROVIDER_CODE_COPY,
  providerError,
  providerKeys,
  providerToast,
  RISK_COPY,
  type RiskFlag,
  typeIndex
} from './providers-api'

/**
 * One change from plan to result: what it will do (each operation with its reason, the fields
 * it changes and what it risks), the gates it passed, then start — with the typed name when
 * anything is removed, or "Request approval" when an owner's change costs money — then the live
 * steps and the result, with resume, cancel and undo where they apply.
 */
export function ChangeView({
  initial,
  isAdmin,
  onClose,
  onReplace,
  onFinished,
  framed = true
}: {
  initial: ChangeModel
  isAdmin: boolean
  onClose: () => void
  /** false = inside a card that already names the change and closes it (the ?change= panel). */
  framed?: boolean
  /** Undo answers a NEW change: the view switches to it. */
  onReplace?: (next: ChangeModel) => void
  /** Called once when the change reaches applied / cancelled / declined. */
  onFinished?: () => void
}) {
  const qc = useQueryClient()
  const id = initial.changeId
  const row = useQuery({
    queryKey: providerKeys.change(id),
    queryFn: () => fetchChange(id),
    retry: false,
    refetchInterval: (q) => (q.state.data && isLiveChange(q.state.data.status) ? 2000 : false)
  })
  const types = useQuery({ queryKey: providerKeys.types(), queryFn: fetchProviderTypes })
  const idx = typeIndex(types.data)
  const model = row.data ? changeFromRow(row.data) : initial
  const [confirm, setConfirm] = useState('')
  const [declining, setDeclining] = useState(false)
  const [reason, setReason] = useState('')
  const status = model.status

  const finished = status === 'applied' || status === 'cancelled' || status === 'declined'
  // biome-ignore lint/correctness/useExhaustiveDependencies: fire once per finish
  useEffect(() => {
    if (finished) onFinished?.()
  }, [finished])

  const refresh = (data?: ChangeModel) => {
    void qc.invalidateQueries({ queryKey: providerKeys.change(id) })
    void qc.invalidateQueries({ queryKey: ['hub-providers', 'resources'] })
    void qc.invalidateQueries({ queryKey: ['hub-providers', 'changes'] })
    return data
  }
  const act = useMutation({
    mutationFn: ({ verb, body }: { verb: ChangeVerb; body?: Record<string, unknown> }) =>
      changeAction(id, verb, body),
    onSuccess: (plan, { verb }) => {
      if (verb === 'undo' && plan.changeId !== id) {
        onReplace?.(changeFromPlan(plan))
        return
      }
      setDeclining(false)
      refresh()
    },
    onError: (err, { verb }) => {
      providerToast(err, VERB_FAIL[verb])
      // A stale plan or a moved resource: show the change as it stands now.
      refresh()
    }
  })

  const blocked = model.blockers.length > 0
  const confirmOk = !model.needsConfirm || confirm.trim() === model.needsConfirm
  const reversible = model.ops.every((op) => {
    const t = idx.type(op.type)
    return t?.reversible !== false
  })
  const steps = model.steps
  const resumable = isResumable(status, steps, model.resumable)
  const failedStep = [...steps].reverse().find((s) => s.status === 'failed') ?? null
  // One failure message: the notice below says it (with what to do); a step repeats it only when
  // it says something else.
  const noticeShown = (status === 'failed' || status === 'interrupted') && !!model.error
  const runSteps: RunStep[] = model.ops.map((op, i) => ({
    key: String(i),
    label: `${OP_KIND_COPY[op.kind]} ${idx.typeLabel(op.type)}`,
    short: OP_KIND_COPY[op.kind],
    state: runState(steps[i])
  }))
  const confirmId = `hub-change-${id}-confirm`
  const reasonId = `hub-change-${id}-reason`

  return (
    <section
      aria-label={`Change ${id}`}
      className={cn(
        'space-y-3',
        framed &&
          'rounded-lg border border-slate-200 bg-slate-50/60 p-3 dark:border-border dark:bg-muted/30'
      )}
    >
      <header className='flex flex-wrap items-center gap-2'>
        {framed && (
          <h5 className='m-0 text-[12px] font-semibold text-slate-800 dark:text-foreground'>
            {status === 'planned' ? 'The plan' : `Change #${id}`}
          </h5>
        )}
        {/* Said to screen readers as it moves (planned → running → done). */}
        <span role='status' aria-live='polite' className='inline-flex'>
          <ToneChip tone={CHANGE_STATUS_TONE[status] ?? 'neutral'}>
            {CHANGE_STATUS_COPY[status] ?? status}
          </ToneChip>
        </span>
        {model.createdAt && (
          <span
            className='text-[11px] text-slate-500 dark:text-muted-foreground'
            data-tip={formatDateTime(model.createdAt)}
          >
            {formatRelative(model.createdAt)}
          </span>
        )}
        {framed && (
          <button
            type='button'
            aria-label='Close the change'
            data-tip='Close'
            className={cn(ghostButton, 'ml-auto w-8 px-0')}
            onClick={onClose}
          >
            <X className='h-3.5 w-3.5' aria-hidden />
          </button>
        )}
      </header>

      {steps.length > 0 && (
        <HubRunTimeline steps={runSteps} live={isLiveChange(status)} what='Change' />
      )}

      {row.isPending && !initial.ops.length ? (
        <Skeleton className='h-16 w-full' />
      ) : model.ops.length === 0 ? (
        <p className='m-0 text-[12px] text-slate-600 dark:text-slate-300'>
          Nothing to do: the provider already has it this way.
        </p>
      ) : (
        <ol className='m-0 list-none space-y-2 p-0' aria-label='Operations'>
          {model.ops.map((op, i) => (
            <OpItem
              // biome-ignore lint/suspicious/noArrayIndexKey: ops are positional
              key={i}
              op={op}
              step={steps[i] ?? null}
              typeLabel={idx.typeLabel(op.type)}
              fields={idx.type(op.type)?.fields}
              changeError={noticeShown ? model.error : null}
            />
          ))}
        </ol>
      )}

      {model.gates.length > 0 && <Gates gates={model.gates} />}

      {blocked && (
        <div
          role='alert'
          className='space-y-1 rounded-md border border-red-200 bg-red-50 px-3 py-2 dark:border-red-900/60 dark:bg-red-950/40'
        >
          {model.blockers.map((b) => (
            <p key={b.code} className='m-0 text-[12px] text-red-800 dark:text-red-200'>
              <span className='font-medium'>{PROVIDER_CODE_COPY[b.code]?.title ?? 'Stopped'}:</span>{' '}
              {b.message}
            </p>
          ))}
        </div>
      )}

      {(status === 'failed' || status === 'interrupted') && model.error && (
        <ErrorNotice
          description={providerError(
            { response: { data: { code: model.errorCode ?? undefined, error: model.error } } },
            status === 'interrupted' ? 'The change stopped part way' : 'The change failed',
            status === 'failed' && failedStep?.error
              ? { retryable: failedStep.error.retryable }
              : {}
          )}
        />
      )}
      {status === 'declined' && (
        <p className='m-0 text-[12px] text-slate-700 dark:text-slate-300'>
          <span className='font-medium'>Declined.</span>{' '}
          {model.declineReason ? `“${model.declineReason}”` : ''}
        </p>
      )}
      {status === 'stale' && (
        <p role='status' className='m-0 text-[12px] text-amber-800 dark:text-amber-300'>
          The resource changed since this plan was made. Close it and plan again.
        </p>
      )}

      {/* ── Actions by status ── */}
      {status === 'planned' && !blocked && model.ops.some((o) => o.kind !== 'noop') && (
        <div className='space-y-2'>
          {model.needsConfirm && (
            <div className='space-y-1.5'>
              <label
                htmlFor={confirmId}
                className='block text-[12px] font-medium text-slate-700 dark:text-foreground'
              >
                Type <code className='font-mono font-semibold'>{model.needsConfirm}</code> to start
              </label>
              <Input
                id={confirmId}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete='off'
                spellCheck={false}
                placeholder='Type it here'
                className='h-8 max-w-[320px] bg-white font-mono text-[13px] dark:bg-background'
              />
            </div>
          )}
          {model.needsApproval && (
            <p className='m-0 text-[12px] text-slate-600 dark:text-slate-300'>
              This change costs money every month. A Hub administrator approves it before it runs;
              you are told either way.
            </p>
          )}
          <div className='flex flex-wrap items-center gap-2'>
            <Button
              size='sm'
              className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
              disabled={!confirmOk || act.isPending}
              onClick={() =>
                act.mutate({
                  verb: 'start',
                  body: {
                    planHash: model.planHash,
                    ...(model.needsConfirm ? { confirm: confirm.trim() } : {})
                  }
                })
              }
            >
              {act.isPending
                ? 'Starting…'
                : model.needsApproval
                  ? 'Request approval'
                  : 'Start change'}
            </Button>
            <Button
              size='sm'
              variant='ghost'
              className='h-8'
              disabled={act.isPending}
              onClick={() => act.mutate({ verb: 'cancel' })}
            >
              Discard plan
            </Button>
          </div>
        </div>
      )}

      {status === 'pending_approval' &&
        (isAdmin ? (
          <div className='space-y-2'>
            <p className='m-0 text-[12px] text-slate-600 dark:text-slate-300'>
              An app owner asked for this change because it costs money. Approving starts it if the
              plan still holds; otherwise the owner plans again.
            </p>
            {declining ? (
              <div className='space-y-1.5'>
                <label
                  htmlFor={reasonId}
                  className='block text-[12px] font-medium text-slate-700 dark:text-foreground'
                >
                  Why not (the owner reads this)
                </label>
                <Textarea
                  id={reasonId}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  className='max-w-[480px] text-[13px]'
                />
                <div className='flex flex-wrap gap-2'>
                  <Button
                    size='sm'
                    variant='outline'
                    className='h-8'
                    disabled={!reason.trim() || act.isPending}
                    onClick={() => act.mutate({ verb: 'decline', body: { reason: reason.trim() } })}
                  >
                    Decline
                  </Button>
                  <Button
                    size='sm'
                    variant='ghost'
                    className='h-8'
                    onClick={() => setDeclining(false)}
                  >
                    Back
                  </Button>
                </div>
              </div>
            ) : (
              <div className='flex flex-wrap gap-2'>
                <Button
                  size='sm'
                  className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
                  disabled={act.isPending}
                  onClick={() =>
                    act.mutate({ verb: 'approve', body: { planHash: model.planHash } })
                  }
                >
                  Approve and start
                </Button>
                <Button
                  size='sm'
                  variant='outline'
                  className='h-8'
                  onClick={() => setDeclining(true)}
                >
                  Decline…
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className='flex flex-wrap items-center gap-2'>
            <p className='m-0 text-[12px] text-slate-600 dark:text-slate-300'>
              Waiting for a Hub administrator to approve it. You are told when they do.
            </p>
            <Button
              size='sm'
              variant='ghost'
              className='h-8'
              disabled={act.isPending}
              onClick={() => act.mutate({ verb: 'cancel' })}
            >
              Withdraw request
            </Button>
          </div>
        ))}

      {status === 'applying' && (
        <div className='flex flex-wrap items-center gap-2'>
          <p className='m-0 flex items-center gap-1.5 text-[12px] text-slate-600 dark:text-slate-300'>
            <Loader2 className='h-3.5 w-3.5 animate-spin motion-reduce:animate-none' aria-hidden />
            Running step by step. You can leave this page; it keeps going.
          </p>
          <ConfirmButton
            title='Stop after this step'
            confirmLabel='Stop after this step?'
            className={dangerGhost}
            armedClassName={dangerArmed}
            disabled={act.isPending}
            onConfirm={() => act.mutate({ verb: 'cancel' })}
          >
            Stop
          </ConfirmButton>
        </div>
      )}

      {(status === 'interrupted' || status === 'failed') && (
        <div className='flex flex-wrap items-center gap-2'>
          {resumable && (
            <Button
              size='sm'
              variant='outline'
              className='h-8'
              disabled={act.isPending}
              onClick={() => act.mutate({ verb: 'resume' })}
            >
              Resume
            </Button>
          )}
          <Button
            size='sm'
            variant='ghost'
            className='h-8'
            disabled={act.isPending}
            data-tip='Close it without running the rest. What already ran stays as it is.'
            onClick={() => act.mutate({ verb: 'cancel' })}
          >
            Drop this change
          </Button>
          <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            {resumable
              ? 'Resume runs only the steps that did not finish.'
              : failedStep?.error?.code === 'AUTH_FAILED'
                ? 'Change this connection’s keys under Connections, then come back to resume.'
                : 'A retry will not fix this. Fix the cause, then plan the change again.'}
          </span>
        </div>
      )}

      {status === 'applied' && (
        <div className='flex flex-wrap items-center gap-2'>
          {reversible ? (
            <Button
              size='sm'
              variant='outline'
              className='h-8'
              disabled={act.isPending}
              onClick={() => act.mutate({ verb: 'undo' })}
            >
              Plan undo
            </Button>
          ) : (
            <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
              The provider cannot undo this automatically.
            </span>
          )}
          <Button size='sm' variant='ghost' className='h-8' onClick={onClose}>
            Close
          </Button>
        </div>
      )}
    </section>
  )
}

const VERB_FAIL: Record<ChangeVerb, string> = {
  start: 'Could not start the change',
  cancel: 'Could not stop the change',
  resume: 'Could not resume the change',
  undo: 'Could not plan the undo',
  approve: 'Could not approve the change',
  decline: 'Could not decline the change'
}

function runState(step: ChangeStep | undefined): RunStep['state'] {
  switch (step?.status) {
    case 'done':
      return 'done'
    case 'running':
      return 'running'
    case 'failed':
      return 'failed'
    case 'skipped':
      return 'stopped'
    default:
      return 'pending'
  }
}

const KIND_TONE: Record<PlannedOp['kind'], string> = {
  create: 'border-emerald-200 text-emerald-800 dark:border-emerald-900/60 dark:text-emerald-300',
  update: 'border-slate-300 text-slate-700 dark:border-border dark:text-slate-200',
  replace: 'border-amber-300 text-amber-900 dark:border-amber-900/60 dark:text-amber-300',
  delete: 'border-red-300 text-red-700 dark:border-red-900/60 dark:text-red-300',
  noop: 'border-slate-200 text-slate-500 dark:border-border dark:text-muted-foreground'
}

function OpItem({
  op,
  step,
  typeLabel,
  fields,
  changeError
}: {
  op: PlannedOp
  step: ChangeStep | null
  typeLabel: string
  /** The type's fields: changes are named by their labels, values in their own words. */
  fields?: FieldSpec[]
  /** The change's own error when the notice already shows it (the step does not repeat it). */
  changeError: string | null
}) {
  const stepError =
    step?.error && (!changeError || step.error.message !== changeError) ? step.error : null
  return (
    <li className='rounded-md border border-slate-200 bg-white px-3 py-2 dark:border-border dark:bg-card'>
      <div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
        <span
          className={cn(
            'inline-flex shrink-0 items-center rounded border px-1.5 py-px text-[10.5px] font-semibold',
            KIND_TONE[op.kind]
          )}
        >
          {op.action ? actionWord(op.action) : OP_KIND_COPY[op.kind]}
        </span>
        <span className='text-[12px] font-medium text-slate-800 dark:text-foreground'>
          {typeLabel}
        </span>
        {op.externalId && (
          <span className='min-w-0 truncate font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
            {op.externalId}
          </span>
        )}
        {step && <StepState step={step} />}
      </div>
      <p className='m-0 mt-1 text-[12px] text-slate-700 dark:text-slate-300'>{op.reason}</p>
      {op.risk.length > 0 && <RiskChips risk={op.risk} />}
      {op.changes.length > 0 && (
        <table className='mt-2 w-full max-w-[760px] table-fixed text-[11.5px]'>
          <thead>
            <tr className='text-left text-[10.5px] font-medium text-slate-500 dark:text-muted-foreground'>
              <th className='w-[30%] py-0.5 pr-2 font-medium'>Field</th>
              <th className='w-[35%] py-0.5 pr-2 font-medium'>Now</th>
              <th className='w-[35%] py-0.5 font-medium'>After</th>
            </tr>
          </thead>
          <tbody>
            {op.changes.map((c) => (
              <tr key={c.field} className='border-t border-slate-100 align-top dark:border-border'>
                <td
                  className='break-words py-1 pr-2 text-slate-700 dark:text-slate-300'
                  data-tip={c.field}
                >
                  {fieldLabel(fields, c.field)}
                </td>
                {c.secret ? (
                  <td colSpan={2} className='py-1 text-slate-600 dark:text-slate-300'>
                    A new value is set (secrets are never shown)
                  </td>
                ) : (
                  <>
                    <td className='break-words py-1 pr-2 text-slate-500 dark:text-muted-foreground'>
                      <ChangeValue spec={fieldSpecAt(fields, c.field)} value={c.from} />
                    </td>
                    <td className='break-words py-1 text-slate-900 dark:text-foreground'>
                      <ChangeValue spec={fieldSpecAt(fields, c.field)} value={c.to} />
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {step?.snapshot && (
        <p className='m-0 mt-1 text-[11px] text-slate-600 dark:text-slate-300'>
          Kept before the change: {step.snapshot.label ?? step.snapshot.id}
        </p>
      )}
      {stepError && (
        <p className='m-0 mt-1 break-words text-[11.5px] text-red-700 dark:text-red-300'>
          {PROVIDER_CODE_COPY[stepError.code]?.title ?? 'This step failed'}: {stepError.message}
          {stepError.retryable ? ' Resume tries it again.' : ''}
        </p>
      )}
    </li>
  )
}

/**
 * One value in the change table: On / Off and choice labels in plain text; ids, names and
 * numbers (what someone may copy or compare) in the mono face.
 */
function ChangeValue({ spec, value }: { spec: FieldSpec | null; value: unknown }) {
  const text = displayValue(spec, value)
  const words =
    typeof value === 'boolean' ||
    (spec?.kind === 'enum' && typeof value === 'string') ||
    text === '—'
  return <span className={cn(!words && 'hub-fact font-mono')}>{text}</span>
}

const ACTION_WORDS: Record<string, string> = {
  dispatch: 'Run workflow',
  promote: 'Promote',
  rollback: 'Roll back',
  point: 'Point channel'
}
const actionWord = (a: string) => ACTION_WORDS[a] ?? a

function StepState({ step }: { step: ChangeStep }) {
  const map = {
    pending: { Icon: Circle, text: 'Waiting', cls: 'text-slate-500 dark:text-muted-foreground' },
    running: { Icon: Loader2, text: 'Running', cls: 'text-sky-700 dark:text-sky-300' },
    done: { Icon: Check, text: 'Done', cls: 'text-emerald-700 dark:text-emerald-300' },
    failed: { Icon: X, text: 'Failed', cls: 'text-red-700 dark:text-red-300' },
    skipped: {
      Icon: CircleDashed,
      text: 'Skipped',
      cls: 'text-slate-500 dark:text-muted-foreground'
    }
  }[step.status] ?? { Icon: Circle, text: step.status, cls: 'text-slate-500' }
  const { Icon, text, cls } = map
  return (
    <span className={cn('ml-auto inline-flex items-center gap-1 text-[11px] font-medium', cls)}>
      <Icon
        className={cn(
          'h-3 w-3',
          step.status === 'running' && 'animate-spin motion-reduce:animate-none'
        )}
        aria-hidden
      />
      {text}
    </span>
  )
}

export function RiskChips({ risk }: { risk: RiskFlag[] }) {
  return (
    <ul className='m-0 mt-1.5 flex list-none flex-wrap gap-1 p-0' aria-label='Risks'>
      {risk.map((r) => (
        <li key={r}>
          <ToneChip
            tone={r === 'cost' || r === 'downtime' ? 'warn' : 'down'}
            icon={r === 'public_exposure' ? ShieldAlert : AlertTriangle}
            tip={RISK_COPY[r]?.hint}
            compact
          >
            {RISK_COPY[r]?.label ?? r}
          </ToneChip>
        </li>
      ))}
    </ul>
  )
}

function Gates({ gates }: { gates: ChangeModel['gates'] }) {
  const failed = gates.filter((g) => !g.passed)
  const passed = gates.length - failed.length
  return (
    <div className='space-y-1'>
      {failed.map((g) => (
        <p
          key={g.code}
          className='m-0 flex items-start gap-1.5 text-[12px] text-red-700 dark:text-red-300'
        >
          <Ban className='mt-0.5 h-3.5 w-3.5 shrink-0' aria-hidden />
          <span>
            <span className='font-medium'>
              {PROVIDER_CODE_COPY[g.code]?.title ?? 'Not allowed'}.
            </span>{' '}
            {g.message}
          </span>
        </p>
      ))}
      {passed > 0 && (
        <details className='text-[12px] text-slate-600 dark:text-slate-300'>
          <summary className='cursor-pointer select-none'>
            <Check
              className='mr-1 inline h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400'
              aria-hidden
            />
            {passed === gates.length ? 'Every check passed' : `${passed} checks passed`}
          </summary>
          <ul className='m-0 mt-1 list-none space-y-0.5 pl-5'>
            {gates
              .filter((g) => g.passed)
              .map((g) => (
                <li key={g.code}>{g.message}</li>
              ))}
          </ul>
        </details>
      )}
    </div>
  )
}

/** A short line for a change in a list: its first operation and how many more. */
export function changeSummary(c: HubResourceChange, typeLabel: (t: string) => string): string {
  const ops = c.plan?.ops ?? []
  if (!ops.length) return 'No operations'
  const first = ops[0] as PlannedOp
  const req = c.plan?.request?.ops?.[c.plan?.sources?.[0] ?? 0]
  const named = req?.fields?.name
  const name = typeof named === 'string' && named ? named : (first.externalId ?? null)
  const head = `${first.action ? actionWord(first.action) : OP_KIND_COPY[first.kind]} ${typeLabel(first.type)}${name ? ` ${name}` : ''}`
  return ops.length > 1 ? `${head} and ${ops.length - 1} more` : head
}

/**
 * Changes as a list (newest first); one click opens it in the change view under the list. Used
 * for an environment's recent changes and the administrators' approval queue.
 */
export function ChangesList({
  filter,
  isAdmin,
  empty,
  label,
  openInLink = false,
  connectionName
}: {
  filter: ChangeFilter
  isAdmin: boolean
  /** Shown when there are none; null = render nothing then (and while loading). */
  empty: string | null
  label: string
  /** Open a change in the page's `?change=` panel (LinkedChange) instead of under the list. */
  openInLink?: boolean
  /** Names each row's connection (lists that span connections). */
  connectionName?: (id: number) => string | null
}) {
  const changes = useQuery({
    queryKey: providerKeys.changes(filter),
    queryFn: () => fetchChanges(filter),
    refetchInterval: (q) => (q.state.data?.some((c) => isLiveChange(c.status)) ? 5000 : false)
  })
  const types = useQuery({ queryKey: providerKeys.types(), queryFn: fetchProviderTypes })
  const idx = typeIndex(types.data)
  const [open, setOpen] = useState<ChangeModel | null>(null)
  const [params, setParams] = useSearchParams()
  const linked = params.get('change')

  if (changes.isPending) return empty == null ? null : <Skeleton className='h-10 w-full' />
  if (changes.isError)
    return (
      <ErrorNotice
        description={providerError(changes.error, 'Could not read the changes')}
        onRetry={() => void changes.refetch()}
      />
    )
  if (changes.data.length === 0)
    return empty == null ? null : (
      <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>{empty}</p>
    )
  return (
    <div className='space-y-2'>
      <ul
        aria-label={label}
        className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'
      >
        {changes.data.map((c) => {
          const active = openInLink ? linked === String(c.id) : open?.changeId === c.id
          const where = connectionName?.(c.connection_id)
          return (
            <li key={c.id}>
              <button
                type='button'
                aria-expanded={openInLink ? undefined : active}
                aria-current={openInLink && active ? 'true' : undefined}
                onClick={() => {
                  if (!openInLink) return setOpen(active ? null : changeFromRow(c))
                  setParams(
                    (prev) => {
                      const next = new URLSearchParams(prev)
                      next.set('change', String(c.id))
                      return next
                    },
                    { replace: true }
                  )
                }}
                className={cn(
                  'flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded px-1.5 py-1.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
                  active && 'bg-accent'
                )}
              >
                <ToneChip tone={CHANGE_STATUS_TONE[c.status] ?? 'neutral'} compact>
                  {CHANGE_STATUS_COPY[c.status] ?? c.status}
                </ToneChip>
                <span className='min-w-0 flex-1 truncate text-[12px] text-slate-800 dark:text-foreground'>
                  {changeSummary(c, idx.typeLabel)}
                  {where && (
                    <span className='text-slate-500 dark:text-muted-foreground'> · {where}</span>
                  )}
                </span>
                {c.created_at && (
                  <span className='shrink-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
                    {formatRelative(c.created_at)}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
      {open && !openInLink && (
        <ChangeView
          key={open.changeId}
          initial={open}
          isAdmin={isAdmin}
          onClose={() => setOpen(null)}
          onReplace={setOpen}
        />
      )}
    </div>
  )
}

/**
 * Every change someone still has to act on — planned, waiting for approval, running, failed,
 * interrupted — so a plan left open on another page is never lost. Each opens in the page's
 * `?change=` panel. Renders nothing while there are none.
 */
export function OpenChanges({
  filter,
  description,
  connectionName
}: {
  filter: Omit<ChangeFilter, 'status'>
  description: string
  connectionName?: (id: number) => string | null
}) {
  const f: ChangeFilter = { ...filter, status: OPEN_CHANGE_STATUSES, limit: 25 }
  const changes = useQuery({
    queryKey: providerKeys.changes(f),
    queryFn: () => fetchChanges(f),
    refetchInterval: (q) => (q.state.data?.some((c) => isLiveChange(c.status)) ? 5000 : false)
  })
  const n = changes.data?.length ?? 0
  if (!changes.isError && n === 0) return null
  return (
    <SectionCard
      title='Open changes'
      description={description}
      actions={
        n > 0 ? (
          <span className='text-[12px] tabular-nums text-slate-500 dark:text-muted-foreground'>
            {n === 25 ? '25+' : n}
          </span>
        ) : undefined
      }
    >
      <div className='px-4 py-2'>
        <ChangesList
          filter={f}
          isAdmin
          label='Open changes'
          empty={null}
          openInLink
          connectionName={connectionName}
        />
      </div>
    </SectionCard>
  )
}

/**
 * The change named by `?change=<id>` (the link in a change notice): shown above the tab's own
 * content as one panel with the usual change view, closed by dropping the parameter. An id that
 * is not a whole number, or a change the person may not read, says so instead of going blank.
 */
export function LinkedChange({ isAdmin }: { isAdmin: boolean }) {
  const [params, setParams] = useSearchParams()
  const raw = params.get('change')
  const id = raw && /^\d+$/.test(raw) ? Number(raw) : null
  const box = useRef<HTMLDivElement>(null)
  // Opened from a list further down the page: bring the panel into view.
  useEffect(() => {
    if (raw == null) return
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    box.current?.scrollIntoView?.({ block: 'start', behavior: still ? 'auto' : 'smooth' })
  }, [raw])
  const row = useQuery({
    queryKey: providerKeys.change(id ?? 0),
    queryFn: () => fetchChange(id as number),
    enabled: id != null,
    retry: false
  })
  if (raw == null) return null
  const close = () =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('change')
        return next
      },
      { replace: true }
    )
  return (
    <div ref={box} className='scroll-mt-4'>
      <SectionCard
        title={
          id != null
            ? row.data?.status === 'planned'
              ? `The plan · change ${id}`
              : `Change ${id}`
            : 'Change'
        }
        actions={
          <button type='button' className={ghostButton} onClick={close}>
            <X className='h-3.5 w-3.5' aria-hidden /> Close
          </button>
        }
      >
        <div className='px-4 py-3'>
          {id == null ? (
            <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
              “{raw}” is not a change number.
            </p>
          ) : row.isPending ? (
            <Skeleton className='h-16 w-full' />
          ) : row.isError ? (
            <ErrorNotice
              description={providerError(row.error, 'Could not open that change')}
              onRetry={() => void row.refetch()}
            />
          ) : (
            <ChangeView
              key={row.data.id}
              initial={changeFromRow(row.data)}
              isAdmin={isAdmin}
              onClose={close}
              framed={false}
              onReplace={(next) => setParams({ change: String(next.changeId) }, { replace: true })}
            />
          )}
        </div>
      </SectionCard>
    </div>
  )
}
