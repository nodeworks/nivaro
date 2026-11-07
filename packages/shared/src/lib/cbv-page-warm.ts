/**
 * Warm the per-page lookups a collection list renders its rows with, for a page that is not on
 * screen yet (the idle-prefetched next page).
 *
 * Without this, Next/Prev painted twice: the prefetched rows arrived at once with bare ids, then
 * every relation label and dotted column sat on a grey placeholder until its own lookup landed
 * (~1 s on EFP workflows). Same keys and fetchers as the cells use, so the cells read the warm
 * cache instead of asking again.
 */

interface RelationLike {
  many_collection?: string | null
  many_field?: string | null
  one_collection?: string | null
}

interface PrefetchClient {
  prefetchQuery: (opts: {
    queryKey: readonly unknown[]
    queryFn: () => Promise<unknown>
    staleTime?: number
  }) => Promise<unknown>
}

const isSystemCollection = (c: string) => c.startsWith('directus_') || c.startsWith('nivaro_')

export function warmPageLookups(opts: {
  qc: PrefetchClient
  collection: string
  rows: Array<Record<string, unknown>>
  /** The columns on screen. */
  columns: string[]
  relations: RelationLike[]
  /** Dotted / alias paths the list resolves in bulk (the `cbv-resolved` query). */
  resolveList: string[]
  isResolvedCol: (key: string) => boolean
  fetchResolved: (idsKey: string) => Promise<unknown>
  fetchRelation: (collection: string, id: string) => Promise<unknown>
  userCardQuery: (id: string) => { queryKey: readonly unknown[]; queryFn: () => Promise<unknown> }
}): void {
  const { qc, collection, rows } = opts
  if (rows.length === 0) return
  if (opts.resolveList.length > 0) {
    const idsKey = rows.map((r) => String(r.id)).join(',')
    void qc.prefetchQuery({
      queryKey: ['cbv-resolved', collection, idsKey, opts.resolveList.join(',')],
      queryFn: () => opts.fetchResolved(idsKey),
      staleTime: 30_000
    })
  }
  for (const key of opts.columns) {
    if (opts.isResolvedCol(key)) continue
    const target = opts.relations.find(
      (r) => r.many_collection === collection && r.many_field === key && r.one_collection
    )?.one_collection
    if (!target) continue
    const seen = new Set<string>()
    for (const row of rows) {
      const v = row[key]
      if (v == null || v === '') continue
      const id = String(v)
      if (seen.has(id)) continue
      seen.add(id)
      if (target === 'nivaro_users') {
        void qc.prefetchQuery({ ...opts.userCardQuery(id), staleTime: 120_000 })
      } else if (!isSystemCollection(target)) {
        void qc.prefetchQuery({
          queryKey: ['cbv-relation-item', target, id],
          queryFn: () => opts.fetchRelation(target, id),
          staleTime: 30 * 60_000
        })
      }
    }
  }
}
