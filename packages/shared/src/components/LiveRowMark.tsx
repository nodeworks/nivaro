import { ArrowDownUp, EyeOff, Lock } from 'lucide-react'
import { movingRowTitle } from '../lib/live-groups'
import { lockLabel, type RowLock } from '../lib/live-list'
import { GONE_ROW_TITLE } from '../lib/live-list-flow'

/**
 * The 16px leading mark a live list row can carry, in the slot the unseen dot
 * already reserves: "no longer in this view" (a row kept in place under the
 * pointer, lib/live-list-flow.ts) wins, then "now in another group" (a grouped list holding
 * still, lib/live-groups.ts), then a lock (someone is editing the
 * record right now), then the "new" dot (the row just slid in). Returns null
 * when none applies so the caller falls back to its usual mark.
 */
export function LiveRowMark({
  lock,
  isNew,
  gone,
  movingTo,
  dataAttr = 'data-live-mark',
  hang = false
}: {
  lock?: RowLock | null
  isNew?: boolean
  gone?: boolean
  /** The group label a held row moves to once the pointer leaves. */
  movingTo?: string | null
  dataAttr?: string
  /** Hang in the cell's left padding (like UnseenDot's `hang`). */
  hang?: boolean
}) {
  const moving = !gone && movingTo != null
  if (!lock && !isNew && !gone && !moving) return null
  const kind = gone ? 'gone' : moving ? 'moving' : lock ? 'lock' : 'new'
  const tip = gone
    ? GONE_ROW_TITLE
    : moving
      ? movingRowTitle(movingTo as string)
      : lock
        ? lockLabel(lock)
        : 'New — just added to this list'
  return (
    <span
      {...{ [dataAttr]: kind }}
      data-tip={tip}
      className={`inline-flex h-4 w-4 shrink-0 items-center justify-center ${hang ? '-ml-[22px]' : ''}`}
    >
      {gone ? (
        <EyeOff className='h-3 w-3 text-slate-700 dark:text-slate-100' aria-label={tip} />
      ) : moving ? (
        // A filled disc, not a bare 10 px glyph: the row is held on purpose while the group
        // counts above it already moved (rt9 review: it read as a count bug).
        <span
          role='img'
          aria-label={tip}
          className='inline-flex h-4 w-4 items-center justify-center rounded-full bg-[#0089ad] text-white dark:bg-nvr-cyan dark:text-[#04222c]'
        >
          <ArrowDownUp className='h-2.5 w-2.5' aria-hidden />
        </span>
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

/**
 * The words for a held grouped row: "Moving to Finance". Hosts put it beside the row's title
 * while the list holds still (lib/live-groups.ts), so a group count that disagrees with the
 * rows drawn under it reads as intended. Light + dark.
 */
export function MovingRowChip({ to, className }: { to: string; className?: string }) {
  return (
    <span
      data-moving-chip
      data-tip={movingRowTitle(to)}
      className={`nvr-fade-in inline-flex h-[18px] max-w-[11rem] shrink-0 items-center gap-1 rounded-full bg-[#e6f8fd] px-1.5 text-[10.5px] font-medium text-[#006d8a] ring-1 ring-inset ring-[#0089ad]/25 dark:bg-[#0c2a33] dark:text-nvr-cyan dark:ring-nvr-cyan/30 ${className ?? ''}`}
    >
      <ArrowDownUp className='h-2.5 w-2.5 shrink-0' aria-hidden />
      <span className='truncate'>Moving to {to}</span>
    </span>
  )
}
