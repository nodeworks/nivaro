/**
 * A report alert condition as people read it (army 9 b16: "row_count gte 40",
 * "value ≥ 1000000"). Twin of packages/shared/src/components/alerts/types.ts
 * reportConditionText — change both.
 */
const OPS: Record<string, string> = {
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  eq: '=',
  neq: '≠'
}

const words = (s: string) => {
  const t = s.replace(/_/g, ' ').trim()
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t
}

/** "row_count" → "Rows", "value" → "Value", "sum:amount" → "Total of amount", "tile:Open" → "Open". */
export function reportConditionField(field: string): string {
  if (field === 'value') return 'Value'
  if (field === 'row_count') return 'Rows'
  const m = /^(sum|avg|max|min|tile):(.+)$/.exec(field)
  if (!m) return words(field)
  const col = m[2].replace(/_/g, ' ').trim()
  if (m[1] === 'tile') return m[2].trim()
  const lead = { sum: 'Total of', avg: 'Average', max: 'Largest', min: 'Smallest' }[m[1]] ?? ''
  return `${lead} ${col}`.trim()
}

export const reportConditionNumber = (v: unknown): string => {
  const n = Number(v)
  return Number.isFinite(n)
    ? n.toLocaleString('en-US', { maximumFractionDigits: 2 })
    : String(v ?? '')
}

export function reportConditionText(c: { field: string; op: string; value: unknown }): string {
  return `${reportConditionField(c.field)} ${OPS[c.op] ?? c.op} ${reportConditionNumber(c.value)}`
}
