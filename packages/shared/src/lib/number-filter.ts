// The numeric counterpart of date-filter: a column holding money or a count
// filters by comparison, not by substring. Same encoding idea — the operator
// travels with the value (`num:gte:1000`), so saved views survive.

export type NumberFilterOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'between'

export interface NumberFilterValue {
  op: NumberFilterOp
  a: number
  b?: number
}

export const NUMBER_FILTER_OPS: Array<{ op: NumberFilterOp; symbol: string; label: string }> = [
  { op: 'eq', symbol: '=', label: 'Equals' },
  { op: 'neq', symbol: '≠', label: 'Not equal' },
  { op: 'gt', symbol: '>', label: 'Greater than' },
  { op: 'gte', symbol: '≥', label: 'At least' },
  { op: 'lt', symbol: '<', label: 'Less than' },
  { op: 'lte', symbol: '≤', label: 'At most' },
  { op: 'between', symbol: '↔', label: 'Between' }
]

export function parseNumberFilter(raw: string | null | undefined): NumberFilterValue | null {
  if (!raw || !raw.startsWith('num:')) return null
  const rest = raw.slice(4)
  const i = rest.indexOf(':')
  if (i < 0) return null
  const op = rest.slice(0, i) as NumberFilterOp
  const val = rest.slice(i + 1)
  if (op === 'between') {
    const [a, b] = val.split('..').map(Number)
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null
    return { op, a: Math.min(a, b), b: Math.max(a, b) }
  }
  if (!NUMBER_FILTER_OPS.some((o) => o.op === op)) return null
  const a = Number(val)
  return Number.isFinite(a) ? { op, a } : null
}

export function formatNumberFilter(v: NumberFilterValue): string {
  return v.op === 'between'
    ? `num:between:${v.a}..${v.b ?? v.a}`
    : `num:${v.op}:${v.a}`
}

export function describeNumberFilter(v: NumberFilterValue): string {
  const sym = NUMBER_FILTER_OPS.find((o) => o.op === v.op)?.symbol ?? v.op
  const n = (x: number) => x.toLocaleString()
  return v.op === 'between' ? `${n(v.a)} – ${n(v.b ?? v.a)}` : `${sym} ${n(v.a)}`
}

/** Currency and separators are display, not data. */
export function numberOfValue(value: unknown): number | null {
  if (value == null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const n = Number(String(value).replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? n : null
}

export function matchesNumberFilter(value: unknown, v: NumberFilterValue): boolean {
  const n = numberOfValue(value)
  if (n == null) return false
  switch (v.op) {
    case 'eq':
      return n === v.a
    case 'neq':
      return n !== v.a
    case 'gt':
      return n > v.a
    case 'gte':
      return n >= v.a
    case 'lt':
      return n < v.a
    case 'lte':
      return n <= v.a
    case 'between':
      return n >= v.a && n <= (v.b as number)
  }
}
