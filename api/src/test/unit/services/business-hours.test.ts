import { describe, expect, it } from 'vitest'
import { businessHoursElapsed, type BusinessSchedule } from '../../../services/business-hours.js'

const WEEKDAYS_9_5: BusinessSchedule = {
  startHour: 9,
  endHour: 17,
  days: new Set([1, 2, 3, 4, 5]),
  holidays: new Set(),
  timeZone: null
}

describe('businessHoursElapsed', () => {
  it('counts a full business day as 8 hours', () => {
    // Tue 2026-07-07 00:00 → Wed 2026-07-08 00:00
    const from = new Date(2026, 6, 7, 0, 0)
    const to = new Date(2026, 6, 8, 0, 0)
    expect(businessHoursElapsed(from, to, WEEKDAYS_9_5)).toBe(8)
  })

  it('counts zero over a weekend', () => {
    // Sat 2026-07-11 00:00 → Mon 2026-07-13 00:00
    const from = new Date(2026, 6, 11, 0, 0)
    const to = new Date(2026, 6, 13, 0, 0)
    expect(businessHoursElapsed(from, to, WEEKDAYS_9_5)).toBe(0)
  })

  it('skips holiday dates entirely', () => {
    const withHoliday: BusinessSchedule = {
      ...WEEKDAYS_9_5,
      holidays: new Set(['2026-07-07'])
    }
    // Tue (holiday) + Wed → only Wed counts
    const from = new Date(2026, 6, 7, 0, 0)
    const to = new Date(2026, 6, 9, 0, 0)
    expect(businessHoursElapsed(from, to, withHoliday)).toBe(8)
    expect(businessHoursElapsed(from, to, WEEKDAYS_9_5)).toBe(16)
  })

  it('honors custom days and hours', () => {
    const weekendCrew: BusinessSchedule = {
      startHour: 6,
      endHour: 12,
      days: new Set([0, 6]),
      holidays: new Set(),
      timeZone: null
    }
    // Sat 2026-07-11 00:00 → Sun 2026-07-12 23:00 → 6 + 6 hours
    const from = new Date(2026, 6, 11, 0, 0)
    const to = new Date(2026, 6, 12, 23, 0)
    expect(businessHoursElapsed(from, to, weekendCrew)).toBe(12)
  })
})

describe('businessHoursElapsed with an explicit timezone', () => {
  it('judges the business window in the schedule zone, not the process zone', () => {
    const easternNine2Five: BusinessSchedule = {
      startHour: 9,
      endHour: 17,
      days: new Set([1, 2, 3, 4, 5]),
      holidays: new Set(),
      timeZone: 'America/New_York'
    }
    // Tue 2026-07-07 13:00 UTC → 21:00 UTC = 09:00 → 17:00 Eastern (EDT).
    const from = new Date(Date.UTC(2026, 6, 7, 13, 0))
    const to = new Date(Date.UTC(2026, 6, 7, 21, 0))
    expect(businessHoursElapsed(from, to, easternNine2Five)).toBe(8)
    // The same instants judged as UTC wall-clock would count only 13→17 = 4.
    expect(businessHoursElapsed(from, to, { ...easternNine2Five, timeZone: 'UTC' })).toBe(4)
  })
})
