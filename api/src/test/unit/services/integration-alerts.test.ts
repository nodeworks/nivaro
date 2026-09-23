import { describe, expect, it } from 'vitest'
import { shouldNotify } from '../../../services/integration-alerts.js'

const now = new Date('2026-09-22T12:00:00Z')
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000)

describe('shouldNotify', () => {
  it('alerts on an unmet outcome nobody has been told about', () => {
    expect(shouldNotify({ outcome: 'missing', notified_at: null }, now, 12)).toBe(true)
    expect(shouldNotify({ outcome: 'failed', notified_at: null }, now, 12)).toBe(true)
    expect(shouldNotify({ outcome: 'overdue', notified_at: null }, now, 12)).toBe(true)
  })

  it('never alerts on a met outcome', () => {
    expect(shouldNotify({ outcome: 'sent', notified_at: null }, now, 12)).toBe(false)
    expect(shouldNotify({ outcome: 'pending', notified_at: null }, now, 12)).toBe(false)
    expect(shouldNotify({ outcome: 'skipped', notified_at: null }, now, 12)).toBe(false)
    expect(shouldNotify({ outcome: 'superseded', notified_at: null }, now, 12)).toBe(false)
  })

  it('stays quiet inside the dedupe window — a sweep every 15 minutes must not alert every 15 minutes', () => {
    expect(shouldNotify({ outcome: 'missing', notified_at: hoursAgo(1) }, now, 12)).toBe(false)
  })

  it('speaks again once the window has passed', () => {
    expect(shouldNotify({ outcome: 'missing', notified_at: hoursAgo(13) }, now, 12)).toBe(true)
  })

  it('treats the boundary as passed rather than holding a row silent forever', () => {
    expect(shouldNotify({ outcome: 'missing', notified_at: hoursAgo(12) }, now, 12)).toBe(true)
  })
})
