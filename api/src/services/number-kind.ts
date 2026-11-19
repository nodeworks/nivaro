/**
 * How a stored number reads on screen — the ONE rule every display path asks.
 *
 *   'money'   → $135,297.66   (the field says money: options.format 'currency',
 *                              options.currency, options.unit '$', interface
 *                              'currency', type 'money')
 *   'decimal' → 135,297.66    (decimal / float columns: grouped, up to the
 *                              field's precision, default 2)
 *   'count'   → 12,345        (whole-number counts and quantities: grouped)
 *   'plain'   → 4500123       (as stored: numbers people quote or key on —
 *                              the primary key, names ending in `id`, PO /
 *                              line / version numbers, years, codes, and any
 *                              text-typed field)
 *
 * The integer rule, in order:
 *   1. An explicit options.format wins: 'currency' = money; 'int' / 'integer'
 *      / 'number' / 'count' = count; 'decimal' = decimal; 'plain' / 'id' /
 *      'none' = plain.
 *   2. Text-typed fields (string, text, uuid, …) are plain.
 *   3. The primary key is plain.
 *   4. A name with a count word (count, qty, quantity, total, amount, units,
 *      price, …) is a number, even beside a reference word ("po_line_count").
 *   5. A name with a reference word (id, number, num, no, line, year, fy,
 *      code, zip, phone, version, rev, seq, po, sku, ref, key, …) or ending
 *      in "id" ("vendorid") is plain — decimal-typed columns too (legacy
 *      decimal(18,0) PO numbers).
 *   6. Every other whole-number field is a count; every other decimal field
 *      a decimal.
 *
 * Pure (no imports, no I/O). TWIN FILE: packages/shared/src/lib/number-kind.ts
 * and api/src/services/number-kind.ts must stay byte-identical (the API cannot
 * import packages/shared; an API test compares the two files).
 */

export type NumberKind = 'money' | 'decimal' | 'count' | 'plain'

/** The parts of a field definition the rule reads (CMSField, field-config, labels). */
export interface NumberFieldMeta {
  field?: string | null
  type?: string | null
  interface?: string | null
  options?: unknown
  display_options?: unknown
  computed_type?: string | null
  is_primary_key?: boolean | null
  schema?: { is_primary_key?: boolean | null } | null
}

const MONEY_TYPES = new Set(['money', 'currency', 'smallmoney'])
const DECIMAL_TYPES = new Set(['decimal', 'float', 'double', 'numeric', 'real', 'number'])
const INTEGER_TYPES = new Set([
  'integer',
  'int',
  'biginteger',
  'bigint',
  'smallint',
  'tinyint',
  'bigincrements',
  'increments'
])
const TEXT_TYPES = new Set([
  'string',
  'text',
  'uuid',
  'char',
  'varchar',
  'nvarchar',
  'csv',
  'hash',
  'json'
])

const COUNT_WORDS = new Set([
  'count',
  'counts',
  'qty',
  'quantity',
  'quantities',
  'total',
  'totals',
  'units',
  'sum',
  'amount',
  'balance',
  'hours',
  'minutes',
  'days',
  'size',
  'bytes',
  'weight',
  'length',
  'width',
  'height',
  'cost',
  'price'
])
const REFERENCE_WORDS = new Set([
  'id',
  'pk',
  'number',
  'num',
  'no',
  'nbr',
  'nr',
  'line',
  'year',
  'yr',
  'fy',
  'code',
  'zip',
  'zipcode',
  'postal',
  'phone',
  'fax',
  'ext',
  'seq',
  'sequence',
  'version',
  'ver',
  'rev',
  'revision',
  'po',
  'sku',
  'ref',
  'reference',
  'key',
  'acct',
  'account'
])

function objectOf(v: unknown): Record<string, unknown> {
  if (!v) return {}
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v)
      return p && typeof p === 'object' && !Array.isArray(p) ? p : {}
    } catch {
      return {}
    }
  }
  return typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/** "po_line_count" / "poLineCount" / "PO-Line" → ['po', 'line', 'count']. */
