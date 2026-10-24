/**
 * Whether a value from a URL segment or a filter can be compared with a
 * column of this SQL Server type at all. SQL Server converts the bound value
 * to the column's type, so `'abc'` against an int key or `999999` against a
 * uniqueidentifier is not "no match" — it is a conversion error, and the read
 * used to come back as a 500 carrying the statement. Callers treat a value
 * that does not fit as matching nothing (an id route answers 404).
 *
 * Types this does not judge (text, dates, binary…) always fit.
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const INT_RANGES: Record<string, [bigint, bigint]> = {
  tinyint: [0n, 255n],
  smallint: [-32_768n, 32_767n],
  int: [-2_147_483_648n, 2_147_483_647n],
  bigint: [-9_223_372_036_854_775_808n, 9_223_372_036_854_775_807n]
}
const DECIMAL_TYPES = new Set(['decimal', 'numeric', 'money', 'smallmoney', 'float', 'real'])
const NUMERIC_TEXT = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i

export function valueFitsSqlType(value: unknown, dataType: string | null | undefined): boolean {
  if (value == null || !dataType) return true
  const type = dataType.toLowerCase()
  const range = INT_RANGES[type]
  if (range) {
    let n: bigint
    if (typeof value === 'bigint') n = value
    else if (typeof value === 'number') {
      if (!Number.isInteger(value)) return false
      n = BigInt(value)
    } else if (typeof value === 'string' && /^[-+]?\d+$/.test(value.trim())) {
      n = BigInt(value.trim())
    } else if (typeof value === 'boolean') return true
    else return false
    return n >= range[0] && n <= range[1]
  }
  if (DECIMAL_TYPES.has(type)) {
    if (typeof value === 'number') return Number.isFinite(value)
    if (typeof value === 'string') return NUMERIC_TEXT.test(value.trim())
    return typeof value === 'boolean' || typeof value === 'bigint'
  }
  if (type === 'bit') {
    return (
      typeof value === 'boolean' ||
      value === 0 ||
      value === 1 ||
      (typeof value === 'string' && /^(0|1|true|false)$/i.test(value.trim()))
    )
  }
  if (type === 'uniqueidentifier') return typeof value === 'string' && UUID_RE.test(value.trim())
  return true
}

const RANGE_OPS = new Set(['_gt', '_gte', '_lt', '_lte', '_between', '_nbetween'])

/**
 * A range bound against a column of this type: any finite number compares
 * with any numeric column (`qty > 0.5` on an int, `< 1000` on a tinyint), so
 * only text that is not a number — or not a uuid on a uuid column — cannot.
 * Fractional or out-of-range numeric text against an integer column is
 * handed on as a number: SQL Server would otherwise convert the TEXT to int
 * ('0.5' fails, '3000000000' overflows). Integer text in range stays text.
 */
function rangeBound(value: unknown, type: string): { ok: boolean; value?: unknown } {
  if (value == null) return { ok: true, value }
  const t = type.toLowerCase()
  if (INT_RANGES[t] || DECIMAL_TYPES.has(t)) {
    if (typeof value === 'number') return { ok: Number.isFinite(value), value }
    if (typeof value === 'bigint' || typeof value === 'boolean') return { ok: true, value }
    if (typeof value === 'string' && NUMERIC_TEXT.test(value.trim())) {
      // Decimal columns convert numeric text exactly; keep it (no float
      // rounding). So do integer columns for integer text in their range
      // ('9007199254740993' on a bigint stays exact).
      if (!INT_RANGES[t] || valueFitsSqlType(value, t)) return { ok: true, value }
      const n = Number(value.trim())
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false }
    }
    return { ok: false }
  }
  if (t === 'uniqueidentifier' || t === 'bit') return { ok: valueFitsSqlType(value, t), value }
  return { ok: true, value }
}

/**
 * Fit one field's filter operators to its column type, IN PLACE on the object
 * given (callers pass their own copy), so no value reaches SQL that its column
 * cannot be compared with:
 *  - `_eq` such a value matches nothing;
 *  - `_neq` keeps every non-null row (the compiler's `!=` already drops NULLs);
 *  - `_in` / `_nin` lose the values that cannot match; a `_nin` left empty
 *    keeps every non-null row, as `col NOT IN (…)` would;
 *  - a range bound is refused only when it is not a number at all (or not a
 *    uuid on a uuid column) — its name comes back for the caller to refuse.
 */
export function fitFilterOps(
  ops: Record<string, unknown>,
  dataType: string | null | undefined
): string | null {
  if (!dataType) return null
  const fits = (v: unknown) => valueFitsSqlType(v, dataType)
  let never = false
  let notNull = false
  for (const [op, val] of Object.entries(ops)) {
    if (op === '_eq' && !Array.isArray(val) && !fits(val)) {
      delete ops._eq
      never = true
    } else if (op === '_neq' && !Array.isArray(val) && !fits(val)) {
      delete ops._neq
      notNull = true
    } else if (op === '_in' && Array.isArray(val)) {
      if (!val.every(fits)) ops._in = val.filter(fits)
    } else if (op === '_nin' && Array.isArray(val)) {
      if (!val.every(fits)) {
        const kept = val.filter(fits)
        if (kept.length > 0) ops._nin = kept
        else {
          delete ops._nin
          notNull = true
        }
      }
    } else if (RANGE_OPS.has(op)) {
      const vals = Array.isArray(val) ? val : [val]
      const bounds = vals.map((v) => rangeBound(v, dataType))
      if (bounds.some((b) => !b.ok)) return op
      ops[op] = Array.isArray(val) ? bounds.map((b) => b.value) : bounds[0].value
    }
  }
  // An empty `_in` compiles to 1 = 0; `_nnull` ignores its value.
  if (never) ops._in = []
  if (notNull) ops._nnull = true
  return null
}

export interface ColumnShape {
  type: string
  precision?: number | null
  scale?: number | null
}

/**
 * Why a number cannot be written into this column, in plain words — or null
 * when it can. Checked before a write so a value like 1e308 is a 400 naming
 * the field instead of a driver error ("Bigint must be safe integer…", an
 * arithmetic overflow) answered as a 500. A JS integer past 2^53 cannot even
 * be sent (the driver binds it as bigint and refuses it), whatever the column.
 */
export function numberProblem(value: unknown, col: ColumnShape | undefined): string | null {
  if (value == null || value === '' || typeof value === 'boolean' || !col) return null
  const type = col.type.toLowerCase()
  const range = INT_RANGES[type]
  const numeric = !!range || DECIMAL_TYPES.has(type)
  let n: number
  if (typeof value === 'number') n = value
  else if (typeof value === 'string' && numeric) {
    if (!NUMERIC_TEXT.test(value.trim())) return 'must be a number'
    n = Number(value.trim())
  } else return null
  if (!Number.isFinite(n)) return 'must be a finite number'
  if (typeof value === 'number' && Number.isInteger(n) && !Number.isSafeInteger(n)) {
    return 'is too large'
  }
  if (range) {
    const t = Math.trunc(n)
    if (t < Number(range[0]) || t > Number(range[1])) {
      return `must be between ${range[0].toLocaleString('en-US')} and ${range[1].toLocaleString('en-US')}`
    }
  }
  if ((type === 'decimal' || type === 'numeric') && col.precision) {
    const max = 10 ** (col.precision - (col.scale ?? 0))
    if (Math.abs(n) >= max) return `must be smaller than ${max.toLocaleString('en-US')}`
  }
  return null
}
