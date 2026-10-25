import { afterEach, describe, expect, it } from 'vitest'
import { CronManager } from '../../../plugins/cron.js'

// Sunday 2026-10-25, 2:55 PM in New York.
const SUNDAY = new Date('2026-10-25T18:55:00Z')

describe('expectedPreviousRun (#81 miss detector)', () => {
  const m = new CronManager()
  afterEach(() => m.stopAll())

  it('a weekday job expected Friday, not on the Sunday it never fires', () => {
    m.setInstanceTimezone('America/New_York')
    m.schedule('weekday', '30 6 * * 1-5', () => {})
    expect(m.expectedPreviousRun('weekday', SUNDAY)?.toISOString()).toBe('2026-10-23T10:30:00.000Z')
  })

  it('an irregular daily schedule reads its real last slot', () => {
    m.schedule('twice', '0 9,17 * * *', () => {}, { timezone: 'UTC' })
    expect(m.expectedPreviousRun('twice', SUNDAY)?.toISOString()).toBe('2026-10-25T17:00:00.000Z')
  })

  it('a regular schedule is unchanged', () => {
    m.schedule('hourly', '35 * * * *', () => {}, { timezone: 'UTC' })
    expect(m.expectedPreviousRun('hourly', SUNDAY)?.toISOString()).toBe('2026-10-25T18:35:00.000Z')
  })

  it('unknown job is null', () => {
    expect(m.expectedPreviousRun('nope', SUNDAY)).toBeNull()
  })
})
