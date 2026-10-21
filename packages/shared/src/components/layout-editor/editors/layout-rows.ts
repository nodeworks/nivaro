/**
 * Row models for the Form settings list editors: record conditions and starting
 * values. The editors keep half-filled rows locally and save only the complete
 * ones, so a rule never goes live while the admin is still choosing its value.
 */

/** The ops the server's layout resolver understands (matchesRecordConditions). */
export const RECORD_RULE_OPS = ['eq', 'neq', 'nnull'] as const
export type RecordRuleOp = (typeof RECORD_RULE_OPS)[number]

export const RECORD_RULE_OP_LABELS: Record<RecordRuleOp, string> = {
  eq: 'is',
  neq: 'is not',
  nnull: 'has a value'
}

export interface RecordRuleRow {
  field: string
  op: RecordRuleOp
  value: string
}

export interface RecordRule {
  field: string
  op: RecordRuleOp
  value?: string
}

function parseJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Stored record_conditions (array or JSON text) → editor rows. */
export function rowsFromRules(raw: unknown): RecordRuleRow[] {
  const parsed = parseJson(raw)
  if (!Array.isArray(parsed)) return []
  return parsed
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({
      field: typeof r.field === 'string' ? r.field : '',
      op: r.op === 'neq' || r.op === 'nnull' ? r.op : 'eq',
      value: r.value == null ? '' : String(r.value)
    }))
}

/** The complete rows as stored rules; null when there are none. */
export function rulesFromRows(rows: RecordRuleRow[]): RecordRule[] | null {
  const rules: RecordRule[] = []
  for (const r of rows) {
    if (!r.field) continue
    if (r.op === 'nnull') rules.push({ field: r.field, op: 'nnull' })
    else if (r.value !== '') rules.push({ field: r.field, op: r.op, value: r.value })
  }
  return rules.length ? rules : null
}

export interface DefaultValueRow {
  field: string
  value: unknown
}

const isEmptyValue = (v: unknown) =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)

/** Stored default_values (object or JSON text) → editor rows, in stored order. */
export function rowsFromDefaults(raw: unknown): DefaultValueRow[] {
  const parsed = parseJson(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  return Object.entries(parsed as Record<string, unknown>).map(([field, value]) => ({
    field,
    value
  }))
}

/** The rows with a field and a value as the stored map; null when there are none. */
export function defaultsFromRows(rows: DefaultValueRow[]): Record<string, unknown> | null {
  const out: Record<string, unknown> = {}
  for (const r of rows) if (r.field && !isEmptyValue(r.value)) out[r.field] = r.value
  return Object.keys(out).length ? out : null
}

/** Same stored meaning (order-insensitive for maps) — used to tell our echo from someone else's edit. */
export function sameJson(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm)
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, norm((v as Record<string, unknown>)[k])])
      )
    return v ?? null
  }
  return JSON.stringify(norm(parseJson(a))) === JSON.stringify(norm(parseJson(b)))
}
