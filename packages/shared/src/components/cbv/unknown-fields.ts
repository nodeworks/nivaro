import type { ActiveFilter } from '../CollectionBrowserView'

/**
 * A list read refused because its filter or sort names a field the collection
 * no longer has (400 UNKNOWN_FIELD, body `fields: [...]`). The list offers each
 * name as a removable chip instead of a dead "Failed to load" — a saved view
 * or a link from before a field was dropped otherwise never loads again.
 */
export function unknownFieldsOf(err: unknown): string[] {
  const e = err as { status?: number; response?: unknown } | null
  const r = e?.response as ({ data?: unknown } & Record<string, unknown>) | undefined
  const body = (r && typeof r === 'object' && r.data && typeof r.data === 'object' ? r.data : r) as
    | { code?: unknown; fields?: unknown }
    | undefined
  if (body?.code !== 'UNKNOWN_FIELD' || !Array.isArray(body.fields)) return []
  return body.fields.filter((f): f is string => typeof f === 'string' && f.length > 0)
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
/** A path or dotted key that reads `field` at any hop. */
const reads = (path: string[], field: string) =>
  path.some((p) => p.split('.').some((seg) => same(seg, field)))

/** Filters, sort and column filters with every use of `field` taken out. */
export function dropUnknownField<C>(
  field: string,
  state: { filters: ActiveFilter[]; sort: string; colFilters: Record<string, C> }
): { filters: ActiveFilter[]; sort: string; colFilters: Record<string, C> } {
  return {
    filters: state.filters.filter((f) => !reads(f.path, field)),
    sort: state.sort
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && !reads([s.replace(/^-/, '')], field))
      .join(','),
    colFilters: Object.fromEntries(
      Object.entries(state.colFilters).filter(([k]) => !reads([k], field))
    )
  }
}
