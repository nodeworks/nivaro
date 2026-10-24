/** The part of a query-widget filter that decides its first selection. */
export interface SeedableFilter {
  param: string
  value_field?: string
  /** Pre-selected values; '$current_year' resolves to this calendar year. */
  default_values?: Array<string | number>
  /** Query-string key whose value (comma list) pre-selects this filter. */
  url_param?: string
  /** One value at a time (picking another replaces it). */
  single?: boolean
}

/** Query-string values of one key, split on commas, blanks dropped. */
function urlValues(query: URLSearchParams, key: string): string[] {
  return query
    .getAll(key)
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean)
}

/**
 * Filters the page address sets to "All" on purpose — its key present with no
 * value (`?fy=`, written when someone clears the filter). Neither
 * default_values nor user-scope seeding may refill them on reload.
 */
export function explicitAllUrlParams(
  filters: SeedableFilter[] | undefined,
  search: string
): Set<string> {
  const query = new URLSearchParams(search)
  const out = new Set<string>()
  for (const f of filters ?? [])
    if (f.url_param && query.has(f.url_param) && urlValues(query, f.url_param).length === 0)
      out.add(f.param)
  return out
}

/**
 * The page address after a filter change: every filter naming a `url_param`
 * writes its selection (comma list; empty = "All" on purpose), so a reload or
 * a shared link lands on the same figures. Other keys are kept as they are.
 */
export function filterSelectionToSearch(
  filters: SeedableFilter[] | undefined,
  selection: Record<string, Array<Record<string, unknown>>>,
  search: string
): string {
  const query = new URLSearchParams(search)
  for (const f of filters ?? []) {
    if (!f.url_param) continue
    const vf = f.value_field ?? 'id'
    const vals = (selection[f.param] ?? []).map((r) => String(r[vf] ?? '')).filter(Boolean)
    query.set(f.url_param, vals.join(','))
  }
  const out = query.toString()
  return out ? `?${out}` : ''
}

/**
 * A query widget's first filter selection: from the page's query string when
 * the filter names a `url_param` that is present (a comma list → several
 * values), else from `default_values` — unless the address says "All" on
 * purpose (`?fy=`). Filters left empty here are the ones user-scope seeding
 * may fill afterwards, so a URL value also beats that.
 */
export function initialFilterSelection(
  filters: SeedableFilter[] | undefined,
  search: string,
  now: Date = new Date()
): Record<string, Array<Record<string, unknown>>> {
  const out: Record<string, Array<Record<string, unknown>>> = {}
  const query = new URLSearchParams(search)
  const explicitAll = explicitAllUrlParams(filters, search)
  for (const f of filters ?? []) {
    const vf = f.value_field ?? 'id'
    const fromUrl = f.url_param ? urlValues(query, f.url_param) : []
    if (fromUrl.length) {
      out[f.param] = (f.single ? fromUrl.slice(0, 1) : fromUrl).map((v) => ({ [vf]: v }))
      continue
    }
    if (explicitAll.has(f.param) || !f.default_values?.length) continue
    const defaults = f.single ? f.default_values.slice(0, 1) : f.default_values
    out[f.param] = defaults.map((v) => ({
      [vf]: v === '$current_year' ? now.getFullYear() : v
    }))
  }
  return out
}
