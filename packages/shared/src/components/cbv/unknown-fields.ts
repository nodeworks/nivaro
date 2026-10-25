import type { ActiveFilter } from '../CollectionBrowserView'

function refusalBody(err: unknown): { code?: unknown; fields?: unknown } | undefined {
  const e = err as { status?: number; response?: unknown } | null
  const r = e?.response as ({ data?: unknown } & Record<string, unknown>) | undefined
  return (r && typeof r === 'object' && r.data && typeof r.data === 'object' ? r.data : r) as
    | { code?: unknown; fields?: unknown }
    | undefined
}

/**
 * A list read refused because its filter or sort names a field the collection
 * no longer has (400 UNKNOWN_FIELD, body `fields: [...]`), or a path it cannot
 * follow (403 FIELD_NOT_READABLE — a mistyped or stale link, `zone.nope`). The
 * list offers each name as a removable chip instead of a dead "Failed to
 * load" — a saved view or a link from before a field was dropped otherwise
 * never loads again.
 */
export function unknownFieldsOf(err: unknown): string[] {
  const body = refusalBody(err)
  if (!isFilterRefusal(err) || !Array.isArray(body?.fields)) return []
  return body.fields.filter((f): f is string => typeof f === 'string' && f.length > 0)
}

/** The refusal is about the filter or sort, not the person's access — never
 *  answered with "Request access". */
export function isFilterRefusal(err: unknown): boolean {
  const code = refusalBody(err)?.code
  return code === 'UNKNOWN_FIELD' || code === 'FIELD_NOT_READABLE'
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
