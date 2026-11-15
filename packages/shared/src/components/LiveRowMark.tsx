import { EyeOff, Lock } from 'lucide-react'
import { lockLabel, type RowLock } from '../lib/live-list'
import { GONE_ROW_TITLE } from '../lib/live-list-flow'

/**
 * The 16px leading mark a live list row can carry, in the slot the unseen dot
 * already reserves: "no longer in this view" (a row kept in place under the
 * pointer, lib/live-list-flow.ts) wins, then a lock (someone is editing the
 * record right now), then the "new" dot (the row just slid in). Returns null
 * when none applies so the caller falls back to its usual mark.
 */
export function LiveRowMark({
  lock,
  isNew,
  gone,
  dataAttr = 'data-live-mark',
  hang = false
}: {
  lock?: RowLock | null
  isNew?: boolean
  gone?: boolean
  dataAttr?: string
  /** Hang in the cell's left padding (like UnseenDot's `hang`). */
  hang?: boolean
}) {
  if (!lock && !isNew && !gone) return null
  const kind = gone ? 'gone' : lock ? 'lock' : 'new'
  const tip = gone ? GONE_ROW_TITLE : lock ? lockLabel(lock) : 'New — just added to this list'
  return (
    <span
      {...{ [dataAttr]: kind }}
      data-tip={tip}
      className={`inline-flex h-4 w-4 shrink-0 items-center justify-center ${hang ? '-ml-[22px]' : ''}`}
    >
      {gone ? (
        <EyeOff className='h-3 w-3 text-slate-700 dark:text-slate-100' aria-label={tip} />
      ) : lock ? (
        <Lock
          className={`h-3 w-3 ${lock.is_mine ? 'text-slate-400' : 'text-amber-500'}`}
          aria-label={tip}
        />
      ) : (
        <span className='h-1.5 w-1.5 rounded-full bg-nvr-cyan' role='img' aria-label='New' />
      )}
    </span>
  )
}
