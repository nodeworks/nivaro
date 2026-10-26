/**
 * "My approval seats" (#122) names each owner-group filter the way the owner
 * matrix does: by its dimension label ("Region") instead of the field path the
 * filter stores ("regions.short_name"). A path no dimension of the pipeline
 * names any more keeps a readable fallback ("Project type" from
 * "project.project_type.name").
 */
export interface SeatFilter {
  field: string
  value: unknown
  [k: string]: unknown
}

export function fallbackFieldLabel(path: string): string {
  const parts = String(path).split('.').filter(Boolean)
  // A trailing display column (name, short_name, label, title…) says nothing a
  // reader needs — the segment before it is the thing being matched.
  const tail = parts[parts.length - 1] ?? ''
  const pick =
    parts.length > 1 && /^(name|short_name|label|title|display_name|code)$/i.test(tail)
      ? parts[parts.length - 2]
      : tail
  const words = pick.replace(/_id$/i, '').replace(/_/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : path
}

/** `dims` = field path → label for the seat's pipeline (any of its bindings). */
export function labelSeatFilters(
  filters: unknown,
  dims: Map<string, string>
): Array<SeatFilter & { label: string }> | null {
  if (!Array.isArray(filters)) return null
  return filters
    .filter((f): f is SeatFilter => !!f && typeof f === 'object' && typeof f.field === 'string')
    .map((f) => ({ ...f, label: dims.get(f.field) || fallbackFieldLabel(f.field) }))
}
