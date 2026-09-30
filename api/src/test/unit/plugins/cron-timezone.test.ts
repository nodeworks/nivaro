import { afterEach, describe, expect, it } from 'vitest'
import { CronManager } from '../../../plugins/cron.js'

const hourIn = (d: Date | null, tz: string) =>
  Number(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(
      d as Date
    )
  )

describe('cron schedules follow the instance time zone (#831)', () => {
  const m = new CronManager()
  afterEach(() => m.stopAll())

  it('evaluates a daily expression in the instance zone', () => {
    m.setInstanceTimezone('America/New_York')
    m.schedule('probe', '0 7 * * *', () => {})
    const e = m.list().find((j) => j.id === 'probe')!
    expect(e.timezone).toBe('America/New_York')
    expect(e.timezone_source).toBe('instance')
    expect(hourIn(e.nextRun, 'America/New_York')).toBe(7)
  })

  it('a job may pin itself, and an admin override beats both', () => {
    m.setInstanceTimezone('America/New_York')
    m.schedule('pinned', '0 7 * * *', () => {}, { timezone: 'UTC' })
    let e = m.list().find((j) => j.id === 'pinned')!
    expect([e.timezone, e.timezone_source]).toEqual(['UTC', 'job'])
    expect(hourIn(e.nextRun, 'UTC')).toBe(7)
    m.setTimezone('pinned', 'Europe/London')
    e = m.list().find((j) => j.id === 'pinned')!
    expect([e.timezone, e.timezone_source]).toEqual(['Europe/London', 'override'])
    expect(hourIn(e.nextRun, 'Europe/London')).toBe(7)
    m.setTimezone('pinned', null)
    expect(m.list().find((j) => j.id === 'pinned')!.timezone_source).toBe('job')
  })

  it('changing the instance zone re-creates jobs on the new clock', () => {
    m.setInstanceTimezone('America/New_York')
    m.schedule('moves', '30 2 * * *', () => {})
    m.setInstanceTimezone('Asia/Tokyo')
    const e = m.list().find((j) => j.id === 'moves')!
    expect(e.timezone).toBe('Asia/Tokyo')
    expect(hourIn(e.nextRun, 'Asia/Tokyo')).toBe(2)
  })

  it('refuses an unknown zone', () => {
    m.schedule('x', '0 1 * * *', () => {})
    expect(() => m.setTimezone('x', 'Mars/Olympus')).toThrow(/Unknown time zone/)
  })
})
