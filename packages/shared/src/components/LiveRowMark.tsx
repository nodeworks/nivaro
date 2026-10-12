import { Lock } from 'lucide-react'
import { lockLabel, type RowLock } from '../lib/live-list'

/**
 * The 16px leading mark a live list row can carry, in the slot the unseen dot
 * already reserves: a lock (someone is editing the record right now) wins over
 * the "new" dot (the row just slid in). Returns null when neither applies so
 * the caller falls back to its usual mark.
 */
export function LiveRowMark({
  lock,
  isNew,
  dataAttr = 'data-live-mark',
  hang = false
}: {
  lock?: RowLock | null
  isNew?: boolean
  dataAttr?: string
  /** Hang in the cell's left padding (like UnseenDot's `hang`). */
  hang?: boolean
}) {
  if (!lock && !isNew) return null
  const props = { [dataAttr]: lock ? 'lock' : 'new' }
  return (
    <span
      {...props}
      data-tip={lock ? lockLabel(lock) : 'New — just added to this list'}
      className={`inline-flex h-4 w-4 shrink-0 items-center justify-center ${hang ? '-ml-[22px]' : ''}`}
    >
      {lock ? (
        <Lock
          className={`h-3 w-3 ${lock.is_mine ? 'text-slate-400' : 'text-amber-500'}`}
          aria-label={lockLabel(lock)}
        />
      ) : (
        <span className='h-1.5 w-1.5 rounded-full bg-nvr-cyan' aria-label='New' />
      )}
    </span>
  )
}
