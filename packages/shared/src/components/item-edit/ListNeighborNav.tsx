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

  // The count is the WHOLE list's when the list said how many it holds ("3 of 49", "3 of about
  // 49"); otherwise it counts only the rows the list showed and says so ("3 of 25 shown") —
  // never a page size passed off as the list's total (rt-nav review).
  const of =
    n.listTotal != null
      ? `${n.approx ? 'about ' : ''}${n.listTotal.toLocaleString()}`
      : n.total.toLocaleString()
  const countText = `${n.position.toLocaleString()} of ${of}${n.listTotal == null ? ' shown' : ''}`
  const countTip =
    n.listTotal != null
      ? `Record ${n.position.toLocaleString()} of ${of} in ${listName}`
      : `Record ${n.index} of the ${n.total} ${listName} showed`
  // At the edge of what the list showed, the button stays focusable and says why it stops
  // (a disabled button shows no tooltip).
  // Without the list's total, the end of the rows shown is not known to be the list's end.
  const prevTip = n.prev
    ? `Previous in ${listName}`
    : n.moreBefore
      ? 'First on this page — go back to the list for the page before'
      : n.listTotal == null && n.position > 1
        ? `First of the ${n.total} shown`
        : `First in ${listName}`
  const nextTip = n.next
    ? `Next in ${listName}`
    : n.moreAfter
      ? 'Last on this page — go back to the list for the next page'
      : n.listTotal == null
        ? `Last of the ${n.total} shown — go back to the list for more`
        : `Last in ${listName}`

  const btn =
    'flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 aria-disabled:cursor-default aria-disabled:text-slate-300 aria-disabled:hover:bg-transparent aria-disabled:hover:text-slate-300 dark:text-slate-400 dark:hover:bg-white/[0.06] dark:hover:text-slate-100 dark:aria-disabled:text-slate-600 dark:aria-disabled:hover:text-slate-600'
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
        aria-disabled={!n.prev || undefined}
        onClick={(e) => go(n.prev, e)}
        onAuxClick={(e) => go(n.prev, e)}
        aria-label={prevTip}
        data-tip={prevTip}
        data-list-prev
      >
        <ChevronUp aria-hidden className='h-4 w-4' />
      </button>
      <span
        className='min-w-[3.25rem] select-none whitespace-nowrap px-0.5 text-center text-[11.5px] tabular-nums text-slate-500 dark:text-slate-400'
        data-tip={countTip}
        data-list-count
      >
        {countText}
      </span>
      <button
        type='button'
        className={btn}
        aria-disabled={!n.next || undefined}
        onClick={(e) => go(n.next, e)}
        onAuxClick={(e) => go(n.next, e)}
        aria-label={nextTip}
        data-tip={nextTip}
        data-list-next
      >
        <ChevronDown aria-hidden className='h-4 w-4' />
      </button>
    </nav>
  )
}
