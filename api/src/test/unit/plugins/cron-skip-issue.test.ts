import { describe, expect, it } from 'vitest'
import { SKIP_ISSUE_MS, skipWorthAnIssue } from '../../../plugins/cron.js'

describe('skipWorthAnIssue', () => {
  const now = 1_000_000_000
  it('stays quiet for a tick held a few seconds (lock wait)', () => {
    expect(skipWorthAnIssue(now - 30_000, now)).toBe(false)
  })
  it('stays quiet when the start is unknown', () => {
    expect(skipWorthAnIssue(undefined, now)).toBe(false)
  })
  it('raises once the previous tick has run for minutes', () => {
    expect(skipWorthAnIssue(now - SKIP_ISSUE_MS, now)).toBe(true)
  })
  it('a short watchdog budget lowers the bar', () => {
    expect(skipWorthAnIssue(now - 90_000, now, 60_000)).toBe(true)
  })
})