export function nameWords(name: string | null | undefined): string[] {
  return String(name ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/** The currency a money field shows in (ISO code), or null when the field is not money. */
export function numberCurrencyOf(meta: NumberFieldMeta | null | undefined): string | null {
  if (!meta) return null
  const o = objectOf(meta.options)
  const d = objectOf(meta.display_options)
  const fmt = String(o.format ?? d.format ?? '').toLowerCase()
  const unit = typeof o.unit === 'string' ? o.unit.trim() : ''
  const type = String(meta.type ?? '').toLowerCase()
  const iface = String(meta.interface ?? '').toLowerCase()
  const money =
    fmt === 'currency' ||
    !!o.currency ||
    !!d.currency ||
    (!fmt && unit === '$') ||
    iface === 'currency' ||
    MONEY_TYPES.has(type)
  if (!money) return null
  const c = String(o.currency ?? d.currency ?? 'USD').toUpperCase()
  return /^[A-Z]{3}$/.test(c) ? c : 'USD'
}

/**
 * The kind of number a field holds, or null when the field is not a number
 * field (a choice, a date, a percent display, an unknown type). Callers with
 * no field at all decide from the value (`numberKindOfValue`).
 */
export function numberKindOf(meta: NumberFieldMeta | null | undefined): NumberKind | null {
  if (!meta) return null
  const o = objectOf(meta.options)
  const fmt = String(o.format ?? '').toLowerCase()
  if (fmt === 'currency') return 'money'
  if (fmt === 'int' || fmt === 'integer' || fmt === 'number' || fmt === 'count') return 'count'
  if (fmt === 'decimal') return 'decimal'
  if (fmt === 'plain' || fmt === 'id' || fmt === 'none') return 'plain'
  if (numberCurrencyOf(meta)) return 'money'
  let type = String(meta.type ?? '').toLowerCase()
  if (!type || type === 'alias' || type === 'unknown')
    type = String(meta.computed_type ?? '').toLowerCase()
  if (TEXT_TYPES.has(type)) return 'plain'
  const decimal = DECIMAL_TYPES.has(type)
  if (!decimal && !INTEGER_TYPES.has(type)) return null
  if (meta.is_primary_key || meta.schema?.is_primary_key) return 'plain'
  const reference = isReferenceName(meta.field)
  // A reference stored in a decimal column (legacy decimal(18,0) PO numbers) stays plain too.
  if (reference) return 'plain'
  return decimal ? 'decimal' : 'count'
}

/**
 * True when a field name reads as something people quote or key on (rules 4
 * and 5): a reference word or an "…id" ending, with no count word beside it.
 */
export function isReferenceName(name: string | null | undefined): boolean {
  const n = String(name ?? '')
  const words = nameWords(n)
  if (words.some((w) => COUNT_WORDS.has(w))) return false
  // "vendorid" / "poid": a name that ends in "id" right after a word.
  const idSuffix = /[a-z]id$/i.test(n) && !/(paid|valid|void|grid|fluid|hybrid)$/i.test(n)
  return idSuffix || words.some((w) => REFERENCE_WORDS.has(w))
}

/**
 * The kind of a bare value with no field to ask: a number is a count (whole)
 * or a decimal; a numeric string with a fraction is a decimal, a whole-number
 * string stays plain (it is more often a stored code than a count).
 */
export function numberKindOfValue(value: unknown): NumberKind | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return Number.isInteger(value) ? 'count' : 'decimal'
  }
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null
  return s.includes('.') ? 'decimal' : 'plain'
}

/** Decimal places a field wants (options.precision, 0–10), else the fallback. */
export function numberDecimalsOf(meta: NumberFieldMeta | null | undefined, fallback = 2): number {
  const p = Number(objectOf(meta?.options).precision)
  if (!Number.isFinite(p)) return fallback
  return Math.min(Math.max(Math.trunc(p), 0), 10)
}
