import { describe, expect, it } from 'vitest'
import { businessVerdict, fmtSpan, recentVsEarlier } from './logic'

const series = (key: string, label: string, points: number[]) => ({
  key,
  label,
  points,
  total: points.reduce((a, b) => a + b, 0)
})
// 15 minutes; the last point is the minute in progress
const steady = [100, 98, 102, 99, 101, 100, 97, 103, 100, 99, 101, 100, 98, 100, 40]
const flat = [2, 2, 3, 2, 2, 3, 2, 2, 2, 3, 2, 0, 0, 0, 0]

describe('business verdict (#2189)', () => {
  it('flags a business drop while the API looks normal', () => {
    const v = businessVerdict(steady, [series('approvals', 'Approvals decided', flat)])
    expect(v.kind).toBe('business-drop')
    expect(v.drops).toEqual(['approvals'])
    expect(v.text).toMatch(/Approvals decided dropped to 0\/min from 2\.\d\/min/)
  })
  it('says both are down when the API fell too', () => {
    const quietTech = [100, 98, 102, 99, 101, 100, 97, 103, 100, 99, 101, 10, 8, 9, 5]
    const v = businessVerdict(quietTech, [series('approvals', 'Approvals decided', flat)])
    expect(v.kind).toBe('both-quiet')
  })
  it('stays silent when nothing fell, or the series was never busy', () => {
    expect(businessVerdict(steady, [series('a', 'A', steady)]).kind).toBe('ok')
    expect(businessVerdict(steady, [series('a', 'A', new Array(15).fill(0))]).kind).toBe('ok')
  })
  it('ignores a series whose source is unavailable and short series', () => {
    expect(businessVerdict(steady, [{ ...series('a', 'A', flat), unavailable: true }]).kind).toBe(
      'ok'
    )
    expect(recentVsEarlier([1, 2, 3])).toBeNull()
  })
})

describe('fmtSpan', () => {
  it('reads in the largest sensible unit', () => {
    expect(fmtSpan(40_000)).toBe('40 s')
    expect(fmtSpan(14 * 60_000)).toBe('14 min')
    expect(fmtSpan((3 * 60 + 20) * 60_000)).toBe('3 h 20 min')
    expect(fmtSpan(2 * 3600_000)).toBe('2 h')
  })
})
