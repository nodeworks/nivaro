// A group's `visible_when` rules ([{field, op, value}], all must hold): the
// one evaluator the record form (conditional steps, #139) and the layout
// editor's "what if" preview share, so the preview cannot drift from the form.

export interface VisibleWhenRule {
  field?: string
  op?: string
  value?: unknown
}

/** The stored rules (JSON text or an array); [] when none or unreadable. */
export function parseVisibleWhen(raw: unknown): VisibleWhenRule[] {
  if (raw == null || raw === '') return []
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(v)
      ? (v.filter((r) => r && typeof r === 'object') as VisibleWhenRule[])
      : []
  } catch {
    return []
  }
}

/** Does a record with `values` satisfy the rules? No (or unreadable) rules: yes. */
export function matchesVisibleWhen(raw: unknown, values: Record<string, unknown>): boolean {
  const rules = parseVisibleWhen(raw)
  if (rules.length === 0) return true
  return rules.every((r) => {
    if (!r?.field) return true
    const v = values[r.field]
    const want = r.value
    switch (r.op ?? 'eq') {
      case 'eq':
        return String(v ?? '') === String(want ?? '')
      case 'neq':
        return String(v ?? '') !== String(want ?? '')
      case 'null':
        return v == null || v === ''
      case 'nnull':
        return v != null && v !== ''
      case 'in':
        return String(want ?? '')
          .split(',')
          .map((x) => x.trim())
          .includes(String(v ?? ''))
      default:
        return true
    }
  })
}
