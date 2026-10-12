import {
  Ban,
  Check,
  CircleDashed,
  Filter,
  ListChecks,
  Loader2,
  RotateCcw,
  SkipForward,
  X
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useOptionalNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'

/**
 * An Ask AI multi-step plan (#1807) — the numbered steps the model proposed,
 * each with its preview, approved together ("Run all") or one at a time
 * ("Run next step"). While it runs every step's state arrives live over the
 * host's socket (`ai:plan`, #2007) with a running count of records changed;
 * the card also re-reads the plan from the server on mount and every few
 * seconds while it runs, so a missed event never leaves it wrong. A failed
 * plan offers "Re-check and retry" (#1902): the server rebuilds the failed
 * and remaining steps as the person now, the card shows what changed, and
 * the person runs it again from where it stopped. Steps with a condition
 * (#1953) say so, and a skipped step names why.
 */

export type AiPlanStatus =
  | 'proposed'
  | 'running'
  | 'paused'
  | 'executed'
  | 'failed'
  | 'rejected'
  | 'expired'

export interface AiPlanStepState {
  id: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled'
  records_changed: number
  result?: Record<string, unknown> | null
  error?: string | null
  skip_reason?: string | null
  skipped_records?: Array<{ id: string; label?: string; reason: string }>
  attempts: number
}

export interface AiPlanStep {
  id: string
  n: number
  kind: string
  kind_label: string
  title: string
  preview: {
    summary?: string
    count?: number
    changes?: Record<string, unknown> | null
    sample?: Array<{ id: string; label: string }>
    recipients?: Array<{ id: string; name: string }>
    [key: string]: unknown
  }
  condition: string | null
  state: AiPlanStepState
  preview_changed?: boolean
}

export interface AiPlan {
  plan_id: string
  title: string
  status: AiPlanStatus
  steps: AiPlanStep[]
  records_changed: number
  rechecked_at?: string | null
}

export type AiPlanSubscribe = (
  event: 'ai:plan',
  handler: (payload: Record<string, unknown>) => void
) => () => void

const POLL_MS = 3000

function errorText(err: unknown): string {
  return (err as Error)?.message || 'The request failed'
}

function StepIcon({ status }: { status: AiPlanStepState['status'] }) {
  const cls = 'h-3.5 w-3.5 shrink-0'
  if (status === 'running') return <Loader2 className={cn(cls, 'animate-spin text-nvr-cyan')} />
  if (status === 'done')
    return <Check className={cn(cls, 'text-emerald-600 dark:text-emerald-400')} />
  if (status === 'failed') return <X className={cn(cls, 'text-rose-600 dark:text-rose-400')} />
  if (status === 'skipped')
    return <SkipForward className={cn(cls, 'text-amber-600 dark:text-amber-400')} />
  if (status === 'cancelled') return <Ban className={cn(cls, 'text-muted-foreground')} />
  return <CircleDashed className={cn(cls, 'text-muted-foreground')} />
}

function fmt(v: unknown): string {
  if (v == null || v === '') return '—'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export function AiPlanCard({
  plan: initial,
  subscribe,
  className
}: {
  plan: AiPlan
  /** The host's socket — `ai:plan` events for this person. Optional: the
   *  card polls while a plan runs either way. */
  subscribe?: AiPlanSubscribe
  className?: string
}) {
  const client = useOptionalNivaroClient()
  const [plan, setPlan] = useState<AiPlan>(initial)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const id = initial.plan_id
  const lastRead = useRef(0)

  const refresh = useCallback(async () => {
    if (!client) return
    const asked = Date.now()
    lastRead.current = asked
    try {
      const res = await client.request(get<{ data: AiPlan }>(`/ai/plans/${encodeURIComponent(id)}`))
      // a newer read (or event) already landed — keep it
      if (lastRead.current === asked && res?.data) setPlan(res.data)
    } catch {
      /* keep what we have; the next poll or event corrects it */
    }
  }, [client, id])

  // Reconcile with the server once: a conversation reopened later shows the
  // plan as it is now, not as it was proposed.
  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!subscribe) return
    return subscribe('ai:plan', (payload) => {
      if (String(payload.plan_id ?? '').toUpperCase() !== id.toUpperCase()) return
      const next = payload.plan as AiPlan | undefined
      if (next?.steps) {
        lastRead.current = Date.now()
        setPlan(next)
      }
    })
  }, [subscribe, id])

  useEffect(() => {
    if (plan.status !== 'running') return
    const t = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(t)
  }, [plan.status, refresh])

  const act = async (action: 'run' | 'retry' | 'cancel', body?: Record<string, unknown>) => {
    if (!client || busy) return
    setBusy(action)
    setError(null)
    try {
      const res = await client.request(
        post<{ data: AiPlan }>(`/ai/plans/${encodeURIComponent(id)}/${action}`, body)
      )
      if (res?.data) {
        lastRead.current = Date.now()
        setPlan(res.data)
      }
    } catch (err) {
      setError(errorText(err))
      void refresh()
    } finally {
      setBusy(null)
    }
  }

  const done = plan.steps.filter((s) => s.state.status === 'done').length
  const skipped = plan.steps.filter((s) => s.state.status === 'skipped').length
  const canRun = plan.status === 'proposed' || plan.status === 'paused'
  const pending = plan.steps.filter((s) => s.state.status === 'pending').length

  return (
    <div
      className={cn(
        'mt-2 rounded-lg border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-800 dark:bg-amber-900/10',
        className
      )}
      data-ai-plan={plan.status}
    >
      <div className='flex items-start gap-2'>
        <ListChecks className='mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300' />
        <div className='min-w-0 flex-1'>
          <p className='text-[12.5px] font-semibold text-amber-900 dark:text-amber-200'>
            {plan.status === 'proposed' ? 'Proposed plan: ' : 'Plan: '}
            {plan.title}
          </p>
          <p className='text-[11px] text-amber-800/80 dark:text-amber-300/80' data-ai-plan-progress>
            {plan.steps.length} step{plan.steps.length === 1 ? '' : 's'}
            {done + skipped > 0 ? ` · ${done} done` : ''}
            {skipped > 0 ? ` · ${skipped} skipped` : ''}
            {plan.records_changed > 0
              ? ` · ${plan.records_changed} record${plan.records_changed === 1 ? '' : 's'} changed`
              : ''}
          </p>
        </div>
      </div>

      <ol className='mt-2 space-y-1.5'>
        {plan.steps.map((s) => {
          const p = s.preview ?? {}
          const changes = p.changes && typeof p.changes === 'object' ? p.changes : null
          return (
            <li
              key={s.id}
              className='rounded-md border border-amber-200/70 bg-white/70 px-2.5 py-1.5 dark:border-amber-800/60 dark:bg-card'
              data-ai-plan-step={s.state.status}
            >
              <div className='flex items-center gap-1.5'>
                <StepIcon status={s.state.status} />
                <span className='text-[11px] font-medium tabular-nums text-muted-foreground'>
                  {s.n}.
                </span>
                <span className='min-w-0 flex-1 truncate text-[12.5px] text-foreground'>
                  {s.title}
                </span>
                <span className='shrink-0 rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground'>
                  {s.kind_label}
                </span>
              </div>
              {s.condition && (
                <p className='mt-0.5 flex items-center gap-1 pl-5 text-[11px] text-muted-foreground'>
                  <Filter className='h-3 w-3' /> {s.condition}
                </p>
              )}
              {s.preview_changed && (
                <p className='mt-0.5 pl-5 text-[11px] font-medium text-amber-700 dark:text-amber-300'>
                  Re-checked — this step changed since it was proposed.
                </p>
              )}
              {changes && Object.keys(changes).length > 0 && (
                <div className='mt-0.5 space-y-px pl-5'>
                  {Object.entries(changes)
                    .slice(0, 6)
                    .map(([k, v]) => (
                      <p
                        key={k}
                        className='truncate text-[11px] text-slate-700 dark:text-slate-300'
                      >
                        <span className='text-muted-foreground'>{k}</span> → {fmt(v)}
                      </p>
                    ))}
                </div>
              )}
              {p.recipients && p.recipients.length > 0 && (
                <p className='mt-0.5 truncate pl-5 text-[11px] text-muted-foreground'>
                  To {p.recipients.map((r) => r.name).join(', ')}
                  {(p.count ?? 0) > p.recipients.length
                    ? ` +${(p.count ?? 0) - p.recipients.length} more`
                    : ''}
                </p>
              )}
              {p.sample && p.sample.length > 0 && s.kind !== 'create_task' && (
                <p className='mt-0.5 truncate pl-5 text-[11px] text-muted-foreground'>
                  e.g.{' '}
                  {p.sample
                    .slice(0, 4)
                    .map((x) => x.label)
                    .join(' · ')}
                  {(p.count ?? 0) > 4 ? ` +${(p.count ?? 0) - 4} more` : ''}
                </p>
              )}
              {s.state.status === 'done' && s.state.records_changed > 0 && (
                <p className='mt-0.5 pl-5 text-[11px] text-emerald-700 dark:text-emerald-400'>
                  {s.state.records_changed} record{s.state.records_changed === 1 ? '' : 's'} changed
                </p>
              )}
              {s.state.status === 'skipped' && s.state.skip_reason && (
                <p className='mt-0.5 pl-5 text-[11px] text-amber-700 dark:text-amber-300'>
                  Skipped — {s.state.skip_reason}
                </p>
              )}
              {s.state.status !== 'skipped' && (s.state.skipped_records?.length ?? 0) > 0 && (
                <p className='mt-0.5 pl-5 text-[11px] text-amber-700 dark:text-amber-300'>
                  Left out {s.state.skipped_records!.length}:{' '}
                  {s.state
                    .skipped_records!.slice(0, 3)
                    .map((r) => `${r.label ?? r.id} (${r.reason})`)
                    .join('; ')}
                </p>
              )}
              {s.state.status === 'failed' && s.state.error && (
                <p className='mt-0.5 pl-5 text-[11px] text-rose-700 dark:text-rose-400'>
                  {s.state.error}
                </p>
              )}
            </li>
          )
        })}
      </ol>

      {error && <p className='mt-2 text-[11.5px] text-rose-700 dark:text-rose-400'>{error}</p>}

      <div className='mt-2 flex flex-wrap items-center gap-2'>
        {canRun && client && (
          <>
            <Button
              size='sm'
              className='h-7 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
              disabled={!!busy}
              onClick={() => act('run', { mode: 'all' })}
              data-ai-plan-run='all'
            >
              {busy === 'run' ? <Loader2 className='h-3 w-3 animate-spin' /> : null}
              {plan.status === 'paused' ? 'Run the rest' : 'Approve & run all'}
            </Button>
            {pending > 1 && (
              <Button
                size='sm'
                variant='outline'
                className='h-7'
                disabled={!!busy}
                onClick={() => act('run', { mode: 'next' })}
                data-ai-plan-run='next'
              >
                Run next step
              </Button>
            )}
            <Button
              size='sm'
              variant='ghost'
              className='h-7'
              disabled={!!busy}
              onClick={() => act('cancel')}
            >
              Discard
            </Button>
          </>
        )}
        {plan.status === 'running' && (
          <>
            <span className='flex items-center gap-1.5 text-[12px] text-amber-800 dark:text-amber-300'>
              <Loader2 className='h-3 w-3 animate-spin' /> Running…
            </span>
            {client && (
              <Button
                size='sm'
                variant='outline'
                className='h-7'
                disabled={!!busy}
                onClick={() => act('cancel')}
                data-tip='Stop before the next step'
              >
                Stop
              </Button>
            )}
          </>
        )}
        {plan.status === 'failed' && client && (
          <>
            <Button
              size='sm'
              variant='outline'
              className='h-7'
              disabled={!!busy}
              onClick={() => act('retry')}
              data-ai-plan-retry
              data-tip='Re-check the failed and remaining steps, then run them again'
            >
              {busy === 'retry' ? (
                <Loader2 className='h-3 w-3 animate-spin' />
              ) : (
                <RotateCcw className='h-3 w-3' />
              )}
              Re-check and retry
            </Button>
            <Button
              size='sm'
              variant='ghost'
              className='h-7'
              disabled={!!busy}
              onClick={() => act('cancel')}
            >
              Discard the rest
            </Button>
          </>
        )}
        {plan.status === 'executed' && (
          <span className='text-[12px] font-medium text-emerald-700 dark:text-emerald-400'>
            Done — {plan.records_changed} record{plan.records_changed === 1 ? '' : 's'} changed
            {skipped > 0 ? `, ${skipped} step${skipped === 1 ? '' : 's'} skipped` : ''}
          </span>
        )}
        {plan.status === 'rejected' && (
          <span className='text-[12px] text-muted-foreground'>
            {done > 0
              ? 'Stopped — the remaining steps did not run.'
              : 'Discarded — nothing changed.'}
          </span>
        )}
        {plan.status === 'expired' && (
          <span className='text-[12px] text-muted-foreground'>Expired — ask again.</span>
        )}
      </div>
    </div>
  )
}
