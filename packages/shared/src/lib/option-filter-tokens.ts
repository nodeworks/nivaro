/**
 * `$parent.<field>` tokens inside a picker's option_filter, resolved off a
 * record draft. A top-level `_and` entry whose tokens do not resolve is
 * PRUNED (the clause applies only while its driving value is set); any other
 * shape that cannot resolve drops the whole filter. The form's pickers, the
 * quick picker and the document-autofill asks all read through this.
 */
function resolveTokenNode(
  node: unknown,
  draft: Record<string, unknown> | undefined,
  itemId: string
): { v: unknown; ok: boolean } {
  if (typeof node === 'string' && node.startsWith('$parent.')) {
    const key = node.slice('$parent.'.length)
    const val = key === 'id' ? (itemId && itemId !== 'new' ? itemId : undefined) : draft?.[key]
    return { v: val, ok: val !== undefined && val !== null && val !== '' }
  }
  if (Array.isArray(node)) {
    const out: unknown[] = []
    for (const item of node) {
      const r = resolveTokenNode(item, draft, itemId)
      if (!r.ok) return { v: out, ok: false }
      out.push(r.v)
    }
    return { v: out, ok: true }
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const r = resolveTokenNode(v, draft, itemId)
      if (!r.ok) return { v: out, ok: false }
      out[k] = r.v
    }
    return { v: out, ok: true }
  }
  return { v: node, ok: true }
}

export function resolveOptionFilterTokens(
  filter: Record<string, unknown> | undefined,
  draft: Record<string, unknown> | undefined,
  itemId: string
): Record<string, unknown> | undefined {
  if (!filter) return undefined
  // Top-level _and: prune entries whose tokens are unresolved
  if (Array.isArray(filter._and)) {
    const kept: unknown[] = []
    for (const entry of filter._and) {
      const r = resolveTokenNode(entry, draft, itemId)
      if (r.ok) kept.push(r.v)
    }
    return kept.length > 0 ? { _and: kept } : undefined
  }
  const r = resolveTokenNode(filter, draft, itemId)
  return r.ok ? (r.v as Record<string, unknown>) : undefined
}
