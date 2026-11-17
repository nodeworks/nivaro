import { describe, expect, it } from 'vitest'
import { majorUsHolidaySet, majorUsHolidays } from '../../../services/major-holidays.js'

describe('majorUsHolidays', () => {
  it('lists the observed dates for 2026', () => {
    expect(majorUsHolidays(2026)).toEqual([
      '2026-01-01', // Thursday
      '2026-05-25', // last Monday of May (May 31 is a Sunday)
      '2026-07-03', // July 4 is a Saturday → Friday
      '2026-09-07', // first Monday of September
      '2026-11-26', // fourth Thursday of November
      '2026-11-27', // the day after
      '2026-12-25' // Friday
    ])
  })

  it('moves a Sunday holiday to Monday and a Saturday New Year to the Friday before', () => {
    expect(majorUsHolidays(2022)).toContain('2022-12-26') // Christmas on a Sunday
    expect(majorUsHolidays(2022)).toContain('2021-12-31') // Jan 1 2022 is a Saturday
  })

  it('spans the years asked for', () => {
    const set = majorUsHolidaySet(2025, 2027)
    expect(set.has('2025-11-27')).toBe(true)
    expect(set.has('2027-11-25')).toBe(true)
    expect(set.size).toBe(21)
  })
})
