import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, CalendarCheck, CalendarClock, CalendarX, Loader2 } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { useNivaroClient } from '../../context'
import { del, get, patch, post } from '../../lib/commands'
import { useDeadlineNow } from '../../lib/deadline-ticker'
import { toastError } from '../../lib/error-toast'
import { batchTouches, LIVE_ASPECTS, useLiveRecord } from '../../lib/live'
import {
  type ChipKind,
  changeSentence,
  chipOf,
  countdownPart,
  fullSentence,
  isDue,
  readableRecent,
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
 * Scheduled changes on a record (realtime round 7, item 12; applied on time since 2026-11-15).
 * The header shows the soonest waiting change — "Status changes to Closed · Applies at 5:00 PM
 * (in 2 h 14 m)" — counted on the page's shared clock. When its time comes the server applies
 * it as the person who scheduled it (api services/scheduled-apply.ts) and the chip flips, live,
 * to "Applying…", then "Applied: Status changes to Closed" or "Failed — <reason>" for a day.
 * The popover lists every change with Move / Cancel (waiting) and Undo (applied, 24 h) for its
 * scheduler and administrators.
 *
 * Read as the viewer: the list route cuts values to the fields this person may read, and a
 * change left with none is not shown. Any change to a schedule (made, moved, cancelled,
 * applied, failed, undone) reaches open pages as the `$scheduled` notice and the list is read
 * again. Where a collection does not apply them by itself, a passed one waits for an admin.
 */

export function scheduledChangesKey(collection: string, itemId: string) {
  return ['scheduled-changes', collection, itemId, 'recent'] as const
}

function toLocalInput(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** The top of the next hour, at least 30 minutes away — a fresh time for a failed change. */
function nextHourIso(): string {
  const d = new Date(Date.now() + 30 * 60_000)
  d.setMinutes(0, 0, 0)
  d.setHours(d.getHours() + 1)
  return d.toISOString()
}

const CHIP_TONE: Record<ChipKind, string> = {
  pending:
    'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 dark:border-border dark:bg-muted dark:text-slate-300 dark:hover:bg-muted/70',
  applying:
    'border-sky-200 bg-sky-50 text-sky-800 hover:bg-sky-100 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300 dark:hover:bg-sky-500/15',
  'waiting-admin':
    'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/15',
  applied:
    'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400 dark:hover:bg-emerald-500/15',
  failed:
    'border-red-200 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/15'
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
            status: 'recent'
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
  const rows = useMemo(() => readableRecent(data, fields), [data, fields])
  const now = useDeadlineNow(rows.length > 0)
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

  const chip = chipOf(rows, now)
  if (!chip) return null
  const { kind, row } = chip
  const waiting = rows.filter((r) => r.status === 'pending' || r.status === 'applying').length
  const more = kind === 'pending' || kind === 'applying' ? waiting - 1 : 0
  const Icon =
    kind === 'applied'
      ? CalendarCheck
      : kind === 'failed'
        ? CalendarX
        : kind === 'applying'
          ? Loader2
          : CalendarClock
  const text =
    kind === 'pending'
      ? `${sentenceOf(row)} · Applies at ${whenText(row.scheduled_at, now)} (${countdownPart(row.scheduled_at, now)})`
      : kind === 'applying'
        ? `${sentenceOf(row)} · Applying now…`
        : kind === 'waiting-admin'
          ? `${sentenceOf(row)} · ${countdownPart(row.scheduled_at, now)}, waiting for an administrator`
          : kind === 'applied'
            ? `Applied: ${sentenceOf(row)}`
            : // One word for this state in the chip and the popover: "Not applied".
              `Not applied: ${sentenceOf(row)}`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-scheduled-chip
          data-kind={kind}
          aria-live='polite'
          data-tip={
            kind === 'pending'
              ? fullSentence(sentenceOf(row), whenText(row.scheduled_at, now), row.created_by_name)
              : kind === 'failed'
                ? `${sentenceOf(row)} — not applied: ${row.error_message ?? ''}`
                : undefined
          }
          // Narrow headers (phones): the words wrap inside the chip, never clip.
          className={cn(
            'inline-flex max-w-full items-start gap-1 rounded-[9px] border px-1.5 py-px text-left text-[9.5px] font-medium leading-[14px] transition-colors duration-300 sm:max-w-[420px]',
            CHIP_TONE[kind]
          )}
        >
          <Icon
            aria-hidden
            className={cn(
              'mt-[2px] h-2.5 w-2.5 shrink-0',
              kind === 'pending' && 'text-nvr-cyan',
              kind === 'applying' && 'motion-safe:animate-spin'
            )}
          />
          <span className='min-w-0 tabular-nums [overflow-wrap:anywhere]'>{text}</span>
          {more > 0 && <span className='shrink-0 opacity-70'>+{more}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-[340px] p-0' data-scheduled-panel>
        <div className='border-b border-slate-100 px-3 py-2 dark:border-border'>
          <p className='text-[12.5px] font-semibold text-slate-800 dark:text-slate-100'>
            {rows.length === 1 ? 'Scheduled change' : `${rows.length} scheduled changes`}
          </p>
        </div>
        <ul className='max-h-[320px] divide-y divide-slate-100 overflow-y-auto dark:divide-border'>
          {rows.map((r) => (
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

function StatusLine({ row, now }: { row: ScheduledChangeRow; now: number }) {
  const status = row.status ?? 'pending'
  const at = row.executed_at ? whenText(row.executed_at, now) : null
  if (status === 'pending' || status === 'applying') {
    const due = isDue(row.scheduled_at, now)
    const words =
      status === 'applying' || (due && row.auto_apply !== false)
        ? `${whenText(row.scheduled_at, now)} · applying now…`
        : due
          ? `${whenText(row.scheduled_at, now)} · ${countdownPart(row.scheduled_at, now)} — waiting for an administrator`
          : `Applies at ${whenText(row.scheduled_at, now)} · ${countdownPart(row.scheduled_at, now)}`
    return (
      <p
        className={cn(
          'mt-0.5 text-[11.5px] tabular-nums',
          due && row.auto_apply === false
            ? 'text-amber-700 dark:text-amber-300'
            : 'text-slate-500 dark:text-slate-400'
        )}
      >
        {words}
      </p>
    )
  }
  if (status === 'executed')
    return (
      <p className='mt-0.5 text-[11.5px] tabular-nums text-emerald-700 dark:text-emerald-400'>
        Applied{at ? ` at ${at}` : ''}
        {row.applied_on_time === false ? ' by an administrator' : ''}
      </p>
    )
  if (status === 'failed')
    // The red is the icon and the status word; the reason reads as plain body text.
    return (
      <div className='mt-1 flex items-start gap-1.5 text-[11.5px] leading-snug'>
        <AlertCircle aria-hidden className='mt-px h-3.5 w-3.5 shrink-0 text-red-500' />
        <p className='text-slate-600 dark:text-slate-300'>
          <span className='font-medium text-red-700 dark:text-red-400'>Not applied</span>
          {at ? ` (${at})` : ''} — {row.error_message || 'it was refused'}. Nothing on the record
          was changed.
        </p>
      </div>
    )
  return (
    <p className='mt-0.5 text-[11.5px] tabular-nums text-slate-500 dark:text-slate-400'>
      Undone{at ? ` at ${at}` : ''}
    </p>
  )
}

// Real buttons (bordered), flush with the text column above them.
const ROW_BUTTON =
  'inline-flex h-7 items-center rounded-md border border-slate-200 bg-white px-2.5 text-[11.5px] font-medium text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:opacity-50 dark:border-border dark:bg-transparent dark:text-slate-200 dark:hover:bg-muted'
const ROW_BUTTON_DANGER =
  'inline-flex h-7 items-center rounded-md border border-red-200 bg-white px-2.5 text-[11.5px] font-medium text-red-700 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 disabled:opacity-50 dark:border-red-500/40 dark:bg-transparent dark:text-red-400 dark:hover:bg-red-500/10'
const ROW_BUTTON_ARMED =
  'inline-flex h-7 items-center rounded-md border border-red-600 bg-red-600 px-2.5 text-[11.5px] font-medium text-white transition-colors hover:bg-red-700 dark:border-red-500 dark:bg-red-500/90'

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
  const status = row.status ?? 'pending'
  const cancel = useMutation({
    mutationFn: () => client.request(del(`/scheduled-changes/${encodeURIComponent(row.id)}`)),
    onSuccess: onChanged,
    onError: (e) =>
      toastError(e, status === 'failed' ? 'Could not dismiss it' : 'Could not cancel the change')
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
    onError: (e) =>
      toastError(
        e,
        status === 'failed' ? 'Could not schedule it again' : 'Could not move the change'
      )
  })
  const undo = useMutation({
    mutationFn: () =>
      client.request(post(`/scheduled-changes/${encodeURIComponent(row.id)}/undo`, {})),
    onSuccess: onChanged,
    onError: (e) => toastError(e, 'Could not undo the change')
  })
  const atValid = at !== '' && !Number.isNaN(new Date(at).getTime())
  const undoOpen =
    status === 'executed' &&
    row.can_undo === true &&
    !!row.undo_until &&
    new Date(row.undo_until).getTime() > now
  return (
    <li className='px-3 py-2.5' data-scheduled-row={row.id} data-status={status}>
      <p className='text-[12.5px] font-medium leading-snug text-slate-800 dark:text-slate-100'>
        {sentence}
      </p>
      <StatusLine row={row} now={now} />
      {row.created_by_name && (
        <p className='mt-0.5 text-[11px] text-slate-500 dark:text-slate-400'>
          Scheduled by {row.created_by_name}
        </p>
      )}
      {row.can_manage &&
        (status === 'pending' || status === 'failed') &&
        (moving ? (
          <div className='mt-2 flex items-center gap-1.5'>
            <label htmlFor={id} className='sr-only'>
              {status === 'failed' ? 'Try again at' : 'New time'}
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
            <button type='button' onClick={() => setMoving(false)} className={ROW_BUTTON}>
              Back
            </button>
          </div>
        ) : (
          <div className='mt-2 flex flex-wrap items-center gap-1.5'>
            <button
              type='button'
              onClick={() => {
                // A failed change's own time has passed: offer the next hour instead.
                if (status === 'failed') setAt(toLocalInput(nextHourIso()))
                setMoving(true)
              }}
              className={ROW_BUTTON}
            >
              {status === 'failed' ? 'Reschedule…' : 'Move…'}
            </button>
            {status === 'failed' ? (
              <button
                type='button'
                onClick={() => cancel.mutate()}
                disabled={cancel.isPending}
                data-tip='Take this off the record header. Nothing on the record changes.'
                className={ROW_BUTTON}
              >
                Dismiss
              </button>
            ) : (
              <ConfirmButton
                onConfirm={() => cancel.mutate()}
                disabled={cancel.isPending}
                title='Cancel this change'
                confirmLabel='Cancel it?'
                className={ROW_BUTTON_DANGER}
                armedClassName={ROW_BUTTON_ARMED}
              >
                Cancel change
              </ConfirmButton>
            )}
          </div>
        ))}
      {undoOpen && (
        <div className='mt-2 flex flex-wrap items-center gap-2'>
          <ConfirmButton
            onConfirm={() => undo.mutate()}
            disabled={undo.isPending}
            title='Put back the values this change replaced'
            confirmLabel='Undo it?'
            className={ROW_BUTTON}
            armedClassName='inline-flex h-7 items-center rounded-md border border-amber-300 bg-amber-50 px-2.5 text-[11.5px] font-medium text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200'
          >
            Undo
          </ConfirmButton>
          <span className='text-[11px] text-slate-500 dark:text-slate-400'>
            Possible until {whenText(row.undo_until as string, now)}
          </span>
        </div>
      )}
    </li>
  )
}
