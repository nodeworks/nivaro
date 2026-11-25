import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ListChecks } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { cn, formatDateTime } from '@/lib/utils'
import { hubToast } from '../hub-api'
import { ghostButton } from '../hub-parts'
import {
  type ChecklistAction,
  type ChecklistEntry,
  type ChecklistTarget,
  type ChecklistView,
  changeKeys,
  fetchChecklist,
  fetchRun,
  openChecklist,
  TICK_BY_WORDS,
  tickItem
} from './changes-api'

export interface ChecklistState {
  /** A checklist applies to this start (production, items set). */
  required: boolean
  /** Every required item is ticked. */
  ready: boolean
  /** The checklist to send as checklist_run_id (null until one is opened). */
  runId: number | null
}

/**
 * The pre-deploy checklist of one start (a production promotion, move or shared upgrade), in the
 * panel that starts it. Renders nothing when no checklist applies. Ticking the first item opens
 * the checklist for this start; the panel sends its id with the start, and its Start button
 * waits for `ready`. Who may tick each item is the server's call (`may_tick`); the others show
 * who can.
 */
export function PreDeployChecklist({
  target,
  action,
  version,
  runId,
  onState,
  className
}: {
  target?: ChecklistTarget
  action?: ChecklistAction
  version?: string | null
  /** An existing checklist (a waiting schedule's) instead of a start's. */
  runId?: number
  onState?: (s: ChecklistState) => void
  className?: string
}) {
  const qc = useQueryClient()
  const key =
    runId != null
      ? changeKeys.run(runId)
      : changeKeys.checklist(
          target ?? { kind: 'environment', envId: 0 },
          action ?? 'promote',
          version ?? null
        )
  const enabled = runId != null || (!!target && !!action && (action === 'move' || !!version))
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      runId != null
        ? fetchRun(runId)
        : fetchChecklist(target as ChecklistTarget, action as ChecklistAction, version ?? null),
    enabled,
    staleTime: 15_000
  })
  const view = q.data
  const required = !!view?.required
  const ready = !!view?.ready
  const id = view?.run?.status === 'open' ? view.run.id : null
  useEffect(() => {
    // Unknown while it loads = wait; a read that failed does not hold the panel (the Hub still
    // refuses a production start without its ticks, and the panel shows that refusal).
    const pending = q.isPending
    onState?.({
      required: enabled ? (view ? required : pending) : false,
      ready,
      runId: id
    })
  }, [enabled, view, required, ready, id, onState, q.isPending])

  const tick = useMutation({
    mutationFn: async (o: { entry: ChecklistEntry; ticked: boolean; note: string | null }) => {
      let current: ChecklistView | undefined = view
      if (current?.run?.status !== 'open') {
        if (!target || !action) throw new Error('No checklist to tick')
        current = await openChecklist(target, action, version ?? null)
      }
      const runOf = current.run?.id
      if (runOf == null) throw new Error('No checklist to tick')
      return tickItem(runOf, o.entry.key, o.ticked, o.note)
    },
    onSuccess: (next) => {
      qc.setQueryData(key, next)
      void qc.invalidateQueries({ queryKey: changeKeys.overview() })
    },
    onError: (err) => hubToast(err, 'Could not tick the item')
  })

  if (!enabled) return null
  if (q.isPending) return <Skeleton className='h-14 w-full' />
  // Quiet on a failed read: the Hub checks the checklist itself when the start is sent.
  if (q.isError)
    return (
      <p className='m-0 flex flex-wrap items-center gap-2 text-[12px] text-slate-600 dark:text-slate-300'>
        Could not read the pre-deploy checklist. The Hub still checks it when you start.
        <button type='button' className={ghostButton} onClick={() => void q.refetch()}>
          Try again
        </button>
      </p>
    )
  if (!view || view.entries.length === 0) return null
  const used = view.run && view.run.status !== 'open'
  const left = view.entries.filter((e) => e.required && !e.tick).length
  return (
    <section
      aria-label='Pre-deploy checklist'
      className={cn(
        'rounded-md border border-slate-200 bg-white dark:border-border dark:bg-card',
        className
      )}
    >
      <header className='flex items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-border'>
        <ListChecks
          className='h-3.5 w-3.5 shrink-0 text-slate-500 dark:text-slate-400'
          aria-hidden
        />
        <h4 className='m-0 min-w-0 flex-1 text-[12px] font-semibold text-slate-900 dark:text-foreground'>
          Pre-deploy checklist
        </h4>
        <span
          className={cn(
            'text-[11px] font-medium tabular-nums',
            used
              ? 'text-slate-500 dark:text-muted-foreground'
              : left
                ? 'text-amber-700 dark:text-amber-300'
                : 'text-emerald-700 dark:text-emerald-300'
          )}
          role='status'
        >
          {used
            ? view.run?.status === 'used'
              ? 'Used for a run'
              : 'Set aside'
            : left
              ? `${left} required left`
              : 'Ready'}
        </span>
      </header>
      <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
        {view.entries.map((e) => (
          <ChecklistRow
            key={e.key}
            entry={e}
            showWhere={new Set(view.entries.map((x) => x.environment_id)).size > 1}
            busy={tick.isPending && tick.variables?.entry.key === e.key}
            onTick={(ticked, note) => tick.mutate({ entry: e, ticked, note })}
          />
        ))}
      </ul>
    </section>
  )
}

