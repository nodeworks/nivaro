import { describe, expect, it } from 'vitest'
import { formatDate, isNullDate, toLocalDateString } from './utils'

describe('toLocalDateString', () => {
  it('keeps a date-only value on its calendar day in any zone', () => {
    expect(toLocalDateString('2026-11-15')).toBe(new Date(2026, 10, 15).toLocaleDateString())
    expect(toLocalDateString('2001-01-01')).toBe(new Date(2001, 0, 1).toLocaleDateString())
    expect(toLocalDateString('2026-11-15T00:00:00.000Z')).toBe(
      new Date(2026, 10, 15).toLocaleDateString()
    )
    expect(toLocalDateString('2026-11-15T00:00:00+00:00')).toBe(
      new Date(2026, 10, 15).toLocaleDateString()
    )
  })
  it('keeps years below 100', () => {
    const d = new Date(2000, 0, 1)
    d.setFullYear(1)
    expect(toLocalDateString('0001-01-01')).toBe(d.toLocaleDateString())
  })
  it('renders real timestamps as before', () => {
    const ts = '2026-11-15T18:30:00.000Z'
    expect(toLocalDateString(ts)).toBe(new Date(ts).toLocaleDateString())
  })
  it('returns the raw value when it is not a date', () => {
    expect(toLocalDateString('soon')).toBe('soon')
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
