import { ChevronDown, ChevronUp } from 'lucide-react'
import { type MouseEvent, useMemo } from 'react'
import { useItemNavigation, useNavigation } from '../../context'
import { type ListRef, listNeighbors, listReturnFor, stepListReturn } from '../../lib/list-return'

/**
 * Realtime #16 — "Previous / Next in list" on a record opened from a list or a worklist.
 *
 * The list kept its row order when it opened this record (lib/list-return.ts); this walks it
 * without going back to the list. A step REPLACES the record's history entry, so the browser's
 * Back (and the record's back arrow) still lands on the list — which then marks the row the
 * person ended on. A modified click (Cmd / Ctrl / Shift / middle) opens that record in a new tab.
 * Renders nothing when the record was not opened from a list in this tab.
 */
export function ListNeighborNav({
  collection,
  itemId,
  className
}: {
  collection: string
  itemId: string | number | null | undefined
  className?: string
}) {
  const nav = useNavigation()
  const { urlFor } = useItemNavigation()
  const here = useMemo<ListRef | null>(
    () =>
      collection && itemId != null && itemId !== 'new' ? { collection, id: String(itemId) } : null,
    [collection, itemId]
  )
  const stash = useMemo(() => (here ? listReturnFor(here) : null), [here])
  const n = here ? listNeighbors(stash, here) : null
  if (!stash || !n || n.total < 2) return null
  const listName = stash.label?.trim() || 'the list'

  const go = (to: ListRef | null, e: MouseEvent) => {
    if (!to) return
    const url = urlFor({ collection: to.collection, itemId: to.id })
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) {
      e.preventDefault()
      window.open(url, '_blank', 'noopener')
      return
    }
    stepListReturn(to)
    nav.navigate(url, { replace: true })
  }

  const btn =
    'flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 disabled:pointer-events-none disabled:opacity-35 dark:text-slate-400 dark:hover:bg-white/[0.06] dark:hover:text-slate-100'
  return (
    <nav
      aria-label={`Records in ${listName}`}
      data-list-neighbors={stash.list}
      className={
        className ??
        'flex shrink-0 items-center gap-0.5 rounded-lg border border-slate-200 bg-white px-0.5 dark:border-border dark:bg-card'
      }
    >
      <button
        type='button'
        className={btn}
        disabled={!n.prev}
        onClick={(e) => go(n.prev, e)}
        onAuxClick={(e) => go(n.prev, e)}
        aria-label={`Previous in ${listName}`}
        data-tip={`Previous in ${listName}`}
        data-list-prev
      >
        <ChevronUp aria-hidden className='h-4 w-4' />
      </button>
      <span
        className='min-w-[3.25rem] select-none px-0.5 text-center text-[11.5px] tabular-nums text-slate-500 dark:text-slate-400'
        data-tip={`Record ${n.index} of ${n.total} in ${listName}`}
      >
        {n.index} of {n.total}
      </span>
      <button
        type='button'
        className={btn}
        disabled={!n.next}
        onClick={(e) => go(n.next, e)}
        onAuxClick={(e) => go(n.next, e)}
        aria-label={`Next in ${listName}`}
        data-tip={`Next in ${listName}`}
        data-list-next
      >
        <ChevronDown aria-hidden className='h-4 w-4' />
      </button>
    </nav>
  )
}
