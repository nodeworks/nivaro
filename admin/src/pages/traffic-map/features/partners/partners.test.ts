import { describe, expect, it } from 'vitest'
import {
  breachText,
  type DriftReport,
  driftHeadline,
  type HourPoint,
  starShare,
  stripScale
} from './logic'

const hour = (p95: number | null): HourPoint => ({
  t: '2026-10-17T10:00:00.000Z',
  req: p95 ? 5 : 0,
  p95,
  avail_pct: 100,
  breach: null,
  judged: !!p95
})

describe('partner lens logic', () => {
  it('scales the strip so the target sits below the top and clamps bars', () => {
    const { heights, targetAt } = stripScale([hour(300), hour(1500), hour(null)], 600)
    expect(targetAt).toBeCloseTo(600 / 1500, 5)
    expect(heights[1]).toBe(1)
    expect(heights[0]).toBeCloseTo(0.2, 5)
    expect(heights[2]).toBe(0)
    expect(stripScale([hour(50)], null).targetAt).toBeNull()
  })

  it('words breaches and drift', () => {
    expect(breachText('both')).toContain('response time')
    expect(breachText(null)).toBe('inside what was agreed')
    const base: DriftReport = {
      status: 'drifting',
      bodies: 40,
      needed: 20,
      recent_bodies: 8,
      new_fields: [{ path: 'a', recent: 3, baseline_pct: 0 }],
      missing_fields: [],
      type_changes: [{ path: 'b', recent: 3, baseline_pct: 90, from: 'string', to: 'number' }]
    }
    expect(driftHeadline(base)).toBe('Drifting — 1 new, 1 changed type')
    expect(driftHeadline({ ...base, status: 'learning', bodies: 4 })).toContain('4 of 20')
    expect(driftHeadline({ ...base, status: 'steady' })).toBe('Steady across 40 bodies')
  })

  it('computes the share of star reads', () => {
    expect(starShare({ reads: 8, star_reads: 2 })).toBe(25)
    expect(starShare({ reads: 0, star_reads: 0 })).toBe(0)
  })
})
