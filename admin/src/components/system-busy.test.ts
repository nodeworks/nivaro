import { describe, expect, it } from 'vitest'
import { busyEstimate, busyEventMatters, busyPollMs, busyText } from './system-busy'

const item = (over: Record<string, unknown> = {}) => ({
  id: 1,
  kind: 'cron',
  label: 'nightly reforecast',
  elapsed_ms: 0,
  expected_ms: null,
  remaining_ms: null,
  overrun: false,
  ...over
})

describe('system busy text', () => {
  it('names the job and the time left', () => {
    expect(busyText([item({ remaining_ms: 12 * 60_000, expected_ms: 20 * 60_000 })])).toBe(
      'System busy: nightly reforecast running, about 12 minutes left'
    )
  })

  it('says only "running" when there is no history to estimate from', () => {
    expect(busyText([item()])).toBe('System busy: nightly reforecast running')
  })

  it('counts the others and flags an overrun', () => {
    expect(
      busyText([item({ overrun: true, remaining_ms: 0 }), item({ id: 2 }), item({ id: 3 })])
    ).toBe('System busy: nightly reforecast and 2 more running, taking longer than usual')
  })

  it('rounds up small remainders and switches to hours for long ones', () => {
    expect(busyEstimate({ remaining_ms: 20_000, overrun: false })).toBe('less than a minute left')
    expect(busyEstimate({ remaining_ms: 3 * 3_600_000, overrun: false })).toBe('about 3 hours left')
  })
})

describe('which job events refresh the pill', () => {
  it('a light cron tick starting or finishing does not', () => {
    const tick = { id: 7, kind: 'cron', job_id: 'staged-imports', status: 'running' }
    expect(busyEventMatters(tick, [])).toBe(false)
    expect(busyEventMatters({ ...tick, status: 'completed' }, [3])).toBe(false)
  })

  it('a run the server marks busy does, when it starts and when it ends', () => {
    expect(busyEventMatters({ id: 9, status: 'running', busy: true }, [])).toBe(true)
    expect(busyEventMatters({ id: 9, status: 'completed', busy: true }, [9])).toBe(true)
  })

  it('progress never does: it changes nothing about what is running', () => {
    expect(busyEventMatters({ id: 9, busy: true, progress: { done: 1 } }, [9])).toBe(false)
  })

  it('a run already on the pill ending refreshes it even without the flag', () => {
    expect(busyEventMatters({ id: 9, status: 'completed' }, [9])).toBe(true)
    expect(busyEventMatters(null, [9])).toBe(false)
  })
})

describe('the backstop poll', () => {
  it('is a minute or slower while the socket carries the job events', () => {
    expect(busyPollMs(true, true)).toBeGreaterThanOrEqual(60_000)
    expect(busyPollMs(true, false)).toBeGreaterThanOrEqual(60_000)
  })

  it('is never faster than 30 seconds without the socket', () => {
    expect(busyPollMs(false, true)).toBeGreaterThanOrEqual(30_000)
    expect(busyPollMs(false, undefined)).toBeGreaterThanOrEqual(30_000)
  })
})
