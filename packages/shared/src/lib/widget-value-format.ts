import { formatCurrency, toFiniteNumber } from './number-format'

/** A prefix that only says "dollars" — the currency format already shows the $. */
function isDollarPrefix(prefix: unknown): boolean {
  const p = String(prefix ?? '').trim()
  return p === '$' || p === 'US$' || p.toUpperCase() === 'USD'
}

/**
 * Formats one widget value-field figure. `percent` is the proc's 0–100 scale.
 * `currency` reads as money ($1,234.50); a widget whose own prefix names another
 * currency ("€") keeps that prefix and gets the plain two-decimal figure.
 * A number that arrives as text (a bigint / numeric column from a proc) reads the same
 * under an explicit format.
 */
export function formatWidgetValue(
  value: unknown,
  format: string,
  display?: { prefix?: unknown } | null
): string {
  if (value == null) return '—'
  // Text reads as a number only under an explicit format (no format: a code stays as sent).
  const n = typeof value === 'number' ? value : format ? toFiniteNumber(value) : null
  if (n != null && Number.isFinite(n)) {
    if (format === 'currency') {
      const prefix = String(display?.prefix ?? '').trim()
      if (prefix && !isDollarPrefix(prefix))
        return new Intl.NumberFormat(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        }).format(n)
      return formatCurrency(n)
    }
    if (format === 'integer') return new Intl.NumberFormat().format(Math.round(n))
    if (format === 'percent')
      return `${new Intl.NumberFormat(undefined, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1
      }).format(n)}%`
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n)
  }
  return String(value)
}

/** The prefix / suffix a value renders with. A missing value reads as a bare
 *  dash, so its affixes are dropped ("—", never "$—" or "—%"). A '$' prefix on a
 *  currency figure is dropped too: the figure carries its own symbol. */
export function affixesFor(
  value: unknown,
  display: { prefix?: unknown; suffix?: unknown; format?: unknown } | undefined
): { prefix: string; suffix: string } {
  if (value == null) return { prefix: '', suffix: '' }
  const currency = display?.format === 'currency'
  return {
    prefix: currency && isDollarPrefix(display?.prefix) ? '' : String(display?.prefix ?? ''),
    suffix: String(display?.suffix ?? '')
  }
}
