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

/** The prefix / suffix a value renders with. A missing value reads as a bare
 *  dash, so its affixes are dropped ("—", never "$—" or "—%"). */
export function affixesFor(
  value: unknown,
  display: { prefix?: unknown; suffix?: unknown } | undefined
): { prefix: string; suffix: string } {
  if (value == null) return { prefix: '', suffix: '' }
  return {
    prefix: String(display?.prefix ?? ''),
    suffix: String(display?.suffix ?? '')
  }
}
