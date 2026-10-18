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

// The pre-2026-10-18 loop: one wall-clock read per hourly step. The day-wise
// count must match it exactly, DST days included.
function referenceElapsed(from: Date, to: Date, s: BusinessSchedule): number {
  const fmt = s.timeZone
    ? new Intl.DateTimeFormat('en-US', {
        timeZone: s.timeZone,
        weekday: 'short',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: 'numeric',
        hourCycle: 'h23'
      })
    : null
  const DAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  const wall = (d: Date) => {
    if (!fmt) {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      return { day: d.getDay(), hour: d.getHours(), key }
    }
    const parts = fmt.formatToParts(d)
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
    return {
      day: DAYS[get('weekday')],
      hour: Number(get('hour')),
      key: `${get('year')}-${get('month')}-${get('day')}`
    }
  }
  let hours = 0
  const cur = new Date(from)
  while (cur < to) {
    const wc = wall(cur)
    if (
      !s.holidays.has(wc.key) &&
      s.days.has(wc.day) &&
      wc.hour >= s.startHour &&
      wc.hour < s.endHour
    )
      hours++
    cur.setTime(cur.getTime() + 3_600_000)
  }
  return hours
}

describe('businessHoursElapsed matches the hour-by-hour count', () => {
  // Deterministic pseudo-random (no flaky seeds).
  let seed = 20261018
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const zones: Array<string | null> = [
    'America/New_York',
    'Asia/Kolkata',
    'UTC',
    'Australia/Sydney',
    null
  ]
  const DST_EDGES = [Date.UTC(2026, 2, 7), Date.UTC(2026, 9, 31), Date.UTC(2026, 3, 4)]

  it('over random ranges, schedules, holidays and DST changes', () => {
    for (let i = 0; i < 400; i++) {
      const tz = zones[i % zones.length]
      const startHour = Math.floor(rnd() * 12)
      const endHour = startHour + 1 + Math.floor(rnd() * (24 - startHour))
      const days = new Set([0, 1, 2, 3, 4, 5, 6].filter(() => rnd() < 0.7))
      const base =
        i % 3 === 0
          ? DST_EDGES[i % DST_EDGES.length]
          : Date.UTC(2026, 0, 1) + rnd() * 300 * 86_400_000
      const from = new Date(
        base + Math.floor(rnd() * 3 * 86_400_000) + Math.floor(rnd() * 3_600_000)
      )
      const to = new Date(
        from.getTime() + Math.floor(rnd() * 40 * 86_400_000) + Math.floor(rnd() * 3_600_000)
      )
      const holidays = new Set<string>()
      for (let h = 0; h < 3; h++) {
        const d = new Date(from.getTime() + rnd() * (to.getTime() - from.getTime()))
        holidays.add(d.toISOString().slice(0, 10))
      }
      const s: BusinessSchedule = {
        ...WEEKDAYS_9_5,
        timeZone: tz,
        startHour,
        endHour,
        days,
        holidays
      }
      expect([i, businessHoursElapsed(from, to, s)]).toEqual([i, referenceElapsed(from, to, s)])
    }
  })

  it('an empty or reversed range is zero', () => {
    const t = new Date('2026-10-14T13:00:00Z')
    expect(businessHoursElapsed(t, t, WEEKDAYS_9_5)).toBe(0)
    expect(businessHoursElapsed(t, new Date(t.getTime() - 3_600_000), WEEKDAYS_9_5)).toBe(0)
  })
})
