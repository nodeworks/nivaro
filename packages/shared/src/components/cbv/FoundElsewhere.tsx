import { useQuery } from '@tanstack/react-query'
import { useItemNavigation, useNivaroClient } from '../../context'
import { get } from '../../lib/commands'

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

export function FoundElsewhere({ term, enabled }: { term: string; enabled: boolean }) {
  const client = useNivaroClient()
  const { open, urlFor } = useItemNavigation()
  const q = term.trim()
  const { data: hit } = useQuery({
    queryKey: ['cbv-found-elsewhere', q],
    enabled: enabled && looksLikeIdentifier(q),
    staleTime: 60_000,
    retry: false,
    queryFn: () =>
      client
        .request<{ data: { exact?: ExactHit | null } }>(get('/global-search', { q }))
        .then((r) => r.data?.exact ?? null)
        // The hint is a courtesy: a failed lookup leaves the empty state as it was.
        .catch(() => null)
  })
  if (!enabled || !hit || hit.id == null) return null
  const target = { collection: hit.collection, itemId: String(hit.id) }
  const name = hit.display_name?.trim() || hit.collection.replace(/_/g, ' ')
  return (
    <p
      className='max-w-[52ch] text-[12px] text-slate-600 dark:text-slate-300'
      data-found-elsewhere={hit.collection}
    >
      Found in {name}:{' '}
      <a
        href={urlFor(target)}
        onClick={(e) => {
          // A plain click stays in the app; a modified one keeps the browser's own behaviour.
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
          e.preventDefault()
          open(target)
        }}
        className='font-medium text-[#0284a8] underline-offset-2 hover:underline dark:text-nvr-cyan'
      >
        {hit.label || String(hit.id)}
      </a>
    </p>
  )
}
