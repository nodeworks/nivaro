import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Undo2 } from 'lucide-react'
import { useState } from 'react'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { cn, formatNumber, formatRelative } from '../../lib/utils'
import { ErrorNotice } from '../ErrorNotice'
import { Button } from '../ui/button'

/**
 * Undo an Ask AI plan's writes (#1954; Rob 2026-11-18 "make it reversible what they
 * delete / change / create") — on the AI plans page and on the plan card in a
 * conversation. The server says, per step, how many records can be put back as they
 * were, how many someone changed since (left alone unless the administrator chooses
 * to overwrite them) and how many are gone. A big undo runs in the background: the
 * panel shows how far it got and polls until it ends. Every undo is two presses.
 */

export interface AiUndoRecord {
  id: string
  collection: string
  label: string
  status: 'revertible' | 'changed' | 'gone' | 'undone'
  op?: 'update' | 'create' | 'delete'
  reason?: string
}

export interface AiUndoStep {
  step_id: string
  n: number
  title: string
  kind_label: string
  not_revertible?: string
  revertible: number
  blocked: number
  changed?: number
  gone?: number
  undone?: number
  total?: number
  undone_at: string | null
  expires_at?: string | null
  records: AiUndoRecord[]
}

export interface AiUndoRun {
  status: 'running' | 'done' | 'failed'
  started_at: string
  finished_at?: string | null
  overwrite: boolean
  total: number
  done: number
  undone: number
  skipped: number
  failed: number
  errors: string[]
}

interface UndoCheck {
  steps: AiUndoStep[]
  run?: AiUndoRun | null
  retention_days?: number
}

interface UndoResult {
  undone: number
  skipped: number
  failed: number
  errors: string[]
  overwritten?: number
  running?: boolean
  total?: number
}

const POLL_MS = 2000

