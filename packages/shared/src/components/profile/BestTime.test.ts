import { describe, expect, it } from 'vitest'
import { hoursUntilWindow, overlapHours, reachSummary } from './BestTime'

describe('best time to reach (#639)', () => {
  it('measures the overlap of two daily windows', () => {
    expect(overlapHours({ start: 13, end: 21 }, { start: 14, end: 22 })).toBe(7)
    expect(overlapHours({ start: 13, end: 21 }, { start: 22, end: 23 })).toBe(0)
  })
  it('handles a window that crosses UTC midnight', () => {
    // 20:00–04:00 UTC against 02:00–06:00 UTC overlaps two hours.
    expect(overlapHours({ start: 20, end: 4 }, { start: 2, end: 6 })).toBe(2)
    expect(overlapHours({ start: 2, end: 6 }, { start: 22, end: 27 })).toBe(1)
  })
  it('counts the hours until the window opens, zero inside it', () => {
    expect(hoursUntilWindow(15, { start: 13, end: 21 })).toBe(0)
    expect(hoursUntilWindow(11, { start: 13, end: 21 })).toBe(2)
    expect(hoursUntilWindow(22, { start: 13, end: 21 })).toBe(15)
  })
  it('says nothing without a rhythm, and prefers out-of-office over hours', () => {
    const presence = { online: false, idle_minutes: null, last_seen: null }
    expect(
      reachSummary({ typical_hours_utc: null, is_out_of_office: false, ooo_end: null, presence }, null)
    ).toBeNull()
    const s = reachSummary(
      {
        typical_hours_utc: { start: 13, end: 21, samples: 40 },
        is_out_of_office: true,
        ooo_end: '2026-10-06T00:00:00Z',
        presence
      },
      { start: 13, end: 21 },
      new Date('2026-09-30T12:00:00Z')
    )
    expect(s?.when).toMatch(/^out until/)
    expect(s?.overlap).toBe(8)
  })
  it('says when they are usually back', () => {
    const s = reachSummary(
      {
        typical_hours_utc: { start: 13, end: 21, samples: 40 },
        is_out_of_office: false,
        ooo_end: null,
        presence: { online: false, idle_minutes: null, last_seen: null }
      },
      { start: 13, end: 21 },
      new Date('2026-09-30T11:00:00Z')
    )
    expect(s?.when).toBe('usually back in ~2h')
  })
})
