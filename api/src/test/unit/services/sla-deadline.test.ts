import { describe, expect, it } from 'vitest'
import { type BusinessSchedule, businessHoursElapsed } from '../../../services/business-hours.js'
import { businessHoursDeadline, slaDeadlines } from '../../../services/sla-deadline.js'

const WEEKDAYS_9_5: BusinessSchedule = {
  startHour: 9,
  endHour: 17,
  days: new Set([1, 2, 3, 4, 5]),
  holidays: new Set(),
  timeZone: 'America/New_York'
}

const H = 3_600_000

describe('slaDeadlines — calendar rules', () => {
  it('puts warning and due at the threshold fractions of the duration', () => {
    const entered = new Date('2026-11-14T10:00:00Z')
    const d = slaDeadlines({
      enteredAt: entered,
      durationHours: 24,
      warningPct: 75,
      businessHoursOnly: false
    })
    expect(d.due_at?.toISOString()).toBe('2026-11-15T10:00:00.000Z')
    expect(d.warning_at?.toISOString()).toBe('2026-11-15T04:00:00.000Z')
  })

  it('has no warning instant for a 100 % threshold or none', () => {
    const base = { enteredAt: '2026-11-14T10:00:00Z', durationHours: 2, businessHoursOnly: false }
    expect(slaDeadlines({ ...base, warningPct: 100 }).warning_at).toBeNull()
    expect(slaDeadlines({ ...base, warningPct: null }).warning_at).toBeNull()
  })

  it('answers nothing without an entry time or a duration', () => {
    expect(
      slaDeadlines({ enteredAt: null, durationHours: 4, warningPct: 50, businessHoursOnly: false })
    ).toEqual({ warning_at: null, due_at: null })
    expect(
      slaDeadlines({
        enteredAt: '2026-11-14T10:00:00Z',
        durationHours: 0,
        warningPct: 50,
        businessHoursOnly: false
      })
    ).toEqual({ warning_at: null, due_at: null })
  })
})

describe('businessHoursDeadline', () => {
  it('lands where businessHoursElapsed first reaches the hours (same step math)', () => {
    // Fri 2026-11-13 15:30 ET: 1.5 h left that day (15:30, 16:30 steps), then Monday.
    const from = new Date('2026-11-13T20:30:00Z')
    for (const hours of [1, 2, 3, 8, 9, 17]) {
      const due = businessHoursDeadline(from, hours, WEEKDAYS_9_5)
      expect(due).not.toBeNull()
      const t = (due as Date).getTime()
      expect(businessHoursElapsed(from, new Date(t), WEEKDAYS_9_5)).toBeGreaterThanOrEqual(hours)
      expect(businessHoursElapsed(from, new Date(t - 1), WEEKDAYS_9_5)).toBeLessThan(hours)
    }
  })

  it('skips the weekend', () => {
    // Fri 16:30 ET start: the 1st step (16:30) is working; steps keep the :30, so Mon 08:30
    // is outside 9–17 and the 2nd working step is Mon 09:30 ET.
    const from = new Date('2026-11-13T21:30:00Z')
    const due = businessHoursDeadline(from, 2, WEEKDAYS_9_5) as Date
    expect(due.toISOString()).toBe('2026-11-16T14:30:00.001Z')
  })

  it('rounds partial hours up to the next whole working step', () => {
    const from = new Date('2026-11-16T14:00:00Z') // Mon 09:00 ET
    const a = businessHoursDeadline(from, 2.5, WEEKDAYS_9_5) as Date
    const b = businessHoursDeadline(from, 3, WEEKDAYS_9_5) as Date
    expect(a.getTime()).toBe(b.getTime())
    expect(a.getTime()).toBe(from.getTime() + 2 * H + 1)
  })

  it('gives up on a schedule with no working days', () => {
    const never: BusinessSchedule = { ...WEEKDAYS_9_5, days: new Set() }
    expect(businessHoursDeadline(new Date('2026-11-16T14:00:00Z'), 1, never)).toBeNull()
  })

  it('feeds slaDeadlines for business-hours rules', () => {
    const d = slaDeadlines({
      enteredAt: '2026-11-16T14:00:00Z',
      durationHours: 8,
      warningPct: 50,
      businessHoursOnly: true,
      schedule: WEEKDAYS_9_5
    })
    expect(d.warning_at?.getTime()).toBe(new Date('2026-11-16T14:00:00Z').getTime() + 3 * H + 1)
    expect(d.due_at?.getTime()).toBe(new Date('2026-11-16T14:00:00Z').getTime() + 7 * H + 1)
  })
})