/** What undo does to one record, said as the verb. */
const OP_VERB: Record<string, string> = {
  update: 'Put back',
  create: 'Remove',
  delete: 'Restore'
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`
}

function resultText(d: UndoResult | AiUndoRun): string {
  const parts = [`Put back ${plural(d.undone, 'record')}`]
  if ('overwritten' in d && d.overwritten) parts.push(`${formatNumber(d.overwritten)} overwritten`)
  if (d.skipped) parts.push(`${formatNumber(d.skipped)} left alone (changed or deleted since)`)
  if (d.failed)
    parts.push(`${formatNumber(d.failed)} failed${d.errors[0] ? `: ${d.errors[0]}` : ''}`)
  return `${parts.join(' · ')}.`
}

export function AiPlanUndo({
  id,
  base = '/ai/plans',
  embedded,
  className
}: {
  id: string
  /** The route family (the task-do owner undoes through its own). */
  base?: string
  /** Inside a plan card: no frame of its own. */
  embedded?: boolean
  className?: string
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [confirm, setConfirm] = useState<string | null>(null)
  const [overwrite, setOverwrite] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const check = useQuery({
    queryKey: ['ai-plans', 'undo', id],
    queryFn: () =>
      client
        .request<{ data: UndoCheck }>(get(`${base}/${encodeURIComponent(id)}/undo`))
        .then((r) => r.data),
    refetchInterval: (q) =>
      (q.state.data as UndoCheck | undefined)?.run?.status === 'running' ? POLL_MS : false
  })
  const run = check.data?.run ?? null
  const running = run?.status === 'running'
  const steps = check.data?.steps ?? []
  const sum = (k: 'revertible' | 'changed' | 'gone') =>
    steps.reduce((n, s) => n + Number((k === 'revertible' ? s.revertible : s[k]) ?? 0), 0)
  const revertible = sum('revertible')
  const changed = sum('changed')
  const gone = sum('gone')
  const count = (s?: AiUndoStep) =>
    s
      ? s.revertible + (overwrite ? Number(s.changed ?? 0) : 0)
      : revertible + (overwrite ? changed : 0)
  const total = count()

  const go = (stepId: string | null) => {
    setBusy(true)
    setError(null)
    setResult(null)
    void client
      .request<{ data: UndoResult }>(
        post(`${base}/${encodeURIComponent(id)}/undo`, {
          ...(stepId ? { step_id: stepId } : {}),
          ...(overwrite ? { overwrite: true } : {})
        })
      )
      .then((r) => {
        const d = r.data
        if (!d.running) setResult(resultText(d))
        void qc.invalidateQueries({ queryKey: ['ai-plans'] })
      })
      .catch((err) => setError(err))
      .finally(() => {
        setBusy(false)
        setConfirm(null)
      })
  }

  const pct = run && run.total > 0 ? Math.min(100, Math.round((run.done / run.total) * 100)) : 0
  const recentRun =
    run && run.status !== 'running' && run.finished_at
      ? Date.now() - new Date(run.finished_at).getTime() < 24 * 3_600_000
      : false

  return (
    <section
      className={cn(
        embedded
          ? 'mt-2 rounded-md border border-slate-200 bg-white dark:border-border dark:bg-card'
          : 'rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card',
        'animate-in fade-in-0 slide-in-from-top-1 duration-150 motion-reduce:animate-none',
        className
      )}
      data-ai-plan-undo
      aria-label='Undo this plan'
    >
      <div className='flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-slate-100 px-3 py-2 dark:border-border sm:px-4 sm:py-2.5'>
        <Undo2 className='h-4 w-4 shrink-0 text-slate-400' aria-hidden />
        <h2 className='text-[13px] font-semibold text-foreground'>Undo</h2>
        <span className='min-w-0 flex-1 basis-full text-[11.5px] sm:basis-56 text-muted-foreground'>
          Puts each record back as it was before the plan. Records someone changed since are left
          alone unless you choose to overwrite them.
        </span>
      </div>

      {check.isLoading && (
        <p className='flex items-center gap-1.5 px-3 py-3 text-[12px] text-muted-foreground sm:px-4'>
          <Loader2 className='h-3 w-3 animate-spin motion-reduce:animate-none' />
          Checking every record the plan wrote…
        </p>
      )}
      {check.error != null && (
        <ErrorNotice
          error={check.error}
          what='what can be undone'
          onRetry={() => void check.refetch()}
          className='m-3'
        />
      )}

      {running && run && (
        <div
          className='border-b border-slate-100 px-3 py-2.5 dark:border-border sm:px-4'
          data-ai-undo-running
        >
          <div className='flex items-center justify-between gap-2 text-[12px]'>
            <span className='flex items-center gap-1.5 font-medium text-foreground'>
              <Loader2 className='h-3 w-3 animate-spin text-nvr-cyan motion-reduce:animate-none' />
              Undoing in the background
            </span>
            <span className='tabular-nums text-muted-foreground'>
              {formatNumber(run.done)} of {formatNumber(run.total)}
            </span>
          </div>
          <ProgressLine pct={pct} label='Undo progress' />
          <p className='mt-1 text-[11px] text-muted-foreground'>
            {formatNumber(run.undone)} put back
            {run.skipped ? ` · ${formatNumber(run.skipped)} left alone` : ''}
            {run.failed ? ` · ${formatNumber(run.failed)} failed` : ''} — you can leave this page;
            you will get a notification when it ends.
          </p>
        </div>
      )}

      {(result || (recentRun && run)) && !running && (
        <p
          className={cn(
            'border-b border-slate-100 px-3 py-2 text-[12px] dark:border-border sm:px-4',
            run?.status === 'failed' && !result
              ? 'text-rose-700 dark:text-rose-400'
              : 'text-emerald-700 dark:text-emerald-400'
          )}
          role='status'
        >
          {result ??
            (run?.status === 'failed'
              ? `The last undo stopped part-way (${run.errors[0] ?? 'see the activity log'}). Run it again to finish.`
              : run
                ? `Last undo ${formatRelative(run.finished_at ?? run.started_at)}: ${resultText(run)}`
                : '')}
        </p>
      )}
      {error != null && <ErrorNotice error={error} fallback='Could not undo' className='m-3' />}

      {check.data && !running && (revertible > 0 || changed > 0) && (
        <div className='space-y-2 border-b border-slate-100 px-3 py-2.5 dark:border-border sm:px-4'>
          <p className='text-[12px] text-foreground'>
            <span className='font-medium tabular-nums'>{plural(revertible, 'record')}</span> can be
            put back
            {changed > 0 && (
              <>
                {' · '}
                <span className='font-medium tabular-nums text-amber-700 dark:text-amber-300'>
                  {formatNumber(changed)} changed since
                </span>
              </>
            )}
            {gone > 0 && (
              <span className='text-muted-foreground'>
                {' · '}
                {formatNumber(gone)} deleted or replaced since (never touched)
              </span>
            )}
          </p>
          {changed > 0 && (
            <fieldset className='inline-flex flex-wrap gap-1 rounded-md bg-muted p-0.5'>
              <legend className='sr-only'>Records changed since the plan ran</legend>
              {[
                { v: false, label: 'Leave changed records alone' },
                { v: true, label: `Overwrite those ${formatNumber(changed)} too` }
              ].map((o) => (
                <label
                  key={String(o.v)}
                  className={cn(
                    'relative cursor-pointer rounded px-2 py-1 text-[11.5px] transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-nvr-cyan/60 motion-reduce:transition-none',
                    overwrite === o.v
                      ? 'bg-white font-medium text-foreground shadow-sm dark:bg-card'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <input
                    type='radio'
                    name={`ai-undo-overwrite-${id}`}
                    className='sr-only'
                    checked={overwrite === o.v}
                    onChange={() => {
                      setOverwrite(o.v)
                      setConfirm(null)
                    }}
                  />
                  {o.label}
                </label>
              ))}
            </fieldset>
          )}
          {overwrite && changed > 0 && (
            <p className='text-[11.5px] text-amber-800 dark:text-amber-300'>
              Overwriting replaces what people changed after the plan ran with the values from
              before it.
            </p>
          )}
          {total > 0 && (
            <div className='flex flex-wrap items-center gap-2'>
              <Button
                size='sm'
                variant={confirm === '*' ? 'default' : 'outline'}
                className={cn(
                  'h-7',
                  confirm === '*' && 'bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
                )}
                disabled={busy}
                onClick={() => (confirm === '*' ? go(null) : setConfirm('*'))}
                data-ai-undo='all'
              >
                {busy && confirm === '*' ? (
                  <Loader2 className='h-3 w-3 animate-spin motion-reduce:animate-none' />
                ) : null}
                {confirm === '*' ? `Yes, undo ${plural(total, 'record')}` : 'Undo everything'}
              </Button>
              {confirm === '*' && (
                <Button
                  size='sm'
                  variant='ghost'
                  className='h-7'
                  disabled={busy}
                  onClick={() => setConfirm(null)}
                >
                  Keep the changes
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      <ul className='divide-y divide-slate-100 dark:divide-border'>
        {steps.map((s) => {
          const conflicts = s.records.filter((r) => r.status === 'changed' || r.status === 'gone')
          const n = count(s)
          return (
            <li key={s.step_id} className='px-3 py-2.5 sm:px-4'>
              <div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
                <span className='text-[11px] tabular-nums text-muted-foreground'>{s.n}.</span>
                <span className='min-w-[10rem] flex-1 truncate text-[12.5px] text-foreground'>
                  {s.title}
                </span>
                {s.not_revertible ? (
                  <span className='text-[11.5px] text-muted-foreground'>{s.not_revertible}</span>
                ) : (
                  <>
                    <span className='text-[11.5px] tabular-nums text-muted-foreground'>
                      {s.undone_at && s.revertible === 0 && !s.changed
                        ? 'Undone'
                        : `${formatNumber(s.revertible)} can be put back`}
                      {s.changed ? ` · ${formatNumber(s.changed)} changed since` : ''}
                      {s.gone ? ` · ${formatNumber(s.gone)} gone` : ''}
                    </span>
                    {n > 0 && !running && steps.length > 1 && (
                      <Button
                        size='sm'
                        variant='ghost'
                        className='h-6 text-[11.5px]'
                        disabled={busy}
                        onClick={() =>
                          confirm === s.step_id ? go(s.step_id) : setConfirm(s.step_id)
                        }
                      >
                        {confirm === s.step_id ? `Yes, undo ${formatNumber(n)}` : 'Undo step'}
                      </Button>
                    )}
                  </>
                )}
              </div>
              {conflicts.length > 0 && (
                <ul className='mt-1 space-y-px pl-5'>
                  {conflicts.slice(0, 8).map((r) => (
                    <li
                      key={`${r.collection}:${r.id}`}
                      className='truncate text-[11px] text-muted-foreground'
                    >
                      <span className='text-foreground/80'>{r.label}</span> — {r.reason}
                      {r.status === 'changed' && r.op && overwrite
                        ? ` (${OP_VERB[r.op]?.toLowerCase() ?? 'undo'} anyway)`
                        : ''}
                    </li>
                  ))}
                  {(s.changed ?? 0) + (s.gone ?? 0) > Math.min(conflicts.length, 8) && (
                    <li className='text-[11px] text-muted-foreground'>
                      and{' '}
                      {formatNumber(
                        (s.changed ?? 0) + (s.gone ?? 0) - Math.min(conflicts.length, 8)
                      )}{' '}
                      more
                    </li>
                  )}
                </ul>
              )}
              {s.expires_at && !s.not_revertible && (
                <p className='mt-0.5 pl-5 text-[10.5px] text-muted-foreground'>
                  Can be undone until{' '}
                  {new Date(s.expires_at).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric'
                  })}
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** A thin determinate bar — the width eases between pushes; still under reduced motion. */
export function ProgressLine({ pct, label }: { pct: number; label: string }) {
  return (
    <div
      role='progressbar'
      aria-label={label}
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      className='mt-1.5 h-1 w-full overflow-hidden rounded-full bg-slate-200/80 dark:bg-white/10'
    >
      <div
        className='h-full rounded-full bg-nvr-cyan transition-[width] duration-500 ease-out motion-reduce:transition-none'
        style={{ width: `${Math.max(pct, 2)}%` }}
      />
    </div>
  )
}
