import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { useNivaroClient } from '../../context'
import { del, get, patch } from '../../lib/commands'
import { useDeadlineNow } from '../../lib/deadline-ticker'
import { toastError } from '../../lib/error-toast'
import { batchTouches, LIVE_ASPECTS, useLiveRecord } from '../../lib/live'
import {
  changeSentence,
  countdownPart,
  fullSentence,
  isDue,
  readablePending,
  type ScheduledChangeRow,
  whenText
} from '../../lib/scheduled-countdown'
import { cn, titleCase } from '../../lib/utils'
import { ConfirmButton } from '../profile/primitives'
import { Input } from '../ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { formatDisplayValue } from './GroupSection'
import type { CMSField, CMSRelation } from './types'

/**
 * Countdown for scheduled changes (realtime round 7, item 12). A record with a pending
 * scheduled change (Deadlines → Scheduled changes, or the record's "Schedule a change…")
 * shows the soonest one in its header — "Status changes to Closed · in 2 h 14 m" — counted on
 * the page's shared clock; the popover says it in full ("… at 5:00 PM (scheduled by Mark)")
 * and lists every pending change, with Move / Cancel for its scheduler and administrators.
 *
 * Read as the viewer: the list route cuts values to the fields this person may read, and a
 * change left with none is not shown. Any change to a schedule (made, moved, cancelled,
 * applied) reaches open pages as the `$scheduled` notice and the list is read again.
 * Nothing applies a change on its own at its time yet, so a passed one says it is waiting.
 */

export function scheduledChangesKey(collection: string, itemId: string) {
  return ['scheduled-changes', collection, itemId, 'pending'] as const
}

