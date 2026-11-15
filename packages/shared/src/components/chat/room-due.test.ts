import { describe, expect, it } from 'vitest'
import { dueInText } from '../../lib/deadline-ticker'
import { dueStatus, dueText } from './room-due'

// The record room chip must say the SAME thing as the record's SLA banner: calendar time to
// the clock's due instant. Design review round 2: a business-hours clock 96 working hours late
// read "4d overdue" in the chip (remaining_hours / 24) while the banner said 17 days.

const HOUR = 3_600_000
const NOW = Date.parse('2026-11-15T12:00:00Z')

describe('record room chip due text', () => {
  it('counts to the due instant like the banner, never working hours / 24', () => {
    const sla = {
      // 17 d 14 h of calendar time past the due instant…
      due_at: new Date(NOW - (17 * 24 + 14) * HOUR).toISOString(),
      warning_at: new Date(NOW - 18 * 24 * HOUR).toISOString(),
      // …while the business-hours clock is "only" 96 working hours over.
      remaining_hours: -96,
      business_hours: true
    }
    expect(dueText(sla, NOW)).toBe('Overdue by 17 d 14 h')
    // Exactly the banner's words (deadline-ticker dueInText), capitalised.
    expect(dueText(sla, NOW)?.toLowerCase()).toBe(dueInText(sla, NOW))
    expect(dueText(sla, NOW)).not.toContain('4d')
    expect(dueStatus(sla, NOW)).toBe('breached')
  })

  it('says when a running clock is due and turns amber at its own line', () => {
    const sla = {
      due_at: new Date(NOW + 2 * HOUR + 5 * 60_000).toISOString(),
      warning_at: new Date(NOW - HOUR).toISOString()
    }
    expect(dueText(sla, NOW)).toBe('Due in 2 h 5 m')
    expect(dueStatus(sla, NOW)).toBe('warning')
  })

  it('says nothing without a due instant (an older API, a clock with no rule)', () => {
    expect(dueText(null, NOW)).toBeNull()
    expect(dueText({ due_at: null }, NOW)).toBeNull()
    expect(dueStatus({}, NOW)).toBeNull()
  })
})
