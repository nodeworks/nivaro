/**
 * Record conditions — `[{field, op, value}]`, ALL must hold. The same ops and
 * semantics as the at-risk / row-highlight rules (api/src/routes/at-risk.ts
 * evalCondition), so one sentence ("on hold is true", "requisition over
 * 50,000") reads the same wherever a rule judges a record. A value may name
 * another field: "{{budget}}", "{{budget}} * 0.9", "{{baseline}} + 10".
 */

export const RECORD_CONDITION_OPS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'null',
  'nnull'
] as const
export type RecordConditionOp = (typeof RECORD_CONDITION_OPS)[number]

export interface RecordCondition {
  field: string
  op: RecordConditionOp
  value?: unknown
}

export const RECORD_CONDITION_OP_LABELS: Record<RecordConditionOp, string> = {
  eq: 'is',
  neq: 'is not',
  gt: 'is over',
  gte: 'is at least',
  lt: 'is under',
  lte: 'is at most',
  contains: 'contains',
  null: 'is empty',
  nnull: 'is filled'
}

const FIELD_REF_RE = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}(?:\s*([*+])\s*(-?\d+(?:\.\d+)?))?$/
const NO_VALUE = Symbol('no-value')

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isNaN(n) ? null : n
  }
  return null
}

function toComparable(v: unknown): number | null {
  const n = toNumber(v)
  if (n !== null) return n
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
  }
  return null
}

/** A related record read as an object still compares by its id. */
function scalar(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
    return (v as { id?: unknown }).id ?? v
  }
  return v
}

function resolveValue(value: unknown, row: Record<string, unknown>): unknown {
  if (typeof value !== 'string') return value
  const m = FIELD_REF_RE.exec(value.trim())
  if (!m) return value
  const base = scalar(row[m[1]])
  if (!m[2]) return base
  const num = toNumber(base)
  if (num === null) return NO_VALUE
  const operand = Number.parseFloat(m[3])
  return m[2] === '*' ? num * operand : num + operand
}

export function evalRecordCondition(row: Record<string, unknown>, cond: RecordCondition): boolean {
  const actual = scalar(row[cond.field])
  if (cond.op === 'null') return actual === null || actual === undefined || actual === ''
  if (cond.op === 'nnull') return actual !== null && actual !== undefined && actual !== ''
  const expected = resolveValue(cond.value, row)
  if (expected === NO_VALUE) return false
  switch (cond.op) {
    case 'eq':
    case 'neq': {
      let equal: boolean
      const a = toNumber(actual)
      const e = toNumber(expected)
      if (a !== null && e !== null) equal = a === e
      else if (actual === null || actual === undefined || expected === null)
        equal = (actual ?? null) === (expected ?? null)
      else equal = String(actual) === String(expected)
      return cond.op === 'eq' ? equal : !equal
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = toComparable(actual)
      const e = toComparable(expected)
      if (a === null || e === null) return false
      if (cond.op === 'gt') return a > e
      if (cond.op === 'gte') return a >= e
      if (cond.op === 'lt') return a < e
      return a <= e
    }
    case 'contains':
      if (actual === null || actual === undefined) return false
      return String(actual).toLowerCase().includes(String(expected).toLowerCase())
    default:
      return false
  }
}

/** Every condition holds (an empty list holds). */
export function recordMatchesAll(
  row: Record<string, unknown>,
  conditions: RecordCondition[] | null | undefined
): boolean {
  return (conditions ?? []).every((c) => evalRecordCondition(row, c))
}

/** Lenient read of a stored condition list — malformed entries are dropped. */
export function normalizeRecordConditions(raw: unknown): RecordCondition[] | null {
  if (!Array.isArray(raw)) return null
  const out: RecordCondition[] = []
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue
    const cc = c as { field?: unknown; op?: unknown; value?: unknown }
    if (typeof cc.field !== 'string' || cc.field === '') continue
    if (!(RECORD_CONDITION_OPS as readonly string[]).includes(String(cc.op))) continue
    out.push({ field: cc.field, op: cc.op as RecordConditionOp, value: cc.value })
  }
  return out.length > 0 ? out : null
}
