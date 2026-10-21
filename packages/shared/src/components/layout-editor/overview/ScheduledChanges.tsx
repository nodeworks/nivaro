import { AlertTriangle, CalendarClock } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { formatDateTime } from '../../../lib/utils'
import { type ScheduleRow, useScheduleActions } from '../history-api'
import { parseSaveFailure } from '../useLayoutDraft'

const linkBtn =
  'text-[11.5px] font-medium text-slate-600 underline underline-offset-2 hover:text-slate-900 disabled:opacity-50 dark:text-slate-300 dark:hover:text-foreground'

/**
 * A form's scheduled layout changes on the overview (#2590): when, who, how
 * many changes, and Cancel (any admin). A change that failed to apply stays
 * here (with why) until dismissed or a week has passed.
 */
export function ScheduledChanges({
  rows,
  collection
}: {
  rows: ScheduleRow[]
  collection: string
}) {
  const { cancel } = useScheduleActions(collection)
  const [confirming, setConfirming] = useState<number | null>(null)
  if (rows.length === 0) return null
  const drop = (id: number) =>
    cancel.mutate(id, {
      onSuccess: () => setConfirming(null),
      onError: (e) => toast.error(parseSaveFailure(e, 'Could not cancel').message)
    })
  return (
    <div className='mt-1 space-y-0.5' data-scheduled-changes=''>
      {rows.map((r) => {
        const who = r.created_by_name ?? 'an admin'
        const changes = `${r.op_count} ${r.op_count === 1 ? 'change' : 'changes'}`
        if (r.status === 'failed')
          return (
            <div
              key={r.id}
              data-schedule-row={r.id}
              data-schedule-status='failed'
              className='flex flex-wrap items-start gap-x-1.5 text-[11.5px] text-amber-700 dark:text-amber-300'
            >
              <AlertTriangle className='mt-[2px] h-3 w-3 shrink-0' />
              <span className='min-w-0 flex-1'>
                Scheduled change by {who} for {formatDateTime(r.run_at)} was not applied
                {r.error ? `: ${r.error}` : ''}
              </span>
              <button
                type='button'
                className={linkBtn}
                disabled={cancel.isPending}
                onClick={() => drop(r.id)}
              >
                Dismiss
              </button>
            </div>
          )
        return (
          <div
            key={r.id}
            data-schedule-row={r.id}
            data-schedule-status={r.status}
            className='flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-slate-600 dark:text-slate-300'
          >
            <CalendarClock className='h-3 w-3 shrink-0 text-slate-500 dark:text-slate-400' />
            <span className='min-w-0'>
              {r.status === 'running' ? 'Applying ' : 'Scheduled: '}
              {changes} on {formatDateTime(r.run_at)} by {who}
              {r.note ? ` — ${r.note}` : ''}
            </span>
            {r.status === 'pending' &&
              (confirming === r.id ? (
                <>
                  <button
                    type='button'
                    data-schedule-cancel-confirm={r.id}
                    className={linkBtn}
                    disabled={cancel.isPending}
                    onClick={() => drop(r.id)}
                  >
                    Yes, cancel it
                  </button>
                  <button type='button' className={linkBtn} onClick={() => setConfirming(null)}>
                    Keep
                  </button>
                </>
              ) : (
                <button
                  type='button'
                  data-schedule-cancel={r.id}
                  className={linkBtn}
                  onClick={() => setConfirming(r.id)}
                  data-tip='The changes are dropped and never applied'
                >
                  Cancel
                </button>
              ))}
          </div>
        )
      })}
    </div>
  )
}
