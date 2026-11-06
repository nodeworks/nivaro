import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { metricCheckOutcome, ruleLastCheckedAt } from '../../../services/metric-alerts.js'

// Army 5 b11-N1: a rule that was never evaluated read "Within threshold".

const runs = new Map([
  [
    'metric-alerts-hourly',
    { started_at: '2026-11-06T17:05:00Z', finished_at: '2026-11-06T17:05:04Z' }
  ]
])

describe('ruleLastCheckedAt', () => {
  it('the newest completed run of the rule’s job, after its last save', () => {
    expect(
      ruleLastCheckedAt(
        { status: 'active', check_frequency: 'hourly', updated_at: '2026-11-06T16:00:00Z' },
        runs
      )
    ).toBe('2026-11-06T17:05:04.000Z')
  })
  it('null when the rule was saved after the last run, has no run, or is paused', () => {
    expect(
      ruleLastCheckedAt(
        { status: 'active', check_frequency: 'hourly', updated_at: '2026-11-06T17:30:00Z' },
        runs
      )
    ).toBeNull()
    expect(
      ruleLastCheckedAt({ status: 'active', check_frequency: 'daily', updated_at: null }, runs)
    ).toBeNull()
    expect(
      ruleLastCheckedAt({ status: 'paused', check_frequency: 'hourly', updated_at: null }, runs)
    ).toBeNull()
  })
  it('falls back to created_at when the rule was never edited', () => {
    expect(
      ruleLastCheckedAt(
        { status: 'active', check_frequency: 'hourly', created_at: '2026-11-06T18:00:00Z' },
        runs
      )
    ).toBeNull()
  })
})

describe('metricCheckOutcome', () => {
  it('reads as a job outcome', () => {
    expect(metricCheckOutcome({ checked: 3, fired: 1, resolved: 0, skipped: 0 })).toBe(
      'checked 3, fired 1, resolved 0, skipped 0'
    )
  })
})
