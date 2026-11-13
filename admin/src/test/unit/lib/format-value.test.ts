import { formatDateTime, toLocalDateString } from '@nivaro/shared'
import { describe, expect, it } from 'vitest'
import { formatMultiValue, formatValue } from '@/lib/format-value'

describe('formatValue datetime', () => {
  const iso = '2026-03-05T14:07:09.000Z'
  // Output depends on the local TZ; expected values come from the shared formatters.

  // Army 11 (4b1c9f350): a full calendar date reads the one read-only date style and a
  // template with a time of day reads the one shared date-time format, whatever the
  // column's template says. Partial templates (YYYY, MMM YYYY…) keep their tokens.
  it('a full calendar date template reads the one date style', () => {
    expect(formatValue(iso, { type: 'datetime', template: 'DD/MM/YYYY' })).toBe(
      toLocalDateString(iso)
    )
    // A bare date stays on its stored day in every timezone.
    expect(formatValue('2026-03-05', { type: 'datetime', template: 'DD/MM/YYYY' })).toBe(
      'Mar 5, 2026'
    )
  })

  it('a template with a time of day reads the shared date-time format', () => {
    for (const template of ['YYYY-MM-DD HH:mm:ss', 'h hh A a', 'h:mm A', 'hh:mm']) {
      expect(formatValue(iso, { type: 'datetime', template })).toBe(formatDateTime(iso))
    }
  })

  it('renders MMM as short month name', () => {
    const out = formatValue('2026-03-05T12:00:00', { type: 'datetime', template: 'DD MMM YYYY' })
    expect(out).toContain('Mar')
  })

  it('renders YY as two-digit year', () => {
    expect(formatValue('2026-03-05T12:00:00', { type: 'datetime', template: 'YY' })).toBe('26')
  })

  it('relative template delegates to formatRelative', () => {
    const recent = new Date(Date.now() - 5 * 60000).toISOString()
    expect(formatValue(recent, { type: 'datetime', template: 'relative' })).toBe('5m ago')
  })

  it('unparseable date returns raw', () => {
    expect(formatValue('not a date', { type: 'datetime', template: 'DD/MM/YYYY' })).toBe(
      'not a date'
    )
  })

  it('the shared date-time format reads midnight and noon as 12, not 0', () => {
    // Local-time constructor: hours are exactly what we assert against.
    const midnight = new Date(2026, 2, 5, 0, 30).toISOString()
    const noon = new Date(2026, 2, 5, 12, 30).toISOString()
    expect(formatValue(midnight, { type: 'datetime', template: 'h:mm A' })).toBe(
      'Mar 5, 2026, 12:30 AM'
    )
    expect(formatValue(noon, { type: 'datetime', template: 'hh:mm' })).toBe('Mar 5, 2026, 12:30 PM')
  })
})

describe('formatValue number', () => {
  it('applies decimals and thousands', () => {
    expect(formatValue('1234.5', { type: 'number', decimals: 2, thousands: true })).toBe('1,234.50')
  })

  it('applies prefix and suffix', () => {
    expect(formatValue('42', { type: 'number', decimals: 0, prefix: '£', suffix: ' GBP' })).toBe(
      '£42 GBP'
    )
  })

  it('no thousands grouping by default', () => {
    expect(formatValue('1234', { type: 'number', decimals: 0 })).toBe('1234')
  })

  it('NaN returns raw', () => {
    expect(formatValue('abc', { type: 'number', decimals: 2 })).toBe('abc')
  })
})

describe('formatValue boolean', () => {
  const cfg = { type: 'boolean', true_label: 'Active', false_label: 'Inactive' } as const

  it('maps truthy variants', () => {
    for (const v of ['true', 'TRUE', '1', 'yes', 'Y']) {
      expect(formatValue(v, cfg)).toBe('Active')
    }
  })

  it('maps falsy variants', () => {
    for (const v of ['false', 'FALSE', '0', 'no', 'N']) {
      expect(formatValue(v, cfg)).toBe('Inactive')
    }
  })

  it('unknown value returns raw', () => {
    expect(formatValue('maybe', cfg)).toBe('maybe')
  })
})

describe('formatMultiValue', () => {
  const cfg = { type: 'datetime', template: 'YYYY' } as const

  it('single value formats directly', () => {
    expect(formatMultiValue('2026-03-05T12:00:00', cfg)).toBe('2026')
  })

  it('formats each comma-joined value', () => {
    expect(formatMultiValue('2025-01-01T12:00:00, 2026-06-06T12:00:00', cfg)).toBe('2025, 2026')
  })

  it('preserves +N more suffix', () => {
    expect(formatMultiValue('2025-01-01T12:00:00, 2026-06-06T12:00:00 +2 more', cfg)).toBe(
      '2025, 2026 +2 more'
    )
  })

  it('empty string stays empty', () => {
    expect(formatMultiValue('', cfg)).toBe('')
  })
})
