/** The part of a query-widget filter that decides its first selection. */
export interface SeedableFilter {
  param: string
  value_field?: string
  /** Pre-selected values; '$current_year' resolves to this calendar year. */
  default_values?: Array<string | number>
  /** Query-string key whose value (comma list) pre-selects this filter. */
  url_param?: string
}

/**
 * A query widget's first filter selection: from the page's query string when
 * the filter names a `url_param` that is present (a comma list → several
 * values), else from `default_values`. Filters left empty here are the ones
 * user-scope seeding may fill afterwards, so a URL value also beats that.
 */
export function initialFilterSelection(
  filters: SeedableFilter[] | undefined,
  search: string,
  now: Date = new Date()
): Record<string, Array<Record<string, unknown>>> {
  const out: Record<string, Array<Record<string, unknown>>> = {}
  const query = new URLSearchParams(search)
  for (const f of filters ?? []) {
    const vf = f.value_field ?? 'id'
    const fromUrl = f.url_param
      ? query
          .getAll(f.url_param)
          .flatMap((v) => v.split(','))
          .map((v) => v.trim())
          .filter(Boolean)
      : []
    if (fromUrl.length) {
      out[f.param] = fromUrl.map((v) => ({ [vf]: v }))
      continue
    }
    if (!f.default_values?.length) continue
    out[f.param] = f.default_values.map((v) => ({
      [vf]: v === '$current_year' ? now.getFullYear() : v
    }))
  }
  return out
}
