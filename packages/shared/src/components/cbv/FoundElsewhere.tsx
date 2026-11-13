import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useItemNavigation, useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { titleCase } from '../../lib/utils'
import { useOverflowTip } from '../TipLayer'

/**
 * A list search that found nothing is often a real id typed into the wrong
 * list: an inventory request's id in the Workflows list, a PO number, a record
 * this list's own filters hide. The empty state then says where the thing is.
 *
 * Asked once, only when the list is empty and the term reads as an identifier
 * (never while typing ordinary words), through global search — which answers
 * as the person, so a record they may not read is never named.
 */

/** One token, 4–64 characters, with a digit in it: an id, not a word or a name. */
export function looksLikeIdentifier(term: string): boolean {
  const t = term.trim()
  return /^[A-Za-z0-9][A-Za-z0-9._/#-]{3,63}$/.test(t) && /\d/.test(t)
}

interface ExactHit {
  collection: string
  display_name: string | null
  id: unknown
  label: string
}

export function FoundElsewhere({
  term,
  show,
  ask = show,
  collection,
  fallback = null
}: {
  term: string
  /** The empty state is on screen for this search: a hit already known is shown. */
  show: boolean
  /** The lookup may go out now. False while the list itself is still reading:
   *  nothing is asked then, and a hit already known stays where it is. */
  ask?: boolean
  /** The list's own collection: a hit there is a record its filters hide. */
  collection?: string | null
  /** What the line says until a hit is known. The hit takes its place, so
   *  nothing below it moves when the lookup answers. */
  fallback?: ReactNode
}) {
  const client = useNivaroClient()
  const { open, urlFor } = useItemNavigation()
  const q = term.trim()
  const { data: hit } = useQuery({
    queryKey: ['cbv-found-elsewhere', q],
    enabled: show && ask && looksLikeIdentifier(q),
    staleTime: 60_000,
    retry: false,
    queryFn: () =>
      client
        .request<{ data: { exact?: ExactHit | null } }>(get('/global-search', { q }))
        .then((r) => r.data?.exact ?? null)
        // The hint is a courtesy: a failed lookup leaves the empty state as it was.
        .catch(() => null)
  })
  const found = show && hit && hit.id != null ? hit : null
  const label = found ? found.label || String(found.id) : null
  // Cut on one line; the whole label is the tip when it is.
  const linkRef = useOverflowTip<HTMLAnchorElement>(label)
  if (!found) return <>{fallback}</>
  const target = { collection: found.collection, itemId: String(found.id) }
  return (
    <p
      // `w-full`: the cut link cannot shrink the line by itself, so in a container
      // narrower than 52ch the line would otherwise spill out of both sides.
      className='w-full max-w-[52ch] text-[12px] text-slate-600 dark:text-slate-300'
      data-found-elsewhere={found.collection}
    >
      {found.collection === collection
        ? "Hidden by this list's filters"
        : `Found in ${found.display_name?.trim() || titleCase(found.collection)}`}
      :{' '}
      <a
        ref={linkRef}
        href={urlFor(target)}
        onClick={(e) => {
          // A plain click stays in the app; a modified one keeps the browser's own behaviour.
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
          e.preventDefault()
          open(target)
        }}
        className='inline-block max-w-full truncate align-bottom font-medium text-[#0284a8] underline-offset-2 hover:underline dark:text-nvr-cyan'
      >
        {label}
      </a>
    </p>
  )
}
