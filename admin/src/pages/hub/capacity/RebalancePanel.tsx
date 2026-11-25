import { ConfirmButton, QueryErrorState } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { cn, formatDateTime } from '@/lib/utils'
import { hubToast } from '../hub-api'
import { dangerArmed, dangerGhost, Field, SectionCard, smallButton } from '../hub-parts'
import { OptionCombobox } from '../move/HubMovePanel'
import {
  cancelRebalance,
  capacityKeys,
  fetchRebalances,
  planRebalance,
  type RebalanceProposal,
  type RebalanceRun,
  type SharedCapacity,
  startRebalance
} from './capacity-api'

/**
 * Rebalance (idea 16): pick two or more shared deployments, see the moves that even out their
 * load (each one planned by the move planner), tick each move's checklist, choose the quiet window
 * and confirm. The Hub then runs the moves one at a time, each a normal move, and stops at the
 * first that does not succeed.
 */

const primary = cn(smallButton, 'bg-nvr-cyan text-white hover:opacity-90 disabled:opacity-50')
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

const STATUS_WORDS: Record<RebalanceRun['status'], string> = {
  running: 'Running',
  cancelling: 'Stopping after the move under way',
  success: 'Done',
  failed: 'Stopped at a failed move',
  cancelled: 'Cancelled'
}

const STATUS_TONE: Record<RebalanceRun['status'], string> = {
  running:
    'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200',
  cancelling:
    'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200',
  success:
    'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200',
  failed:
    'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200',
  cancelled:
    'border-slate-200 bg-slate-50 text-slate-700 dark:border-border dark:bg-muted dark:text-slate-300'
}

const ZONES = (() => {
  try {
    return (
      (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
        'timeZone'
      ) ?? ['UTC']
    )
  } catch {
    return ['UTC']
  }
})()