function whoMay(e: ChecklistEntry): string {
  if (e.tick_by !== 'people') return TICK_BY_WORDS[e.tick_by]
  const names = e.tick_people.map((_, i) => e.tick_people_names[i] ?? 'a named person')
  return names.join(', ')
}

function ChecklistRow({
  entry,
  showWhere,
  busy,
  onTick
}: {
  entry: ChecklistEntry
  showWhere: boolean
  busy: boolean
  onTick: (ticked: boolean, note: string | null) => void
}) {
  const id = useId()
  const [note, setNote] = useState('')
  const done = !!entry.tick
  return (
    <li className='flex items-start gap-2.5 px-3 py-2'>
      <Checkbox
        id={id}
        checked={done}
        disabled={!entry.may_tick || busy}
        onCheckedChange={(v) => onTick(v === true, v === true ? note.trim() || null : null)}
        className='mt-0.5 data-[state=checked]:border-emerald-600 data-[state=checked]:bg-emerald-600 data-[state=checked]:text-white dark:data-[state=checked]:border-emerald-500 dark:data-[state=checked]:bg-emerald-500'
      />
      <div className='min-w-0 flex-1 space-y-0.5'>
        <label
          htmlFor={id}
          className='block text-[12px] leading-snug text-slate-800 dark:text-slate-100'
        >
          {entry.text}
          {!entry.required && (
            <span className='ml-1.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
              optional
            </span>
          )}
          {showWhere && (
            <span className='ml-1.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
              {entry.app_key} · {entry.env_key}
            </span>
          )}
        </label>
        {entry.help && (
          <p className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>{entry.help}</p>
        )}
        {entry.tick ? (
          <p className='m-0 text-[11px] text-slate-600 dark:text-slate-300'>
            Ticked by {entry.tick.by_name ?? 'someone'} · {formatDateTime(entry.tick.at)}
            {entry.tick.note ? ` — ${entry.tick.note}` : ''}
          </p>
        ) : entry.may_tick ? (
          <Input
            value={note}
            onChange={(ev) => setNote(ev.target.value)}
            placeholder='Note (optional), sent with the tick'
            aria-label={`Note for “${entry.text}”`}
            maxLength={500}
            className='mt-1 h-7 max-w-[360px] text-[12px]'
          />
        ) : (
          <p className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
            Ticked by: {whoMay(entry)}
          </p>
        )}
      </div>
    </li>
  )
}
