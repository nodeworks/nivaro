/**
 * Resolves the `items` option of the workflow-auto-sweep flow op into a list
 * of record ids. Pure (no db) so it can be unit-tested without the executor's
 * import graph.
 *
 * Accepted shapes:
 *   - an array (`[1, 2]`, `['371393']`) → stringified, deduped
 *   - a bare `{{path}}` template → the flow-data value at that path (array or
 *     comma list); unresolved/non-list → []
 *   - any other string → rendered, then split on commas
 *
 * A configured-but-empty result is returned as `[]` (NOT undefined): the op
 * treats that as "nothing to evaluate", never as "scan the whole collection".
 */
export function resolveSweepItems(
  raw: unknown,
  data: Record<string, unknown>,
  render: (template: string, data: Record<string, unknown>) => string,
  getByPath: (obj: unknown, path: string) => unknown
): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'string' && raw.trim() === '') return undefined
  let value: unknown = raw
  if (typeof raw === 'string') {
    const m = raw.trim().match(/^\{\{\s*([^}]+?)\s*\}\}$/)
    value = m ? getByPath(data, m[1]) : render(raw, data)
  }
  return normalizeIdList(value)
}

function normalizeIdList(value: unknown): string[] {
  const out = new Set<string>()
  const push = (v: unknown) => {
    if (v === null || v === undefined) return
    if (typeof v === 'object') {
      const id = (v as { id?: unknown }).id
      if (id !== undefined && id !== null) out.add(String(id))
      return
    }
    const s = String(v).trim()
    if (s) out.add(s)
  }
  if (Array.isArray(value)) for (const v of value) push(v)
  else if (typeof value === 'string') for (const part of value.split(',')) push(part)
  else push(value)
  return [...out]
}