function toLocalInput(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export function ScheduledChangeChip({
  collection,
  itemId,
  fields,
  relations
}: {
  collection: string
  itemId: string
  fields: CMSField[] | null | undefined
  relations?: CMSRelation[] | null
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const key = scheduledChangesKey(collection, itemId)
  const { data } = useQuery<ScheduledChangeRow[]>({
    queryKey: key,
    queryFn: () =>
      client
        .request<{ data: ScheduledChangeRow[] }>(
          get(`/scheduled-changes/${collection}/${encodeURIComponent(itemId)}`, {
            status: 'pending'
          })
        )
        .then((r) => r.data ?? [])
        // No access to the list (or an older server): no chip, no error.
        .catch(() => []),
    staleTime: 60_000
  })
  useLiveRecord(
    collection,
    itemId,
    (batch) => {
      if (batchTouches(batch, LIVE_ASPECTS.scheduled)) void qc.invalidateQueries({ queryKey: key })
    },
    { includeOwn: true, debounceMs: 300 }
  )
  const pending = useMemo(() => readablePending(data, fields), [data, fields])
  const now = useDeadlineNow(pending.length > 0)
  const [open, setOpen] = useState(false)

  const byField = useMemo(() => new Map((fields ?? []).map((f) => [f.field, f])), [fields])
  const isRelation = (field: string) =>
    (relations ?? []).some(
      (r) => r.many_collection === collection && r.many_field === field && !r.junction_field
    )
  const labelOf = (field: string) =>
    byField.get(field)?.label || titleCase(field.replace(/_/g, ' '))
  const formatValue = (field: string, v: unknown) =>
    isRelation(field) ? 'a new value' : formatDisplayValue(v, byField.get(field))
  const sentenceOf = (r: ScheduledChangeRow) =>
    changeSentence(r.changes ?? {}, labelOf, formatValue)

  if (pending.length === 0) return null
  const next = pending[0]
  const due = isDue(next.scheduled_at, now)
  const more = pending.length - 1

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-scheduled-chip
          data-due={due ? '' : undefined}
          data-tip={fullSentence(
            sentenceOf(next),
            whenText(next.scheduled_at, now),
            next.created_by_name
          )}
          className={cn(
            'inline-flex max-w-[320px] items-center gap-1 rounded-full border px-1.5 py-px text-[9.5px] font-medium transition-colors',
            due
              ? 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/15'
              : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 dark:border-border dark:bg-muted dark:text-slate-300 dark:hover:bg-muted/70'
          )}
        >
          <CalendarClock
            aria-hidden
            className={cn('h-2.5 w-2.5 shrink-0', due ? 'text-amber-600' : 'text-nvr-cyan')}
          />
          <span className='truncate'>{sentenceOf(next)}</span>
          <span className='shrink-0 tabular-nums opacity-80'>
            · {countdownPart(next.scheduled_at, now)}
          </span>
          {more > 0 && <span className='shrink-0 opacity-70'>+{more}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-[340px] p-0' data-scheduled-panel>
        <div className='border-b border-slate-100 px-3 py-2 dark:border-border'>
          <p className='text-[12.5px] font-semibold text-slate-800 dark:text-slate-100'>
            {pending.length === 1 ? 'Scheduled change' : `${pending.length} scheduled changes`}
          </p>
        </div>
        <ul className='max-h-[320px] divide-y divide-slate-100 overflow-y-auto dark:divide-border'>
          {pending.map((r) => (
            <ScheduledRow
              key={r.id}
              row={r}
              now={now}
              sentence={sentenceOf(r)}
              onChanged={() => void qc.invalidateQueries({ queryKey: key })}
            />
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

function ScheduledRow({
  row,
  now,
  sentence,
  onChanged
}: {
  row: ScheduledChangeRow
  now: number
  sentence: string
  onChanged: () => void
}) {
  const client = useNivaroClient()
  const id = useId()
  const [moving, setMoving] = useState(false)
  const [at, setAt] = useState(() => toLocalInput(row.scheduled_at))
  const due = isDue(row.scheduled_at, now)
  const cancel = useMutation({
    mutationFn: () => client.request(del(`/scheduled-changes/${encodeURIComponent(row.id)}`)),
    onSuccess: onChanged,
    onError: (e) => toastError(e, 'Could not cancel the change')
  })
  const move = useMutation({
    mutationFn: () =>
      client.request(
        patch(`/scheduled-changes/${encodeURIComponent(row.id)}`, {
          // datetime-local is the viewer's local time; the API stores UTC.
          scheduled_at: new Date(at).toISOString()
        })
      ),
    onSuccess: () => {
      setMoving(false)
      onChanged()
    },
    onError: (e) => toastError(e, 'Could not move the change')
  })
  const atValid = at !== '' && !Number.isNaN(new Date(at).getTime())
  return (
    <li className='px-3 py-2.5' data-scheduled-row={row.id}>
      <p className='text-[12.5px] font-medium leading-snug text-slate-800 dark:text-slate-100'>
        {sentence}
      </p>
      <p
        className={cn(
          'mt-0.5 text-[11.5px] tabular-nums',
          due ? 'text-amber-700 dark:text-amber-300' : 'text-slate-500 dark:text-slate-400'
        )}
      >
        {whenText(row.scheduled_at, now)} · {countdownPart(row.scheduled_at, now)}
        {due && ' — waiting to be applied'}
      </p>
      {row.created_by_name && (
        <p className='mt-0.5 text-[11px] text-slate-400 dark:text-slate-500'>
          Scheduled by {row.created_by_name}
        </p>
      )}
      {row.can_manage &&
        (moving ? (
          <div className='mt-2 flex items-center gap-1.5'>
            <label htmlFor={id} className='sr-only'>
              New time
            </label>
            <Input
              id={id}
              type='datetime-local'
              value={at}
              onChange={(e) => setAt(e.target.value)}
              className='h-7 flex-1 text-[12px]'
            />
            <button
              type='button'
              disabled={!atValid || move.isPending}
              onClick={() => move.mutate()}
              className='h-7 rounded-md bg-nvr-cyan px-2.5 text-[11.5px] font-medium text-white disabled:opacity-50'
            >
              Save
            </button>
            <button
              type='button'
              onClick={() => setMoving(false)}
              className='h-7 rounded-md px-2 text-[11.5px] text-slate-500 hover:bg-muted dark:text-slate-400'
            >
              Back
            </button>
          </div>
        ) : (
          <div className='mt-1.5 flex items-center gap-1'>
            <button
              type='button'
              onClick={() => setMoving(true)}
              className='rounded px-1.5 py-0.5 text-[11.5px] font-medium text-slate-600 hover:bg-muted dark:text-slate-300'
            >
              Move…
            </button>
            <ConfirmButton
              onConfirm={() => cancel.mutate()}
              disabled={cancel.isPending}
              title='Cancel this change'
              confirmLabel='Cancel it?'
              className='rounded px-1.5 py-0.5 text-[11.5px] font-medium text-slate-600 hover:bg-muted dark:text-slate-300'
              armedClassName='rounded px-1.5 py-0.5 text-[11.5px] font-medium text-red-600 bg-red-50 dark:bg-red-500/10 dark:text-red-400'
            >
              Cancel change
            </ConfirmButton>
          </div>
        ))}
    </li>
  )
}
