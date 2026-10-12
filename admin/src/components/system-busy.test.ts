import { describe, expect, it } from 'vitest'
import { busyEstimate, busyText } from './system-busy'

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
