import { describe, expect, it } from 'vitest'
import {
  parseSloTargets,
  percentileFromHistogram,
  validateSloTargets
} from '../../../services/slo.js'

describe('SLO helpers (#666)', () => {
  it('reads the p95 upper edge from a histogram', () => {
    const b = [
      { upper: 25, n: 90 },
      { upper: 100, n: 5 },
      { upper: 5000, n: 5 }
    ]
    expect(percentileFromHistogram(b, 0.95)).toBe(100)
    expect(percentileFromHistogram(b, 0.9)).toBe(25)
    expect(percentileFromHistogram(b, 0.99)).toBe(5000)
    expect(percentileFromHistogram([], 0.95)).toBeNull()
  })
  it('targets default and clamp', () => {
    expect(parseSloTargets(null)).toEqual({ availability_pct: 99.5, p95_ms: 2000, window_days: 7 })
    expect(parseSloTargets('{"availability_pct":99.9,"window_days":30}').window_days).toBe(7)
    expect(validateSloTargets({ availability_pct: 100 })).toMatch(/availability_pct/)
    expect(validateSloTargets({ availability_pct: 99.9, p95_ms: 800 })).toBeNull()
  })
})
