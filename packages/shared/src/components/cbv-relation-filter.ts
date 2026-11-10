/**
 * Options for a relation column's filter dropdown in CollectionBrowserView
 * (Rob 2026-11-10, Locations → Regions offered only the four regions on the
 * current page). The dropdown offers the WHOLE related collection: the values
 * on the page come first (what the person is looking at), then the rest of
 * the related records, so a small reference table (regions, zones) is listed
 * in full and a big one (purchase orders) lists its newest records with the
 * search box reaching everything server-side.
 */

/** How many related records the unsearched list offers besides the page's own. */
export const REST_LIMIT = 300
/** Page values asked for by id (one request). */
export const PAGE_LIMIT = 500
/** Rows a typed search returns. */
export const SEARCH_LIMIT = 60

export type FilterOption = { value: string | number; label: string }

/** The /items/:target requests the dropdown makes: [page values?, rest] — or one search. */
export function relationFilterRequests(opts: {
  search: string
  preferIds?: Array<string | number>
  labelField: string
  fields?: string | null
}): Array<Record<string, string | number>> {
  const f: Record<string, string> = opts.fields ? { fields: opts.fields } : {}
  if (opts.search)
    return [{ limit: SEARCH_LIMIT, sort: opts.labelField, search: opts.search, picker: '1', ...f }]
  const out: Array<Record<string, string | number>> = []
  const page = (opts.preferIds ?? []).slice(0, PAGE_LIMIT)
  // Values already on the page are real data and stay offered even when the
  // record is hidden from pickers; the rest of the list hides those.
  if (page.length > 0)
    out.push({
      limit: PAGE_LIMIT,
      sort: opts.labelField,
      filter: JSON.stringify({ id: { _in: page } }),
      ...f
    })
  // Newest first: the alphabetical head of a big reference table is where the
  // junk lives (thousands of purchase orders numbered "1").
  out.push({ limit: REST_LIMIT, sort: '-id', picker: '1', ...f })
  return out
}

const byLabel = (a: FilterOption, b: FilterOption) =>
  a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' })

/** One list: each group sorted by label, earlier groups first, every value once. */
export function mergeFilterOptions(groups: FilterOption[][]): FilterOption[] {
  const seen = new Set<string>()
  const out: FilterOption[] = []
  for (const g of groups) {
    for (const o of [...g].sort(byLabel)) {
      const k = String(o.value)
      if (o.value == null || o.label === '' || seen.has(k)) continue
      seen.add(k)
      out.push(o)
    }
  }
  return out
}
