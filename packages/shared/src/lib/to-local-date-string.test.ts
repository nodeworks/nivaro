import { describe, expect, it } from 'vitest'
import { formatDate, formatDateTime, formatRelative, isNullDate, toLocalDateString } from './utils'

describe('toLocalDateString', () => {
  // army 11: one read-only date style everywhere ("Jun 30, 2026").
  it('keeps a date-only value on its calendar day in any zone', () => {
    expect(toLocalDateString('2026-11-15')).toBe('Nov 15, 2026')
    expect(toLocalDateString('2001-01-01')).toBe('Jan 1, 2001')
    expect(toLocalDateString('2026-11-15T00:00:00.000Z')).toBe('Nov 15, 2026')
    expect(toLocalDateString('2026-11-15T00:00:00+00:00')).toBe('Nov 15, 2026')
    expect(toLocalDateString('2026-06-30')).toBe(formatDate('2026-06-30'))
  })
  it('keeps years below 100', () => {
    expect(toLocalDateString('0001-01-01')).toBe('Jan 1, 1')
  })
  it('renders real timestamps in the same style', () => {
    const ts = '2026-11-15T18:30:00.000Z'
    expect(toLocalDateString(ts)).toBe(formatDate(ts))
  })
  it('returns the raw value when it is not a date', () => {
    expect(toLocalDateString('soon')).toBe('soon')
  })
})

describe('formatRelative past a week', () => {
  it('shows the date and the time, never the date alone', () => {
    const old = new Date(2026, 5, 8, 15, 14)
    expect(formatRelative(old)).toBe(formatDateTime(old))
    expect(formatRelative(old)).toMatch(/Jun 8, 2026,? 3:14\s?PM/)
  })
})

describe('legacy zero dates', () => {
  it('render as empty, not as 12/29/1899', () => {
    expect(toLocalDateString('1899-12-30T00:00:00.000Z')).toBe('')
    expect(toLocalDateString('1900-01-01')).toBe('')
    expect(formatDate('1899-12-30T00:00:00.000Z')).toBe('')
    expect(isNullDate(new Date('1899-12-30T00:00:00.000Z'))).toBe(true)
  })
  it('leaves real days alone', () => {
    expect(isNullDate('1899-12-29')).toBe(false)
    expect(isNullDate('2026-11-15')).toBe(false)
    expect(isNullDate(null)).toBe(false)
  })
})
