import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Check,
  Loader2,
  MessageSquareText,
  Pencil,
  Sparkles,
  Timer,
  Trash2,
  Undo2,
  X
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
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
    approved_by?: string | null
    approved_at?: string | null
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
  if (access.isLoading) return <Loading text='Checking…' />
  if (!access.data) return <Problem text={errText(access.error)} />
  if (!access.data.ok && !started) {
    return <Problem text={access.data.reason ?? 'Not available'} />
  }

  return (
    <div
      className='max-h-[min(72vh,760px)] overflow-y-auto overscroll-contain p-4'
      data-task-do-panel
    >
      <div className='flex items-start gap-2'>
        <Sparkles className='mt-0.5 h-4 w-4 shrink-0 text-nvr-navy dark:text-nvr-cyan' />
        <div className='min-w-0 flex-1'>
          <p className='text-[13px] font-semibold text-foreground'>Let AI do this</p>
          <p className='text-[11.5px] text-muted-foreground'>
            It reads the {ticket ? 'ticket' : 'task'}, the record and the thread as you, then drafts
            a plan you approve. Nothing changes until you say so.
          </p>
        </div>
      </div>

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
                answer: answers[q.id] ?? ''
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
              disabled={questions.list.some((q) => !(answers[q.id] ?? '').trim())}
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
            <X className='mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-600 dark:text-rose-400' />
            <span>
              <span className='font-medium'>AI can’t do this.</span> {cannot.reason}
            </span>
          </p>
          {cannot.checklist.length > 0 && (
            <div>
              <p className='text-[11.5px] font-medium text-muted-foreground'>To do it yourself</p>
              <ul className='mt-1 space-y-1'>
                {cannot.checklist.map((c, i) => (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: a static list the model wrote
                    key={`${i}-${c}`}
                    className='flex items-start gap-1.5 text-[12px] text-foreground'
                  >
                    <span className='mt-1 h-3 w-3 shrink-0 rounded-sm border border-slate-300 dark:border-border' />
                    {c}
                  </li>
                ))}
              </ul>
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

      {!draft.isPending && (started || cannot) && access.data.ok && (
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
            (cannot ||
              (p &&
                (p.status === 'proposed' ||
                  p.status === 'rejected' ||
                  p.status === 'expired'))) && (
              <button
                type='button'
                className='text-[11.5px] font-medium text-nvr-navy underline-offset-2 hover:underline dark:text-nvr-cyan'
                onClick={() => setRedrafting(true)}
                data-task-do-redraft-toggle
              >
                {cannot ? 'Try again with a note' : 'Ask for a different plan…'}
              </button>
            )
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

function Problem({ text }: { text: string }) {
  return (
    <p className='p-4 text-[12px] text-muted-foreground' data-task-do-problem>
      {text}
    </p>
  )
}

function RiskPill({ level }: { level: 'low' | 'medium' | 'high' }) {
  const cls =
    level === 'high'
      ? 'bg-rose-500/10 text-rose-700 dark:text-rose-400'
      : level === 'medium'
        ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
        : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
  return (
    <span
      className={cn('rounded px-1.5 py-px text-[11px] font-medium capitalize', cls)}
      data-task-do-risk={level}
    >
      {level} risk
    </span>
  )
}

/** The review strip + what it touches + what cannot be rolled back (#2863). */
function ReviewStrip({ plan }: { plan: TaskDoPlan }) {
  const r = plan.review
  const notRevertible = r.risk.irreversible
  return (
    <div className='mt-2 space-y-2' data-task-do-review>
      <div className='grid grid-cols-3 gap-px overflow-hidden rounded-md border border-amber-200/80 bg-amber-200/80 dark:border-amber-800/60 dark:bg-amber-800/60'>
        <div className='bg-white/80 px-2.5 py-1.5 dark:bg-card'>
          <p className='text-[10.5px] text-muted-foreground'>Run time</p>
          <p className='text-[12.5px] font-medium tabular-nums text-foreground'>
            ≈ {humanSeconds(r.estimate.run_seconds)}
          </p>
          <p className='text-[10.5px] text-muted-foreground'>
            {r.estimate.run_basis === 'recent runs' ? 'from recent runs' : 'default rate'}
          </p>
        </div>
        <div className='bg-white/80 px-2.5 py-1.5 dark:bg-card'>
          <p className='text-[10.5px] text-muted-foreground'>Hands-on time saved</p>
          <p className='text-[12.5px] font-medium tabular-nums text-foreground'>
            {r.estimate.hands_on_minutes != null
              ? `≈ ${humanMinutes(r.estimate.hands_on_minutes)}`
              : '—'}
          </p>
          <p className='text-[10.5px] text-muted-foreground'>AI’s estimate</p>
        </div>
        <div className='bg-white/80 px-2.5 py-1.5 dark:bg-card'>
          <p className='text-[10.5px] text-muted-foreground'>Risk</p>
          <p className='mt-0.5'>
            <RiskPill level={r.risk.level} />
          </p>
          <p
            className='truncate text-[10.5px] text-muted-foreground'
            title={r.risk.reasons.join('; ')}
          >
            {r.risk.reasons[0] ?? `${r.risk.records} record${r.risk.records === 1 ? '' : 's'}`}
          </p>
        </div>
      </div>
      {notRevertible.length > 0 && (
        <p
          className='flex items-start gap-1.5 rounded-md border border-amber-300 bg-white/70 px-2.5 py-1.5 text-[11.5px] text-amber-900 dark:border-amber-700 dark:bg-card dark:text-amber-200'
          data-task-do-irreversible
        >
          <AlertTriangle className='mt-0.5 h-3.5 w-3.5 shrink-0' />
          <span>
            <span className='font-medium'>Can’t be rolled back:</span>{' '}
            {notRevertible.map((s) => `step ${s.n} (${s.why})`).join(', ')}.
          </span>
        </p>
      )}
    </div>
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
    if (t.records)
      parts.push(`${t.records} ${t.collection ?? 'record'}${t.records === 1 ? '' : 's'}`)
    if (t.people) parts.push(`tells ${t.people} ${t.people === 1 ? 'person' : 'people'}`)
    if (t.external) parts.push('calls other systems')
    if (t.email) parts.push('may email')
    for (const f of t.fields.filter((x) => x.from !== undefined).slice(0, 4))
      parts.push(`${f.field} ${fmt(f.from)} → ${fmt(f.to)}`)
  }
  return (
    <div className='mt-1 pl-5' data-task-do-step-extra>
      {(parts.length > 0 || t?.irreversible) && (
        <p className='text-[11px] text-muted-foreground'>
          {parts.join(' · ')}
          {t?.irreversible && (
            <span className='ml-1 text-amber-700 dark:text-amber-300'>· not reversible</span>
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
            options={editableFields.map((f) => ({ value: f, label: f }))}
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
  const key = ['task-do', 'plan', p.plan_id]

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

  return (
    <div className='mt-2' data-task-do-plan={p.status}>
      {waiting && (
        <div
          className='mb-2 flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11.5px] text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200'
          data-task-do-approval
        >
          <AlertTriangle className='h-3.5 w-3.5 shrink-0' />
          <span className='min-w-0 flex-1'>
            {p.approval!.reason}.{' '}
            {p.can_approve
              ? 'You were asked to approve it.'
              : `Waiting for ${p.approval!.approvers.length === 1 ? 'one person' : `one of ${p.approval!.approvers.length} people`} to approve.`}
          </span>
          {p.can_approve && (
            <Button
              size='sm'
              className='h-6 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
              disabled={approve.isPending}
              onClick={() => approve.mutate()}
              data-task-do-approve
            >
              {approve.isPending ? <Loader2 className='h-3 w-3 animate-spin' /> : null}
              Approve
            </Button>
          )}
        </div>
      )}
      <AiPlanCard
        plan={p}
        subscribe={subscribe}
        className='mt-0'
        beforeSteps={<ReviewStrip plan={p} />}
        stepExtra={(s) => (
          <StepExtra step={s} plan={p} onEdit={(b) => edit.mutate(b)} busy={edit.isPending} />
        )}
        runDisabled={waiting ? 'Approve & run opens once a second person approves.' : null}
        onPlan={onPlan}
        extraActions={(live) =>
          live.status === 'executed' || p.can_undo ? (
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
        <p className='mt-2 text-[11.5px] text-emerald-700 dark:text-emerald-400'>Marked done.</p>
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
          <p className='text-[11.5px] text-muted-foreground'>
            A draft for the requester — edit it, then send. It goes out as your reply.
          </p>
          <Textarea
            className='min-h-[88px] text-[12px]'
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
          Nothing this plan did can be rolled back.
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
      className='mt-2 rounded-md border border-slate-200 bg-white p-2.5 dark:border-border dark:bg-card'
      data-task-do-undo
    >
      <p className='flex items-center gap-1.5 text-[12px] font-medium text-foreground'>
        <Undo2 className='h-3.5 w-3.5 text-slate-400' /> Undo what AI did
        {until && <span className='font-normal text-muted-foreground'>· until {until}</span>}
      </p>
      {check.isLoading && (
        <p className='mt-1 text-[11.5px] text-muted-foreground'>Checking what can be restored…</p>
      )}
      {check.data && (
        <div className='mt-1 space-y-1 text-[11.5px]'>
          <p className='text-foreground'>
            {revertible > 0
              ? `${revertible} record${revertible === 1 ? '' : 's'} will go back to what they were.`
              : 'Nothing is left to restore.'}
          </p>
          {blocked.length > 0 && (
            <p className='text-amber-800 dark:text-amber-300' data-task-do-undo-conflicts>
              Left alone ({blocked.length}):{' '}
              {blocked
                .slice(0, 4)
                .map((r) => `${r.label} — ${r.reason ?? r.status}`)
                .join('; ')}
              {blocked.length > 4 ? ` +${blocked.length - 4} more` : ''}. Newer edits are never
              overwritten.
            </p>
          )}
          {never.length > 0 && (
            <p className='text-muted-foreground'>
              Cannot be restored: {never.map((s) => `step ${s.n} (${s.not_revertible})`).join(', ')}
              .
            </p>
          )}
        </div>
      )}
      {result && <p className='mt-1.5 text-[11.5px] text-foreground'>{result}</p>}
      {revertible > 0 && (
        <div className='mt-2 flex items-center gap-2'>
          <Button
            size='sm'
            variant={confirm ? 'destructive' : 'outline'}
            className='h-7'
            disabled={run.isPending}
            onClick={() => (confirm ? run.mutate() : setConfirm(true))}
            data-task-do-undo-run
          >
            {run.isPending ? (
              <Loader2 className='h-3 w-3 animate-spin' />
            ) : (
              <Timer className='h-3 w-3' />
            )}
            {confirm ? `Yes, restore ${revertible}` : 'Restore'}
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
