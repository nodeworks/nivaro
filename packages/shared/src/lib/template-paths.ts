/** The dotted tokens of a display template (`{{core_category.name}}`): fields that live on a
 *  linked record, which a plain `fields=*` read returns only as an id. */
export function templateRelationPaths(template: string | null | undefined): string[] {
  if (!template) return []
  return [
    ...new Set(
      [...template.matchAll(/\{\{([\w.]+)\}\}/g)].map((m) => m[1]).filter((t) => t.includes('.'))
    )
  ]
}

/**
 * A row for rendering a display template: the record's own row, with each link the template
 * reads through (`core_category` in "{{core_category.name}}") replaced by the linked record
 * that a `fields=<paths>` read returned. Links the read did not expand stay as they were.
 */
export function withLinkedFields(
  row: Record<string, unknown> | null | undefined,
  linked: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(row ?? {}) }
  for (const [k, v] of Object.entries(linked ?? {})) {
    if (k !== 'id' && v && typeof v === 'object' && !Array.isArray(v)) out[k] = v
  }
  return out
}
