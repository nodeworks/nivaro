import { describe, expect, it } from 'vitest'
import { enumerateBuckets } from '@/lib/buckets'

describe('enumerateBuckets', () => {
  it('days: inclusive range', () => {
    expect(enumerateBuckets('2026-01-30', '2026-02-02', 'day')).toEqual([
      '2026-01-30',
      '2026-01-31',
      '2026-02-01',
      '2026-02-02'
    ])
  })
  it('weeks: Monday starts covering the range', () => {
    // 2026-01-01 is a Thursday → its week starts Monday 2025-12-29
    expect(enumerateBuckets('2026-01-01', '2026-01-14', 'week')).toEqual([
      '2025-12-29',
      '2026-01-05',
      '2026-01-12'
    ])
  })
  it('months: first-of-month starts', () => {
    expect(enumerateBuckets('2026-01-15', '2026-03-02', 'month')).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01'
    ])
  })
})
