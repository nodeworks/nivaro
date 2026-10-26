import { describe, expect, it } from 'vitest'

process.env.TZ = 'America/New_York'

const { displayValue } = await import('./RevisionsPanel')

describe('revision values on date-only fields', () => {
  it('shows a date field stored as UTC midnight on its own day', () => {
    expect(displayValue('2026-11-15T00:00:00.000Z', true)).toBe(
      new Date(2026, 10, 15).toLocaleDateString()
    )
  })

  it('shows UTC midnight as a day even when the field is registered as datetime (MSSQL date)', () => {
    expect(displayValue('2026-11-15T00:00:00.000Z')).toBe(
      new Date(2026, 10, 15).toLocaleDateString()
    )
  })

  it('shows a bare yyyy-mm-dd as that day', () => {
    expect(displayValue('2026-11-15')).toBe(new Date(2026, 10, 15).toLocaleDateString())
  })

  it('keeps real timestamps as date + time', () => {
    const v = '2026-11-15T14:30:00.000Z'
    expect(displayValue(v)).toBe(new Date(v).toLocaleString())
  })
})
