/**
 * Last page in CollectionBrowserView (Rob 2026-11-10). The list asks for an
 * approximate total (#2443) and may get none at all when the count times out,
 * so "Last" computed from it can land short or past the end. When the total on
 * screen is not exact, Last asks for an exact count first — the same search and
 * column conditions, one id — and pages from that.
 */

/** The page number holding the last record (1 when there are none). */
export function lastPageFor(total: number, pageSize: number): number {
  if (!Number.isFinite(total) || total <= 0 || pageSize <= 0) return 1
  return Math.ceil(total / pageSize)
}

/** The exact-count read behind Last: no `count` param = exact on the items route. */
export function exactCountParams(opts: {
  search?: string
  conditions?: string | null
}): Record<string, string | number> {
  return {
    limit: 1,
    fields: 'id',
    ...(opts.search ? { search: opts.search } : {}),
    ...(opts.conditions ? { conditions: opts.conditions } : {})
  }
}

/** The page Last should open from an exact-count answer; null = no count came back. */
export function lastPageFromCount(
  res: { total?: number | null; total_timed_out?: boolean } | null | undefined,
  pageSize: number
): number | null {
  if (!res || res.total_timed_out === true || typeof res.total !== 'number') return null
  return lastPageFor(res.total, pageSize)
}
