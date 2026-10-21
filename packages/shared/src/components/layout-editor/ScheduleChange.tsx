import { CalendarClock } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { formatDateTime } from '../../lib/utils'
import { Popover, PopoverContent } from '../ui/popover'
import {
  fromLocalInput,
  type ScheduleRow,
  toLocalInput,
  useLayoutSchedules,
  useScheduleActions
} from './history-api'
import { barBtn, ToolButton } from './toolbar-kit'
import { unsavedText } from './UnsavedConfirm'
import { type LayoutDraft, parseSaveFailure, useLayoutBundle } from './useLayoutDraft'

const inputCls =
  'h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] text-slate-800 outline-none placeholder:text-slate-400 focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-foreground dark:placeholder:text-muted-foreground'
const labelCls = 'mb-1 block text-[11.5px] font-semibold text-slate-600 dark:text-muted-foreground'

/** "Tomorrow 09:00" as the default time: the next morning, on the hour. */
function nextMorning(now = new Date()): Date {
  const d = new Date(now)
  d.setDate(d.getDate() + 1)
  d.setHours(9, 0, 0, 0)
  return d
}

export function scheduleWhen(row: Pick<ScheduleRow, 'run_at'>): string {
  return formatDateTime(row.run_at)
}

/**
 * "Schedule…" in the Save menu (#2590, manual mode with unsaved changes): the
 * unsaved changes are stored with the rev they were made on and a time, then
 * dropped from the draft. The server applies them then, through the same path
 * a Save takes; if the layout changed meanwhile they apply only if they still
 * fit, else whoever scheduled them is told.
 */
export function ScheduleChange({
  collection,
  layoutId,
  draft
}: {
  collection: string
  layoutId: number
  draft: Pick<LayoutDraft, 'unsavedOps' | 'discard' | 'unsavedCount'>
}) {
  const [open, setOpen] = useState(false)
  const [when, setWhen] = useState(() => toLocalInput(nextMorning()))
  const [note, setNote] = useState('')
  // The server's copy: what the unsaved changes were made on.
  const { data: saved } = useLayoutBundle(layoutId)
  const { data: schedules = [] } = useLayoutSchedules(collection, open)
  const { create } = useScheduleActions(collection)
  const pending = schedules.filter((s) => s.layout_id === layoutId && s.status === 'pending')
  const count = draft.unsavedCount

  const submit = () => {
    const runAt = fromLocalInput(when)
    if (!runAt || !saved) return
    create.mutate(
      { layoutId, ops: draft.unsavedOps(), base_rev: saved.rev, run_at: runAt, note },
      {
        onSuccess: () => {
          draft.discard()
          setOpen(false)
          setNote('')
          toast.success(`Scheduled for ${formatDateTime(runAt)}`)
        },
        onError: (e) => toast.error(parseSaveFailure(e, 'Not scheduled').message)
      }
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ToolButton
        popover
        onOpen={() => setOpen(true)}
        label='Schedule…'
        icon={<CalendarClock className='h-3.5 w-3.5' />}
        tip='Apply these changes at a later time instead of now'
        hint='Apply these changes at a later time'
        disabled={count === 0}
        data={{ 'data-editor-schedule': '' }}
      />
      <PopoverContent align='end' className='w-[320px] p-3' data-schedule-popover=''>
        <p className='mb-2 text-[12.5px] text-slate-700 dark:text-foreground'>
          Apply your {unsavedText(count)} later. They leave the editor now and nobody sees them
          until then.
        </p>
        <label className={labelCls} htmlFor='layout-schedule-when'>
          When
        </label>
        <input
          id='layout-schedule-when'
          type='datetime-local'
          value={when}
          min={toLocalInput(new Date())}
          onChange={(e) => setWhen(e.target.value)}
          className={inputCls}
        />
        <label className={`${labelCls} mt-2`} htmlFor='layout-schedule-note'>
          Note (optional)
        </label>
        <input
          id='layout-schedule-note'
          value={note}
          maxLength={255}
          placeholder='e.g. New fields for the April release'
          onChange={(e) => setNote(e.target.value)}
          className={inputCls}
        />
        <p className='mt-2 text-[11.5px] leading-snug text-slate-500 dark:text-muted-foreground'>
          If someone changes this layout before then, your changes still apply when they fit. If one
          no longer fits, nothing is applied and you are told.
        </p>
        {pending.length > 0 && (
          <p className='mt-2 text-[11.5px] text-slate-600 dark:text-slate-300'>
            Already scheduled for this form:{' '}
            {pending
              .map((s) => `${scheduleWhen(s)} (${s.created_by_name ?? 'an admin'})`)
              .join(', ')}
          </p>
        )}
        <div className='mt-3 flex justify-end gap-2'>
          <button type='button' className={barBtn} onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button
            type='button'
            data-schedule-confirm=''
            disabled={create.isPending || !fromLocalInput(when) || !saved || count === 0}
            onClick={submit}
            className='inline-flex h-8 items-center rounded-md bg-nvr-cyan px-3 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50'
          >
            {create.isPending ? 'Scheduling…' : 'Schedule'}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
