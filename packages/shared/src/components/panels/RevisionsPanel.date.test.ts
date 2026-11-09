import { describe, expect, it } from 'vitest'
import { formatDateTime } from '../../lib/utils'

process.env.TZ = 'America/New_York'

const { displayValue } = await import('./RevisionsPanel')

describe('revision values on date-only fields', () => {
  it('shows a date field stored as UTC midnight on its own day', () => {
    expect(displayValue('2026-11-15T00:00:00.000Z', true)).toBe('Nov 15, 2026')
  })

  it('shows UTC midnight as a day even when the field is registered as datetime (MSSQL date)', () => {
    expect(displayValue('2026-11-15T00:00:00.000Z')).toBe('Nov 15, 2026')
  })

  it('shows a bare yyyy-mm-dd as that day', () => {
    expect(displayValue('2026-11-15')).toBe('Nov 15, 2026')
  })

  it('keeps real timestamps as date + time', () => {
    const v = '2026-11-15T14:30:00.000Z'
    expect(displayValue(v)).toBe(formatDateTime(v))
  })
})
