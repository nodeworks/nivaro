import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Check,
  CircleSlash,
  Clock,
  Loader2,
  MessageSquareText,
  Pencil,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Undo2
} from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useItemEditAuth, useOptionalNivaroClient } from '../../context'
import { get, patch, post } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { SimpleSelect } from '../ui/SimpleSelect'
import { Skeleton } from '../ui/skeleton'
import { Textarea } from '../ui/textarea'
import { type AiPlan, AiPlanCard, type AiPlanStep, type AiPlanSubscribe } from './AiPlanCard'

/**
 * "Let AI do this" on a task or a support ticket (#2862–#2866). The button
 * shows for the person the work is assigned to when an administrator turned
 * the feature on for that kind; the panel beside it asks the model for a
 * plan (built and previewed as them by the plan engine), shows the review
 * figures — run time, hands-on time saved, what each step touches, the risk
 * and what cannot be rolled back — and then hands over to the plan card
 * (approve now / later, live progress, retry). After it ran: mark the task
 * done, draft a reply to the requester (tickets), or undo what AI did.
 */

export interface TaskDoTask {
  id: number
  /** 'support' = a ticket; anything else = a task. */
  kind?: string | null
  status: string
  assignee?: string | null
  category_id?: number | null
  title?: string
}

interface Availability {
  tasks: boolean
  tickets: boolean
  ticket_categories: number[]
}

interface TaskAccess {
  ok: boolean
  kind: 'task' | 'ticket'
  reason?: string
  code?: string
  plans: Array<{ plan_id: string; title: string; status: string; created_at: string | null }>
}

interface Question {
  id: string
  text: string
  options?: string[]
}

type Draft =
  | { kind: 'plan'; plan: TaskDoPlan }
  | { kind: 'questions'; questions: Question[]; note: string | null }
  | { kind: 'cannot'; reason: string; checklist: string[] }

interface StepTouches {
  step_id: string
  n: number
  kind: string
  collection: string | null
  records: number
  fields: Array<{ field: string; from?: unknown; to: unknown }>
  people: number
  external: boolean
  email: boolean
  irreversible: string | null
}

export interface TaskDoPlan extends AiPlan {
  review: {
    touches: StepTouches[]
    estimate: {
      run_seconds: number
      run_basis: 'recent runs' | 'default'
      hands_on_minutes: number | null
    }
    risk: {
      level: 'low' | 'medium' | 'high'
      reasons: string[]
      irreversible: Array<{ n: number; title: string; why: string }>
      records: number
      collections: number
    }
  }
  task_do: { task_id: number; kind: 'task' | 'ticket'; hands_on_minutes: number | null } | null
  approval: {
    required: boolean
    reason: string
    approvers: string[]
    records?: number
    approved_by?: string | null
    approved_at?: string | null
    superseded?: string | null
  } | null
  can_approve: boolean
  can_undo: boolean
  undo_until: string | null
}

interface UndoRecord {
  id: string
  collection: string
  label: string
  status: 'revertible' | 'changed' | 'gone' | 'undone'
  reason?: string
}
interface UndoStep {
  step_id: string
  n: number
  title: string
  kind_label: string
  not_revertible?: string
  revertible: number
  blocked: number
  undone_at: string | null
  records: UndoRecord[]
}

const LIVE = new Set(['proposed', 'scheduled', 'running', 'paused', 'failed', 'executed'])
const EDITABLE_FREE: Record<string, string[]> = {
  send_message: ['subject', 'message'],
  create_task: ['title', 'due_date', 'priority']
}

function errText(err: unknown): string {
  return (
    (err as { response?: { error?: string } })?.response?.error ??
    ((err as Error)?.message || 'The request failed')
  )
}

