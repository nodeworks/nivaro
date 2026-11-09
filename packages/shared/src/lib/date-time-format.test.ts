import { describe, expect, it } from 'vitest'
import { formatValue } from './format-value'
import { formatDateTime } from './utils'

// army 11: the worklist said "08/11/2026 - 10:10AM" while record history said
// "11/8/2026, 3:14:05 PM" — one shared date-time format everywhere.
describe('formatDateTime — the one date-time format', () => {
  it('reads "Nov 8, 2026, 3:14 PM" style in local time', () => {
    const s = formatDateTime(new Date(2026, 10, 8, 15, 14))
    expect(s).toMatch(/^Nov 8, 2026,? 3:14\s?PM$/)
  })
  it('never throws: empty is blank, garbage comes back as written', () => {
    expect(formatDateTime(null)).toBe('')
    expect(formatDateTime('')).toBe('')
    expect(formatDateTime('not a date')).toBe('not a date')
  })
})

describe('formatValue datetime columns', () => {
  it('a template with a time of day reads the shared format', () => {
    const iso = new Date(2026, 7, 11, 10, 10).toISOString()
    expect(formatValue(iso, { type: 'datetime', template: 'MM/DD/YYYY - h:mmA' })).toBe(
      formatDateTime(iso)
    )
  })
  it('a full-date template reads the one date style; partial templates keep theirs', () => {
    expect(formatValue('2026-06-30', { type: 'datetime', template: 'MM/DD/YYYY' })).toBe(
      'Jun 30, 2026'
    )
    expect(formatValue('2026-06-30', { type: 'datetime', template: 'MMM YYYY' })).toBe('Jun 2026')
  })
})
