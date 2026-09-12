/**
 * Guard + template helpers shared by the no-code action surfaces (custom
 * record actions, bulk actions). A guard is `[{field, op, value}]` AND'd over
 * the record's current values; a template is Liquid-lite `{{field}}`.
 */
export type GuardRule = { field: string; op: string; value?: unknown }

export function parseJsonLoose<T>(raw: unknown): T | null {
  if (raw == null || raw === '') return null
  if (typeof raw === 'object') return raw as T
  try {
    return JSON.parse(String(raw)) as T
  } catch {
    return null
  }
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === ''
}

/** Booleans compare loosely: 'true'/1/true agree, 'false'/0/false/null agree. */
function norm(v: unknown): string {
  if (v === true || v === 1 || v === '1' || v === 'true') return 'true'
  if (v === false || v === 0 || v === '0' || v === 'false') return 'false'
  return String(v ?? '')
}

export function guardPasses(rules: GuardRule[] | null, record: Record<string, unknown>): boolean {
  for (const r of rules ?? []) {
    if (!r || typeof r.field !== 'string') continue
    const v = record[r.field]
    const want = r.value
    const ok = (() => {
      switch (r.op) {
        case 'eq':
          return norm(v) === norm(want)
        case 'neq':
          // A NULL/empty value is "not equal" to any concrete value — so
          // `is_on_hold neq true` passes for records that were never held.
          return norm(v) !== norm(want)
        case 'null':
          return isEmpty(v)
        case 'nnull':
          return !isEmpty(v)
        case 'in':
          return String(want ?? '')
            .split(',')
            .map((x) => norm(x.trim()))
            .includes(norm(v))
        case 'nin':
          return !String(want ?? '')
            .split(',')
            .map((x) => norm(x.trim()))
            .includes(norm(v))
        default:
          return false
      }
    })()
    if (!ok) return false
  }
  return true
}

/** {{field}} → record value; unknown tokens render empty. */
export function renderTemplate(tpl: string, record: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, f) => String(record[f] ?? ''))
}