function fmt(v: unknown): string {
  if (v == null || v === '') return 'blank'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** `completed_on` → "Completed on" — the plan payload carries keys, not labels. */
function fieldLabel(k: string): string {
  const s = k.replace(/_/g, ' ').trim()
  return s ? s[0].toUpperCase() + s.slice(1) : k
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`

export function humanSeconds(s: number): string {
  if (s < 60) return `${Math.max(1, Math.round(s))} s`
  if (s < 3600) return `${Math.round(s / 60)} min`
  return `${Math.round(s / 360) / 10} h`
}

export function humanMinutes(m: number): string {
  if (m < 60) return `${Math.round(m)} min`
  return `${Math.round(m / 6) / 10} h`
}

/** What an administrator turned on for this person — one read, shared by every button. */
export function useTaskDoAvailable(): Availability | null {
  const client = useOptionalNivaroClient()
  const q = useQuery({
    queryKey: ['task-do', 'me'],
    queryFn: () =>
      client!.request<{ data: Availability }>(get('/ai/task-do/me')).then((r) => r.data),
    enabled: !!client,
    staleTime: 5 * 60_000,
    retry: false
  })
  return q.data ?? null
}

export function taskDoAllowed(
  avail: Availability | null,
  task: TaskDoTask,
  userId: string,
  isAssignee?: boolean
): boolean {
  if (!avail) return false
  if (task.status !== 'open' && task.status !== 'in_progress') return false
  const ticket = task.kind === 'support'
  if (ticket ? !avail.tickets : !avail.tasks) return false
  if (
    ticket &&
    avail.ticket_categories.length > 0 &&
    !avail.ticket_categories.includes(Number(task.category_id))
  )
    return false
  if (isAssignee != null) return isAssignee
  return !!userId && !!task.assignee && task.assignee.toUpperCase() === userId.toUpperCase()
}

/**
 * The button + its anchored panel. Renders nothing unless this person may
 * ask (the server re-checks everything, delegates included).
 */
export function TaskDoButton({
  task,
  isAssignee,
  subscribe,
  compact,
  onTaskChanged,
  className
}: {
  task: TaskDoTask
  /** The host already knows (My Work lists only this person's tasks). */
  isAssignee?: boolean
  subscribe?: AiPlanSubscribe
  /** Icon-only (list rows). */
  compact?: boolean
  /** The task was completed / a reply was sent from the panel. */
  onTaskChanged?: () => void
  className?: string
}) {
  const client = useOptionalNivaroClient()
  const { userId } = useItemEditAuth()
  const avail = useTaskDoAvailable()
  const [open, setOpen] = useState(false)
  if (!client || !taskDoAllowed(avail, task, userId, isAssignee)) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {compact ? (
          <button
            type='button'
            className={cn(
              'rounded p-1 text-slate-400 transition-colors hover:bg-muted hover:text-nvr-navy dark:hover:text-nvr-cyan',
              open && 'bg-muted text-nvr-navy dark:text-nvr-cyan',
              className
            )}
            aria-label='Let AI do this'
            data-tip='Let AI do this'
            data-task-do={task.id}
          >
            <Sparkles className='h-3.5 w-3.5' />
          </button>
        ) : (
          <Button
            type='button'
            size='sm'
            variant='outline'
            className={cn('h-7 gap-1.5 px-2.5 text-[12px]', className)}
            data-task-do={task.id}
          >
            <Sparkles className='h-3.5 w-3.5 text-nvr-navy dark:text-nvr-cyan' />
            Let AI do this
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align='end'
        collisionPadding={16}
        className='w-[min(540px,calc(100vw-32px))] p-0'
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <TaskDoPanel task={task} subscribe={subscribe} onTaskChanged={onTaskChanged} />
      </PopoverContent>
    </Popover>
  )
}

/** The panel body — also usable on its own (a page that already has room). */
export function TaskDoPanel({
  task,
  subscribe,
  onTaskChanged
}: {
  task: TaskDoTask
  subscribe?: AiPlanSubscribe
  onTaskChanged?: () => void
}) {
  const client = useOptionalNivaroClient()!
  const qc = useQueryClient()
  const ticket = task.kind === 'support'
  const [planId, setPlanId] = useState<string | null>(null)
  const [questions, setQuestions] = useState<{ list: Question[]; note: string | null } | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [cannot, setCannot] = useState<{ reason: string; checklist: string[] } | null>(null)
  const [note, setNote] = useState('')
  const [redrafting, setRedrafting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const access = useQuery({
    queryKey: ['task-do', 'task', task.id],
    queryFn: () =>
      client.request<{ data: TaskAccess }>(get(`/ai/task-do/tasks/${task.id}`)).then((r) => r.data)
  })

  // Reopen on the newest live plan for this task.
  useEffect(() => {
    if (planId || !access.data) return
    const live = access.data.plans.find((p) => LIVE.has(p.status))
    if (live) setPlanId(live.plan_id)
  }, [access.data, planId])

  const plan = useQuery({
    queryKey: ['task-do', 'plan', planId],
    queryFn: () =>
      client
        .request<{ data: TaskDoPlan }>(get(`/ai/task-do/plans/${encodeURIComponent(planId!)}`))
        .then((r) => r.data),
    enabled: !!planId
  })

  const draft = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      client
        .request<{ data: Draft }>(post(`/ai/task-do/tasks/${task.id}/draft`, body))
        .then((r) => r.data),
    onMutate: () => {
      setError(null)
      setCannot(null)
    },
    onSuccess: (d) => {
      setRedrafting(false)
      setNote('')
      if (d.kind === 'plan') {
        setQuestions(null)
        setAnswers({})
        qc.setQueryData(['task-do', 'plan', d.plan.plan_id], d.plan)
        setPlanId(d.plan.plan_id)
      } else if (d.kind === 'questions') {
        setQuestions({ list: d.questions, note: d.note })
        setAnswers({})
      } else {
        setQuestions(null)
        setCannot({ reason: d.reason, checklist: d.checklist })
      }
      void qc.invalidateQueries({ queryKey: ['task-do', 'task', task.id] })
    },
    onError: (e) => setError(errText(e))
  })

  const askAgain = (extra: Record<string, unknown> = {}) =>
    draft.mutate({ ...extra, ...(planId ? { previous_plan_id: planId } : {}) })

  const p = plan.data
  const started = !!planId
  const canRedraft =
    !!cannot ||
    (started &&
      !!p &&
      (p.status === 'proposed' || p.status === 'rejected' || p.status === 'expired'))
  const header = (
    <div className='flex items-start gap-2'>
      <Sparkles className='mt-0.5 h-4 w-4 shrink-0 text-nvr-navy dark:text-nvr-cyan' />
      <div className='min-w-0 flex-1'>
        <p className='text-[13px] font-semibold text-foreground'>Let AI do this</p>
        <p className='text-[11.5px] text-muted-foreground'>
          It reads the {ticket ? 'ticket' : 'task'}, the record and the thread as you, then drafts a
          plan you approve. Nothing changes until you say so.
        </p>
      </div>
    </div>
  )
  if (access.isLoading) return <Loading text='Checking…' />
  if (!access.data || (!access.data.ok && !started)) {
    const failed = !access.data
    return (
      <div className='p-4' data-task-do-panel>
        {header}
        <Problem
          text={
            failed
              ? `Could not check whether AI can help with this ${ticket ? 'ticket' : 'task'}.`
              : (access.data?.reason ?? 'Not available')
          }
          detail={failed ? errText(access.error) : null}
          onRetry={failed ? () => void access.refetch() : undefined}
          retrying={access.isFetching}
        />
      </div>
    )
  }

  return (
    <div
      className='max-h-[min(78vh,820px)] overflow-y-auto overscroll-contain p-4'
      data-task-do-panel
    >
      {header}

      {draft.isPending && (
        <div className='mt-3 space-y-2' data-task-do-drafting>
          <p className='flex items-center gap-1.5 text-[12px] text-muted-foreground'>
            <Loader2 className='h-3 w-3 animate-spin' /> Reading the {ticket ? 'ticket' : 'task'},
            the record and the thread…
          </p>
          <Skeleton className='h-4 w-3/4' />
          <Skeleton className='h-4 w-full' />
          <Skeleton className='h-4 w-2/3' />
        </div>
      )}

      {!draft.isPending && questions && (
        <form
          className='mt-3 space-y-3'
          data-task-do-questions
          onSubmit={(e) => {
            e.preventDefault()
            askAgain({
              answers: questions.list.map((q) => ({
                id: q.id,
                question: q.text,
                answer: (answers[q.id] ?? '').trim() || 'No answer'
              }))
            })
          }}
        >
          <p className='text-[12.5px] text-foreground'>
            AI needs a few answers first{questions.note ? ` — ${questions.note}` : ''}:
          </p>
          <ol className='space-y-2.5'>
            {questions.list.map((q, i) => (
              <li key={q.id}>
                <label className='block text-[12px] text-foreground' htmlFor={`tdq-${q.id}`}>
                  <span className='mr-1 tabular-nums text-muted-foreground'>{i + 1}.</span>
                  {q.text}
                </label>
                {q.options?.length ? (
                  <div className='mt-1 flex flex-wrap gap-1'>
                    {q.options.map((o) => (
                      <button
                        key={o}
                        type='button'
                        aria-pressed={answers[q.id] === o}
                        onClick={() => setAnswers((a) => ({ ...a, [q.id]: o }))}
                        className={cn(
                          'h-6 rounded-md border px-2 text-[11.5px]',
                          answers[q.id] === o
                            ? 'border-nvr-cyan bg-nvr-cyan/10 text-foreground'
                            : 'border-slate-200 text-muted-foreground hover:bg-muted dark:border-border'
                        )}
                      >
                        {o}
                      </button>
                    ))}
                  </div>
                ) : null}
                <Input
                  id={`tdq-${q.id}`}
                  className='mt-1 h-7 text-[12px]'
                  value={answers[q.id] ?? ''}
                  placeholder={q.options?.length ? 'Or type an answer' : 'Your answer'}
                  onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                />
              </li>
            ))}
          </ol>
          <div className='flex items-center gap-2'>
            <Button
              type='submit'
              size='sm'
              className='h-7 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
              disabled={!questions.list.some((q) => (answers[q.id] ?? '').trim())}
            >
              Draft with these answers
            </Button>
            <Button
              type='button'
              size='sm'
              variant='ghost'
              className='h-7'
              onClick={() => setQuestions(null)}
            >
              Never mind
            </Button>
          </div>
        </form>
      )}

      {!draft.isPending && cannot && (
        <div className='mt-3 space-y-2' data-task-do-cannot>
          <p className='flex items-start gap-1.5 text-[12.5px] text-foreground'>
            <CircleSlash className='mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400' />
            <span>
              <span className='font-medium'>AI can’t do this one.</span> {cannot.reason}
            </span>
          </p>
          <p className='pl-5 text-[11.5px] text-muted-foreground'>Nothing was changed.</p>
          {cannot.checklist.length > 0 && (
            <div className='pl-5'>
              <p className='text-[11.5px] font-medium text-muted-foreground'>To do it yourself</p>
              <ol className='mt-1 space-y-1'>
                {cannot.checklist.map((c, i) => (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: a static list the model wrote
                    key={`${i}-${c}`}
                    className='flex items-start gap-2 text-[12px] text-foreground'
                  >
                    <span className='w-3.5 shrink-0 text-right tabular-nums text-muted-foreground'>
                      {i + 1}.
                    </span>
                    {c}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}

      {!draft.isPending && !questions && !cannot && !started && (
        <div className='mt-3 flex items-center gap-2'>
          <Button
            size='sm'
            className='h-7 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
            onClick={() => draft.mutate({})}
            data-task-do-start
          >
            <Sparkles className='h-3 w-3' /> Draft a plan
          </Button>
          <span className='text-[11px] text-muted-foreground'>Takes a few seconds.</span>
        </div>
      )}

      {started && !questions && !cannot && !draft.isPending && (
        <>
          {plan.isLoading && <Loading text='Loading the plan…' />}
          {plan.isError && <Problem text={errText(plan.error)} />}
          {p && (
            <PlanReview
              plan={p}
              task={task}
              ticket={ticket}
              subscribe={subscribe}
              onTaskChanged={onTaskChanged}
              onPlan={(next) => {
                if (next.status !== p.status) {
                  void qc.invalidateQueries({ queryKey: ['task-do', 'plan', p.plan_id] })
                  void qc.invalidateQueries({ queryKey: ['task-do', 'task', task.id] })
                }
              }}
            />
          )}
        </>
      )}

      {error && (
        <p className='mt-2 text-[11.5px] text-rose-700 dark:text-rose-400' data-task-do-error>
          {error}
        </p>
      )}

      {!draft.isPending && canRedraft && access.data.ok && (
        <div className='mt-3 border-t border-slate-200 pt-2.5 dark:border-border'>
          {redrafting ? (
            <form
              className='space-y-1.5'
              data-task-do-redraft
              onSubmit={(e) => {
                e.preventDefault()
                askAgain({ note: note.trim() })
              }}
            >
              <Textarea
                autoFocus
                aria-label={cannot ? 'What should it try instead' : 'What should be different'}
                className='min-h-[56px] text-[12px]'
                placeholder={
                  cannot
                    ? 'What should it try instead?'
                    : 'What should be different? e.g. only the open lines, and tell the vendor too'
                }
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <div className='flex items-center gap-2'>
                <Button
                  type='submit'
                  size='sm'
                  className='h-7 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
                  disabled={!note.trim()}
                >
                  Redraft
                </Button>
                <Button
                  type='button'
                  size='sm'
                  variant='ghost'
                  className='h-7'
                  onClick={() => setRedrafting(false)}
                >
                  Cancel
                </Button>
                {!cannot && (
                  <span className='text-[11px] text-muted-foreground'>
                    The current draft is discarded.
                  </span>
                )}
              </div>
            </form>
          ) : (
            <button
              type='button'
              className='text-[11.5px] font-medium text-nvr-navy underline-offset-2 hover:underline dark:text-nvr-cyan'
              onClick={() => setRedrafting(true)}
              data-task-do-redraft-toggle
            >
              {cannot ? 'Try again with a note' : 'Ask for a different plan…'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function Loading({ text }: { text: string }) {
  return (
    <div className='space-y-2 p-4' data-task-do-loading>
      <p className='flex items-center gap-1.5 text-[12px] text-muted-foreground'>
        <Loader2 className='h-3 w-3 animate-spin' /> {text}
      </p>
      <Skeleton className='h-4 w-2/3' />
      <Skeleton className='h-4 w-full' />
    </div>
  )
}

function Problem({
  text,
  detail,
  onRetry,
  retrying
}: {
  text: string
  detail?: string | null
  onRetry?: () => void
  retrying?: boolean
}) {
  return (
    <div className='mt-3 rounded-md bg-slate-50 px-3 py-2.5 dark:bg-muted/40' data-task-do-problem>
      <p className='flex items-start gap-1.5 text-[12px] text-foreground'>
        <CircleSlash className='mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400' />
        <span>{text}</span>
      </p>
      {detail && <p className='mt-0.5 pl-5 text-[11px] text-muted-foreground'>{detail}</p>}
      {onRetry && (
        <Button
          size='sm'
          variant='outline'
          className='ml-5 mt-2 h-7'
          onClick={onRetry}
          disabled={retrying}
        >
          {retrying ? (
            <Loader2 className='h-3 w-3 animate-spin' />
          ) : (
            <RotateCcw className='h-3 w-3' />
          )}
          Try again
        </Button>
      )}
    </div>
  )
}

const RISK_LABEL = { low: 'Low risk', medium: 'Medium risk', high: 'High risk' } as const

function RiskPill({ level }: { level: 'low' | 'medium' | 'high' }) {
  const cls =
    level === 'high'
      ? 'bg-rose-500/10 text-rose-700 dark:text-rose-400'
      : level === 'medium'
        ? 'bg-amber-500/10 text-amber-800 dark:text-amber-300'
        : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
  return (
    <span
      className={cn('rounded px-1.5 py-px text-[11px] font-medium', cls)}
      data-task-do-risk={level}
    >
      {RISK_LABEL[level]}
    </span>
  )
}

/** The review strip + what it touches + what cannot be rolled back (#2863). */
function ReviewStrip({ plan }: { plan: TaskDoPlan }) {
  const r = plan.review
  const notRevertible = r.risk.irreversible
  // The box below lists the steps that can't be undone — don't say it twice.
  const why = r.risk.reasons.filter(
    (x) => !(notRevertible.length > 0 && /cannot be rolled back/.test(x))
  )
  const cell = 'bg-white px-2.5 py-1.5 dark:bg-card'
  return (
    <div className='mt-2.5 space-y-2' data-task-do-review>
      <div className='grid grid-cols-3 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 dark:border-border dark:bg-border'>
        <div className={cell}>
          <p className='text-[11px] text-muted-foreground'>Runs in</p>
          <p className='text-[13px] font-medium tabular-nums text-foreground'>
            ≈ {humanSeconds(r.estimate.run_seconds)}
          </p>
          <p className='text-[10.5px] text-muted-foreground'>
            {r.estimate.run_basis === 'recent runs' ? 'from recent runs' : 'typical rate'}
          </p>
        </div>
        <div className={cell}>
          <p className='text-[11px] text-muted-foreground'>Saves you</p>
          <p className='text-[13px] font-medium tabular-nums text-foreground'>
            {r.estimate.hands_on_minutes != null
              ? `≈ ${humanMinutes(r.estimate.hands_on_minutes)}`
              : '—'}
          </p>
          <p className='text-[10.5px] text-muted-foreground'>AI’s estimate</p>
        </div>
        <div className={cell}>
          <p className='text-[11px] text-muted-foreground'>Risk</p>
          <p className='mt-0.5'>
            <RiskPill level={r.risk.level} />
          </p>
          <p className='text-[10.5px] text-muted-foreground'>{plural(r.risk.records, 'record')}</p>
        </div>
      </div>
      {r.risk.level !== 'low' && why.length > 0 && (
        <p className='text-[11.5px] text-muted-foreground' data-task-do-risk-why>
          {RISK_LABEL[r.risk.level]}: {why.join(' · ')}
        </p>
      )}
      {notRevertible.length > 0 ? (
        <div
          className='rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11.5px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
          data-task-do-irreversible
        >
          <p className='flex items-center gap-1.5 font-medium'>
            <AlertTriangle className='h-3.5 w-3.5 shrink-0' />
            {notRevertible.length === 1
              ? 'One step can’t be undone once it runs'
              : `${notRevertible.length} steps can’t be undone once they run`}
          </p>
          <ul className='mt-0.5 space-y-px pl-5'>
            {notRevertible.map((s) => (
              <li key={s.n}>
                Step {s.n} — {s.why}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p
          className='flex items-center gap-1.5 text-[11.5px] text-muted-foreground'
          data-task-do-reversible
        >
          <ShieldCheck className='h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400' />
          Everything this plan changes can be undone afterwards.
        </p>
      )}
    </div>
  )
}

/** One step's field changes, old → new where the preview knows the old value. */
function StepChanges({ step, plan }: { step: AiPlanStep; plan: TaskDoPlan }) {
  const t = plan.review.touches.find((x) => x.step_id === step.id)
  const preview =
    step.preview?.changes && typeof step.preview.changes === 'object' ? step.preview.changes : {}
  const known = new Map((t?.fields ?? []).map((f) => [f.field, f]))
  const keys = [...new Set([...Object.keys(preview), ...known.keys()])]
  if (keys.length === 0) return null
  return (
    <dl className='mt-0.5 space-y-px pl-5' data-task-do-step-changes>
      {keys.slice(0, 6).map((k) => {
        const f = known.get(k)
        const to = f ? f.to : preview[k]
        return (
          <div key={k} className='flex min-w-0 gap-1.5 text-[11px]'>
            <dt className='shrink-0 text-muted-foreground'>{fieldLabel(k)}</dt>
            <dd className='min-w-0 truncate text-slate-700 dark:text-slate-300'>
              {f && f.from !== undefined && (
                <>
                  <span className='text-muted-foreground line-through decoration-slate-300 dark:decoration-slate-600'>
                    {fmt(f.from)}
                  </span>{' '}
                  →{' '}
                </>
              )}
              {fmt(to)}
            </dd>
          </div>
        )
      })}
      {keys.length > 6 && (
        <p className='text-[11px] text-muted-foreground'>+{keys.length - 6} more fields</p>
      )}
    </dl>
  )
}

/** Under a step: what it touches, and — while proposed — remove / change a value. */
function StepExtra({
  step,
  plan,
  onEdit,
  busy
}: {
  step: AiPlanStep
  plan: TaskDoPlan
  onEdit: (body: Record<string, unknown>) => void
  busy: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [field, setField] = useState('')
  const [value, setValue] = useState('')
  const t = plan.review.touches.find((x) => x.step_id === step.id)
  const changes =
    step.preview?.changes && typeof step.preview.changes === 'object' ? step.preview.changes : null
  const editableFields = [
    ...Object.keys(changes ?? {}).filter(() =>
      ['bulk_update', 'create_record'].includes(step.kind)
    ),
    ...(EDITABLE_FREE[step.kind] ?? [])
  ]
  const canEdit = plan.status === 'proposed'
  const parts: string[] = []
  if (t) {
    if (t.records) parts.push(plural(t.records, t.collection ?? 'record'))
    if (t.people) parts.push(`tells ${plural(t.people, 'person', 'people')}`)
    if (t.external) parts.push('calls other systems')
    if (t.email) parts.push('may email')
  }
  const hidden = Number(step.preview?.hidden_fields ?? 0)
  if (hidden) parts.push(`${hidden} field${hidden === 1 ? '' : 's'} you may not read`)
  return (
    <div className='mt-1 pl-5' data-task-do-step-extra>
      {(parts.length > 0 || t?.irreversible) && (
        <p className='text-[11px] text-muted-foreground'>
          {parts.join(' · ')}
          {t?.irreversible && (
            <span className='text-amber-800 dark:text-amber-300'>
              {parts.length > 0 ? ' · ' : ''}can’t be undone
            </span>
          )}
        </p>
      )}
      {canEdit && !editing && (
        <div className='mt-0.5 flex items-center gap-2'>
          {editableFields.length > 0 && (
            <button
              type='button'
              className='flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground'
              onClick={() => {
                setField(editableFields[0])
                setValue(
                  changes && editableFields[0] in changes ? fmt(changes[editableFields[0]]) : ''
                )
                setEditing(true)
              }}
              disabled={busy}
              data-task-do-step-change
            >
              <Pencil className='h-3 w-3' /> Change a value
            </button>
          )}
          {plan.steps.length > 1 && (
            <button
              type='button'
              className='flex items-center gap-1 text-[11px] text-muted-foreground hover:text-rose-700 dark:hover:text-rose-400'
              onClick={() => onEdit({ remove_step: step.id })}
              disabled={busy}
              data-task-do-step-remove
            >
              <Trash2 className='h-3 w-3' /> Remove step
            </button>
          )}
        </div>
      )}
      {canEdit && editing && (
        <form
          className='mt-1 flex flex-wrap items-center gap-1.5'
          onSubmit={(e) => {
            e.preventDefault()
            onEdit({ set: { step_id: step.id, field, value } })
            setEditing(false)
          }}
        >
          <SimpleSelect
            value={field}
            onChange={(v) => {
              setField(v)
              setValue(changes && v in changes ? fmt(changes[v]) : '')
            }}
            options={editableFields.map((f) => ({ value: f, label: fieldLabel(f) }))}
            ariaLabel='Field'
            className='h-7 w-[150px] text-[11.5px]'
          />
          <Input
            className='h-7 w-[180px] text-[11.5px]'
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label='New value'
            autoFocus
          />
          <Button type='submit' size='sm' className='h-7' variant='outline' disabled={busy}>
            {busy ? <Loader2 className='h-3 w-3 animate-spin' /> : <Check className='h-3 w-3' />}
            Apply
          </Button>
          <Button
            type='button'
            size='sm'
            variant='ghost'
            className='h-7'
            onClick={() => setEditing(false)}
          >
            Cancel
          </Button>
        </form>
      )}
    </div>
  )
}

function PlanReview({
  plan: p,
  task,
  ticket,
  subscribe,
  onTaskChanged,
  onPlan
}: {
  plan: TaskDoPlan
  task: TaskDoTask
  ticket: boolean
  subscribe?: AiPlanSubscribe
  onTaskChanged?: () => void
  onPlan: (plan: AiPlan) => void
}) {
  const client = useOptionalNivaroClient()!
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [reply, setReply] = useState<string | null>(null)
  const [showUndo, setShowUndo] = useState(false)
  const [doneSent, setDoneSent] = useState(false)
  // The card's own copy (events, polls, its actions) — what the person sees right now.
  const [live, setLive] = useState<AiPlan>(p)
  const key = ['task-do', 'plan', p.plan_id]
  // An edit (step removed, value changed) re-mounts the card on the new steps.
  const stepsSig = JSON.stringify(p.steps.map((s) => [s.id, s.preview?.changes ?? null]))

  const edit = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      client
        .request<{ data: TaskDoPlan }>(
          post(`/ai/task-do/plans/${encodeURIComponent(p.plan_id)}/edit`, body)
        )
        .then((r) => r.data),
    onMutate: () => setError(null),
    onSuccess: (d) => qc.setQueryData(key, d),
    onError: (e) => setError(errText(e))
  })
  const approve = useMutation({
    mutationFn: () =>
      client
        .request<{ data: TaskDoPlan }>(
          post(`/ai/task-do/plans/${encodeURIComponent(p.plan_id)}/approve`)
        )
        .then((r) => r.data),
    onSuccess: (d) => qc.setQueryData(key, d),
    onError: (e) => setError(errText(e))
  })
  const markDone = useMutation({
    mutationFn: () =>
      ticket
        ? client.request(patch(`/support/tickets/${task.id}`, { status: 'done' }))
        : client.request(post(`/tasks/${task.id}/complete`)),
    onSuccess: () => {
      setDoneSent(true)
      for (const k of ['tasks', 'my-work', 'support-ticket', 'support-tickets', 'support-summary'])
        void qc.invalidateQueries({ queryKey: [k] })
      onTaskChanged?.()
    },
    onError: (e) => setError(errText(e))
  })
  const draftReply = useMutation({
    mutationFn: () =>
      client
        .request<{ data: { text: string } }>(
          post(`/ai/task-do/plans/${encodeURIComponent(p.plan_id)}/draft-reply`)
        )
        .then((r) => r.data.text),
    onMutate: () => setError(null),
    onSuccess: (t) => setReply(t),
    onError: (e) => setError(errText(e))
  })
  const sendReply = useMutation({
    mutationFn: (text: string) =>
      client.request(post(`/support/tickets/${task.id}/comments`, { text })),
    onSuccess: () => {
      setReply(null)
      void qc.invalidateQueries({ queryKey: ['support-ticket'] })
      onTaskChanged?.()
    },
    onError: (e) => setError(errText(e))
  })

  const waiting = p.approval?.required && !p.approval.approved_by
  const finished = p.status === 'executed'
  const taskOpen = task.status === 'open' || task.status === 'in_progress'
  const beforeRun = live.status === 'proposed' || live.status === 'scheduled'

  return (
    <div className='mt-3' data-task-do-plan={p.status}>
      <PlanStatus plan={live} waiting={!!waiting} />
      {waiting && (
        <div
          className='flex items-start gap-1.5 rounded-md bg-slate-50 px-2.5 py-1.5 text-[11.5px] text-foreground dark:bg-muted/40'
          data-task-do-approval
        >
          <Clock className='mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400' />
          <span className='min-w-0 flex-1'>
            <span className='font-medium'>Needs a second approval.</span> {p.approval!.reason}.{' '}
            {p.approval!.superseded ? `${p.approval!.superseded}. ` : ''}
            {p.can_approve
              ? 'You were asked to approve it — review the steps below first.'
              : `Waiting for ${p.approval!.approvers.length === 1 ? 'one person' : `one of ${p.approval!.approvers.length} people`} to approve; they have been told.`}
          </span>
        </div>
      )}
      <AiPlanCard
        key={stepsSig}
        plan={p}
        quiet
        subscribe={subscribe}
        className='mt-3'
        beforeSteps={beforeRun ? <ReviewStrip plan={p} /> : null}
        stepChanges={(s) => <StepChanges step={s} plan={p} />}
        stepExtra={(s) => (
          <StepExtra step={s} plan={p} onEdit={(b) => edit.mutate(b)} busy={edit.isPending} />
        )}
        runDisabled={
          waiting
            ? p.can_approve
              ? 'Once you approve, the assignee can run it.'
              : 'Approve & run opens once a second person approves.'
            : null
        }
        onPlan={(next) => {
          setLive(next)
          onPlan(next)
        }}
        extraActions={(live) =>
          waiting && p.can_approve && live.status === 'proposed' ? (
            <Button
              size='sm'
              className='h-7 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
              disabled={approve.isPending}
              onClick={() => approve.mutate()}
              data-task-do-approve
            >
              {approve.isPending ? (
                <Loader2 className='h-3 w-3 animate-spin' />
              ) : (
                <Check className='h-3 w-3' />
              )}
              Approve plan
            </Button>
          ) : live.status === 'executed' || p.can_undo ? (
            <>
              {live.status === 'executed' && taskOpen && !doneSent && (
                <Button
                  size='sm'
                  variant='outline'
                  className='h-7'
                  disabled={markDone.isPending}
                  onClick={() => markDone.mutate()}
                  data-task-do-mark-done
                >
                  {markDone.isPending ? (
                    <Loader2 className='h-3 w-3 animate-spin' />
                  ) : (
                    <Check className='h-3 w-3' />
                  )}
                  Mark {ticket ? 'ticket' : 'task'} done
                </Button>
              )}
              {live.status === 'executed' && ticket && reply == null && (
                <Button
                  size='sm'
                  variant='outline'
                  className='h-7'
                  disabled={draftReply.isPending}
                  onClick={() => draftReply.mutate()}
                  data-task-do-draft-reply
                >
                  {draftReply.isPending ? (
                    <Loader2 className='h-3 w-3 animate-spin' />
                  ) : (
                    <MessageSquareText className='h-3 w-3' />
                  )}
                  Draft reply to requester
                </Button>
              )}
              {p.can_undo && (
                <Button
                  size='sm'
                  variant='ghost'
                  className='h-7'
                  onClick={() => setShowUndo((v) => !v)}
                  data-task-do-undo-toggle
                >
                  <Undo2 className='h-3 w-3' /> Undo what AI did
                </Button>
              )}
            </>
          ) : null
        }
      />
      {doneSent && (
        <p className='mt-2 flex items-center gap-1 text-[11.5px] text-emerald-700 dark:text-emerald-400'>
          <Check className='h-3 w-3' /> {ticket ? 'Ticket' : 'Task'} marked done.
        </p>
      )}
      {reply != null && (
        <form
          className='mt-2 space-y-1.5'
          data-task-do-reply
          onSubmit={(e) => {
            e.preventDefault()
            if (reply.trim()) sendReply.mutate(reply.trim())
          }}
        >
          <label
            htmlFor={`task-do-reply-${p.plan_id}`}
            className='block text-[12px] font-medium text-foreground'
          >
            Reply to the requester
          </label>
          <p className='text-[11.5px] text-muted-foreground'>
            AI drafted this from what the plan did. Edit it, then send — it goes out as your reply.
            Nothing is sent until you do.
          </p>
          <Textarea
            id={`task-do-reply-${p.plan_id}`}
            className='min-h-[96px] text-[12px]'
            value={reply}
            onChange={(e) => setReply(e.target.value)}
          />
          <div className='flex items-center gap-2'>
            <Button
              type='submit'
              size='sm'
              className='h-7 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
              disabled={!reply.trim() || sendReply.isPending}
            >
              {sendReply.isPending ? <Loader2 className='h-3 w-3 animate-spin' /> : null}
              Send reply
            </Button>
            <Button
              type='button'
              size='sm'
              variant='ghost'
              className='h-7'
              onClick={() => setReply(null)}
            >
              Discard
            </Button>
          </div>
        </form>
      )}
      {showUndo && p.can_undo && (
        <UndoSection
          planId={p.plan_id}
          undoUntil={p.undo_until}
          onDone={() => {
            void qc.invalidateQueries({ queryKey: key })
          }}
        />
      )}
      {finished && !p.can_undo && p.made_steps?.length === 0 && (
        <p className='mt-2 text-[11px] text-muted-foreground'>
          Nothing this plan did can be undone.
        </p>
      )}
      {error && (
        <p className='mt-2 text-[11.5px] text-rose-700 dark:text-rose-400' data-task-do-plan-error>
          {error}
        </p>
      )}
    </div>
  )
}

/** One plain sentence on where the plan stands, above everything else in the panel. */
function PlanStatus({ plan, waiting }: { plan: AiPlan; waiting?: boolean }) {
  const total = plan.steps.length
  const done = plan.steps.filter((s) => s.state.status === 'done' || s.state.status === 'skipped')
  const failed = plan.steps.find((s) => s.state.status === 'failed')
  const changed =
    plan.records_changed > 0 ? ` · ${plural(plan.records_changed, 'record')} changed` : ''
  let icon: ReactNode = null
  let text: ReactNode = null
  let tone = 'text-foreground'
  switch (plan.status) {
    case 'proposed':
      // A plan waiting for a second approval says so in its own line.
      if (waiting) return null
      icon = <ShieldCheck className='h-3.5 w-3.5 text-slate-400' />
      text = 'Nothing has run yet. Check the steps, then approve — or change or discard them.'
      tone = 'text-muted-foreground'
      break
    case 'running': {
      const n = Math.min(total, done.length + 1)
      icon = <Loader2 className='h-3.5 w-3.5 animate-spin text-nvr-cyan' />
      text = `Running step ${n} of ${total}${changed}`
      break
    }
    case 'executed':
      icon = <Check className='h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400' />
      text = `Done — ${plural(total, 'step')} ran${changed}. The thread has a summary.`
      break
    case 'failed':
    case 'paused':
      icon = <Clock className='h-3.5 w-3.5 text-amber-600 dark:text-amber-400' />
      text = failed
        ? `Paused at step ${failed.n} — the reason is under it. Steps after it have not run.`
        : `Paused after ${plural(done.length, 'step')}${changed}.`
      break
    case 'rejected':
      text = done.length
        ? 'Stopped — the remaining steps did not run.'
        : 'Discarded — nothing changed.'
      tone = 'text-muted-foreground'
      break
    default:
      return null
  }
  const pct = total ? Math.round((done.length / total) * 100) : 0
  return (
    <div data-task-do-status={plan.status}>
      <p className={cn('flex items-center gap-1.5 text-[12px]', tone)} aria-live='polite'>
        {icon}
        {text}
      </p>
      {(plan.status === 'running' || plan.status === 'failed' || plan.status === 'paused') && (
        <div
          className='mt-1.5 h-1 overflow-hidden rounded-full bg-slate-100 dark:bg-muted'
          role='progressbar'
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done.length}
          aria-label='Steps finished'
        >
          <div
            className={cn(
              'h-full rounded-full transition-[width] duration-300 ease-out motion-reduce:transition-none',
              plan.status === 'running' ? 'bg-nvr-cyan' : 'bg-amber-500'
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  )
}

/** Preview of what a rollback restores and what it cannot, then a two-click undo (#2865). */
function UndoSection({
  planId,
  undoUntil,
  onDone
}: {
  planId: string
  undoUntil: string | null
  onDone: () => void
}) {
  const client = useOptionalNivaroClient()!
  const [confirm, setConfirm] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const check = useQuery({
    queryKey: ['task-do', 'undo', planId],
    queryFn: () =>
      client
        .request<{ data: { steps: UndoStep[] } }>(
          get(`/ai/task-do/plans/${encodeURIComponent(planId)}/undo`)
        )
        .then((r) => r.data.steps)
  })
  const run = useMutation({
    mutationFn: () =>
      client
        .request<{ data: { undone: number; skipped: number; failed: number; errors: string[] } }>(
          post(`/ai/task-do/plans/${encodeURIComponent(planId)}/undo`, {})
        )
        .then((r) => r.data),
    onSuccess: (d) => {
      setResult(
        `Restored ${d.undone} record${d.undone === 1 ? '' : 's'}${d.skipped ? `; ${d.skipped} changed since and left alone` : ''}${d.failed ? `; ${d.failed} failed (${d.errors[0] ?? ''})` : ''}.`
      )
      setConfirm(false)
      void check.refetch()
      onDone()
    },
    onError: (e) => setResult(errText(e))
  })
  const steps = check.data ?? []
  const revertible = steps.reduce((n, s) => n + s.revertible, 0)
  const blocked = steps.flatMap((s) =>
    s.records.filter((r) => r.status === 'changed' || r.status === 'gone')
  )
  const never = steps.filter((s) => s.not_revertible)
  const until = useMemo(() => {
    if (!undoUntil) return null
    const d = new Date(undoUntil)
    return Number.isNaN(d.getTime())
      ? null
      : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }, [undoUntil])
  return (
    <div
      className='mt-3 rounded-md border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'
      data-task-do-undo
    >
      <p className='flex items-center gap-1.5 text-[12.5px] font-medium text-foreground'>
        <Undo2 className='h-3.5 w-3.5 text-slate-400' /> Undo what AI did
        {until && (
          <span className='font-normal text-muted-foreground'>· possible until {until}</span>
        )}
      </p>
      {check.isLoading && (
        <div className='mt-2 space-y-1.5'>
          <Skeleton className='h-3.5 w-2/3' />
          <Skeleton className='h-3.5 w-1/2' />
        </div>
      )}
      {check.isError && (
        <p className='mt-1.5 text-[11.5px] text-rose-700 dark:text-rose-400'>
          Could not check what can be restored: {errText(check.error)}
        </p>
      )}
      {check.data && (
        <div className='mt-2 space-y-2 text-[11.5px]'>
          <p className='flex items-start gap-1.5 text-foreground'>
            <Check className='mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400' />
            {revertible > 0
              ? `${plural(revertible, 'record')} will go back to what ${revertible === 1 ? 'it was' : 'they were'} before the plan ran.`
              : 'Nothing is left to restore.'}
          </p>
          {blocked.length > 0 && (
            <div className='flex items-start gap-1.5' data-task-do-undo-conflicts>
              <CircleSlash className='mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400' />
              <div className='min-w-0'>
                <p className='text-foreground'>
                  {plural(blocked.length, 'record')} left as{' '}
                  {blocked.length === 1 ? 'it is' : 'they are'} — changed since, and newer edits are
                  never overwritten:
                </p>
                <ul className='mt-0.5 space-y-px text-muted-foreground'>
                  {blocked.slice(0, 4).map((r) => (
                    <li key={`${r.collection}:${r.id}`} className='truncate'>
                      {r.label} — {r.reason ?? r.status}
                    </li>
                  ))}
                  {blocked.length > 4 && <li>+{blocked.length - 4} more</li>}
                </ul>
              </div>
            </div>
          )}
          {never.length > 0 && (
            <div className='flex items-start gap-1.5 text-muted-foreground'>
              <CircleSlash className='mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400' />
              <div className='min-w-0'>
                <p>Can’t be undone:</p>
                <ul className='mt-0.5 space-y-px'>
                  {never.map((s) => (
                    <li key={s.step_id}>
                      Step {s.n} — {s.not_revertible}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      )}
      {result && (
        <p className='mt-2 text-[11.5px] text-foreground' aria-live='polite'>
          {result}
        </p>
      )}
      {revertible > 0 && (
        <div className='mt-2.5 flex items-center gap-2'>
          <Button
            size='sm'
            variant={confirm ? 'default' : 'outline'}
            className={cn('h-7', confirm && 'bg-nvr-cyan text-white hover:bg-nvr-cyan/90')}
            disabled={run.isPending}
            onClick={() => (confirm ? run.mutate() : setConfirm(true))}
            data-task-do-undo-run
          >
            {run.isPending ? (
              <Loader2 className='h-3 w-3 animate-spin' />
            ) : (
              <RotateCcw className='h-3 w-3' />
            )}
            {confirm
              ? `Yes, restore ${plural(revertible, 'record')}`
              : `Restore ${plural(revertible, 'record')}`}
          </Button>
          {confirm && (
            <Button size='sm' variant='ghost' className='h-7' onClick={() => setConfirm(false)}>
              Cancel
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