export function RebalancePanel({ shared }: { shared: SharedCapacity[] }) {
  const qc = useQueryClient()
  const active = shared.filter((s) => s.status === 'active')
  const [picked, setPicked] = useState<number[]>([])
  const [proposal, setProposal] = useState<RebalanceProposal | null>(null)
  const [ticks, setTicks] = useState<Record<number, Record<string, boolean>>>({})
  const [start, setStart] = useState('01:00')
  const [end, setEnd] = useState('05:00')
  const [tz, setTz] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
  const [confirm, setConfirm] = useState('')
  const runs = useQuery({
    queryKey: capacityKeys.rebalances(),
    queryFn: fetchRebalances,
    refetchInterval: (q) =>
      q.state.data?.some((r) => r.status === 'running' || r.status === 'cancelling')
        ? 10_000
        : false
  })
  const plan = useMutation({
    mutationFn: () => planRebalance(picked, 5),
    onSuccess: (p) => {
      setProposal(p)
      setTicks({})
      setConfirm('')
    },
    onError: (err) => hubToast(err, 'Could not plan the rebalance')
  })
  const runnable = useMemo(
    () => (proposal?.moves ?? []).filter((m) => !m.cannot_run && m.plan_hash),
    [proposal]
  )
  const openItems = runnable.flatMap((m) =>
    m.checklist
      .filter((c) => c.required && !ticks[m.env_id]?.[c.id])
      .map((c) => `${m.label}: ${c.id}`)
  )
  const windowBad = !HHMM.test(start) || !HHMM.test(end)
  const go = useMutation({
    mutationFn: () =>
      startRebalance({
        shared_ids: picked,
        moves: runnable.map((m) => ({
          env_id: m.env_id,
          to_shared_id: m.to_shared_id,
          pool_max: m.pool,
          plan_hash: m.plan_hash as string,
          checklist: ticks[m.env_id] ?? {}
        })),
        window: { start, end, tz },
        confirm
      }),
    onSuccess: () => {
      setProposal(null)
      setPicked([])
      void qc.invalidateQueries({ queryKey: capacityKeys.rebalances() })
    },
    onError: (err) => hubToast(err, 'Could not start the rebalance')
  })
  const stop = useMutation({
    mutationFn: cancelRebalance,
    onSuccess: () => void qc.invalidateQueries({ queryKey: capacityKeys.rebalances() }),
    onError: (err) => hubToast(err, 'Could not cancel the rebalance')
  })
  const keyOf = (id: number) => shared.find((s) => s.id === id)?.key ?? `#${id}`

  return (
    <SectionCard
      title='Rebalance'
      description='Even out the load of two or more shared deployments: moves run one at a time, each a normal move, only inside the quiet window, and stop at the first that does not succeed.'
    >
      <div className='space-y-4 p-4'>
        {active.length < 2 ? (
          <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
            Needs two active shared deployments.
          </p>
        ) : (
          <fieldset className='m-0 min-w-0 border-0 p-0'>
            <legend className='mb-2 text-[12px] font-medium text-slate-700 dark:text-foreground'>
              Deployments to rebalance
            </legend>
            <div className='flex flex-wrap gap-x-5 gap-y-2'>
              {active.map((s) => (
                <label
                  key={s.id}
                  htmlFor={`rb-shared-${s.id}`}
                  className='inline-flex items-center gap-2 text-[13px]'
                >
                  <Checkbox
                    id={`rb-shared-${s.id}`}
                    checked={picked.includes(s.id)}
                    onCheckedChange={(v) => {
                      setProposal(null)
                      setPicked((p) => (v ? [...p, s.id] : p.filter((x) => x !== s.id)))
                    }}
                  />
                  <span className='font-mono'>{s.key}</span>
                </label>
              ))}
            </div>
            <div className='mt-3'>
              <button
                type='button'
                className={primary}
                disabled={picked.length < 2 || plan.isPending}
                onClick={() => plan.mutate()}
              >
                {plan.isPending ? 'Planning…' : 'Plan the moves'}
              </button>
            </div>
          </fieldset>
        )}

        {proposal && (
          <div className='space-y-3'>
            <div className='overflow-hidden rounded-lg border border-slate-200 dark:border-border'>
              <table className='w-full text-[12px]'>
                <thead className='bg-slate-50 text-left text-slate-500 dark:bg-muted/40 dark:text-muted-foreground'>
                  <tr>
                    <th className='px-3 py-2 font-medium'>Deployment</th>
                    <th className='px-3 py-2 text-right font-medium'>Load now</th>
                    <th className='px-3 py-2 text-right font-medium'>After the moves</th>
                  </tr>
                </thead>
                <tbody>
                  {proposal.shared.map((s) => (
                    <tr key={s.id} className='border-t border-slate-100 dark:border-border'>
                      <td className='px-3 py-1.5 font-mono'>{s.key}</td>
                      <td className='px-3 py-1.5 text-right tabular-nums'>
                        {s.load_before.toLocaleString('en-US')} ms/min
                      </td>
                      <td className='px-3 py-1.5 text-right tabular-nums'>
                        {s.load_after.toLocaleString('en-US')} ms/min
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {proposal.moves.length === 0 ? (
              <p className='m-0 text-[12px] text-slate-600 dark:text-muted-foreground'>
                Nothing to move: these deployments are already even, or no app can move.
              </p>
            ) : (
              <ol className='m-0 list-none space-y-2 p-0'>
                {proposal.moves.map((m, i) => (
                  <li
                    key={m.env_id}
                    className='rounded-lg border border-slate-200 p-3 dark:border-border'
                  >
                    <p className='m-0 text-[13px]'>
                      {i + 1}. <span className='font-mono'>{m.label}</span> from{' '}
                      <span className='font-mono'>{keyOf(m.from_shared_id)}</span> to{' '}
                      <span className='font-mono'>{keyOf(m.to_shared_id)}</span>
                      <span className='text-slate-500 dark:text-muted-foreground'>
                        {' '}
                        · load {m.load.toLocaleString('en-US')} ms/min · {m.pool} connections
                      </span>
                    </p>
                    {m.cannot_run ? (
                      <p className='m-0 mt-1 text-[12px] text-amber-700 dark:text-amber-300'>
                        Left out: {m.cannot_run}
                      </p>
                    ) : (
                      m.checklist.length > 0 && (
                        <ul className='m-0 mt-2 list-none space-y-1.5 p-0'>
                          {m.checklist.map((c) => (
                            <li key={c.id}>
                              <label
                                htmlFor={`rb-${m.env_id}-${c.id}`}
                                className='flex items-start gap-2 text-[12px]'
                              >
                                <Checkbox
                                  id={`rb-${m.env_id}-${c.id}`}
                                  className='mt-0.5'
                                  checked={!!ticks[m.env_id]?.[c.id]}
                                  onCheckedChange={(v) =>
                                    setTicks((t) => ({
                                      ...t,
                                      [m.env_id]: { ...(t[m.env_id] ?? {}), [c.id]: v === true }
                                    }))
                                  }
                                />
                                <span>
                                  {c.text}
                                  {c.required ? '' : ' (optional)'}
                                </span>
                              </label>
                            </li>
                          ))}
                        </ul>
                      )
                    )}
                  </li>
                ))}
              </ol>
            )}
            {proposal.held.length > 0 && (
              <details className='text-[12px] text-slate-600 dark:text-muted-foreground'>
                <summary className='cursor-pointer'>
                  {proposal.held.length} {proposal.held.length === 1 ? 'app stays' : 'apps stay'}{' '}
                  where {proposal.held.length === 1 ? 'it is' : 'they are'}
                </summary>
                <ul className='m-0 mt-1 pl-5'>
                  {proposal.held.map((h) => (
                    <li key={h.env_id}>
                      <span className='font-mono'>{h.label}</span>: {h.why}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {runnable.length > 0 && (
              <div className='grid gap-3 sm:grid-cols-4'>
                <Field
                  id='rb-start'
                  label='Window starts'
                  error={HHMM.test(start) ? null : 'HH:MM'}
                >
                  <Input
                    id='rb-start'
                    value={start}
                    onChange={(e) => setStart(e.target.value)}
                    className='h-8 text-[13px] tabular-nums'
                  />
                </Field>
                <Field id='rb-end' label='Window ends' error={HHMM.test(end) ? null : 'HH:MM'}>
                  <Input
                    id='rb-end'
                    value={end}
                    onChange={(e) => setEnd(e.target.value)}
                    className='h-8 text-[13px] tabular-nums'
                  />
                </Field>
                <Field id='rb-tz' label='Time zone'>
                  <OptionCombobox
                    id='rb-tz'
                    label='Time zone'
                    value={tz}
                    onChange={setTz}
                    options={ZONES.map((z) => ({ value: z, label: z }))}
                  />
                </Field>
                <Field id='rb-confirm' label='Type rebalance to confirm'>
                  <Input
                    id='rb-confirm'
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    autoComplete='off'
                    className='h-8 text-[13px]'
                  />
                </Field>
                <div className='sm:col-span-4 flex flex-wrap items-center justify-end gap-3'>
                  {openItems.length > 0 && (
                    <span className='text-[12px] text-amber-700 dark:text-amber-300'>
                      Tick every required item first ({openItems.length} open).
                    </span>
                  )}
                  <button
                    type='button'
                    className={primary}
                    disabled={
                      go.isPending || windowBad || openItems.length > 0 || confirm !== 'rebalance'
                    }
                    onClick={() => go.mutate()}
                  >
                    {go.isPending
                      ? 'Starting…'
                      : `Start ${runnable.length} ${runnable.length === 1 ? 'move' : 'moves'}`}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        <div className='space-y-2'>
          <h4 className='m-0 text-[12px] font-medium text-slate-700 dark:text-foreground'>
            Rebalances
          </h4>
          {runs.isPending ? (
            <Skeleton className='h-12 w-full' />
          ) : runs.isError ? (
            <QueryErrorState
              error={runs.error}
              what='the rebalances'
              onRetry={() => void runs.refetch()}
            />
          ) : !runs.data?.length ? (
            <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>None yet.</p>
          ) : (
            <ul className='m-0 list-none space-y-2 p-0'>
              {runs.data.map((r) => (
                <li
                  key={r.id}
                  className='rounded-lg border border-slate-200 p-3 dark:border-border'
                >
                  <div className='flex flex-wrap items-center gap-2'>
                    <span className='text-[13px] font-medium'>Rebalance {r.id}</span>
                    <span
                      className={cn(
                        'rounded-full border px-2 py-0.5 text-[11px]',
                        STATUS_TONE[r.status]
                      )}
                    >
                      {STATUS_WORDS[r.status]}
                    </span>
                    <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
                      {r.shared_ids.map(keyOf).join(' · ')} · window {r.window_start}–{r.window_end}{' '}
                      {r.window_tz}
                      {r.created_at ? ` · ${formatDateTime(r.created_at)}` : ''}
                    </span>
                    <span className='flex-1' />
                    {(r.status === 'running' || r.status === 'cancelling') && (
                      <ConfirmButton
                        className={dangerGhost}
                        armedClassName={dangerArmed}
                        title='Cancel the rebalance'
                        confirmLabel='Cancel it?'
                        disabled={stop.isPending || r.status === 'cancelling'}
                        onConfirm={() => stop.mutate(r.id)}
                      >
                        Cancel
                      </ConfirmButton>
                    )}
                  </div>
                  <ol className='m-0 mt-2 list-none space-y-0.5 p-0 text-[12px]'>
                    {r.moves.map((m, i) => (
                      <li key={m.env_id} className='flex flex-wrap gap-2'>
                        <span className='tabular-nums text-slate-400'>{i + 1}.</span>
                        <span className='font-mono'>{m.label}</span>
                        <span className='text-slate-500 dark:text-muted-foreground'>
                          → {keyOf(m.to_shared_id)} · {m.result}
                          {m.move_id ? ` (move ${m.move_id})` : ''}
                        </span>
                      </li>
                    ))}
                  </ol>
                  {r.note && r.status !== 'failed' && (
                    <p className='m-0 mt-1 text-[12px] text-slate-600 dark:text-muted-foreground'>
                      {r.note}
                    </p>
                  )}
                  {r.error && (
                    // The server's own sentence (a move code and its plain message).
                    <p className='m-0 mt-1 text-[12px] text-red-700 dark:text-red-300'>{r.error}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </SectionCard>
  )
}
