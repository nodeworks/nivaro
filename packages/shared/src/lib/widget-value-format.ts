/** Formats one widget value-field figure. `percent` is the proc's 0–100 scale. */
export function formatWidgetValue(value: unknown, format: string): string {
  if (value == null) return '—'
  if (typeof value === 'number') {
    if (format === 'currency')
      return new Intl.NumberFormat(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(value)
    if (format === 'integer') return new Intl.NumberFormat().format(Math.round(value))
    if (format === 'percent')
      return `${new Intl.NumberFormat(undefined, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1
      }).format(value)}%`
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)
  }
  return String(value)
}
