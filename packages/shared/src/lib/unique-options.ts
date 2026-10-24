/**
 * Filter options, one per VALUE (first row wins). The dedupe keys on the value
 * the filter SENDS, never on the label: two regions both short-named 'MDW'
 * (ids 13 and 20) send the same `MDW` when value_field is short_name, and the
 * procedures filter on `short_name IN (…)`, so one option matches both regions'
 * records. A filter whose value is the id keeps both rows — their values differ.
 */
export function uniqueByValue<T>(rows: T[], valueOf: (row: T) => string): T[] {
  const seen = new Set<string>()
  return rows.filter((r) => {
    const v = valueOf(r)
    if (seen.has(v)) return false
    seen.add(v)
    return true
  })
}
