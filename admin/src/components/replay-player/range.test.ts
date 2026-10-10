import { describe, expect, it } from 'vitest'
import { dragRange, expiresIn, fmtSpan, MIN_RANGE_MS, moveEdge, msAtX, usableRange } from './range'

describe('replay range helpers (#1366)', () => {
  it('maps a pointer x to ms, clamped to the track', () => {
    expect(msAtX(150, 100, 200, 60_000)).toBe(15_000)
    expect(msAtX(50, 100, 200, 60_000)).toBe(0)
    expect(msAtX(400, 100, 200, 60_000)).toBe(60_000)
    expect(msAtX(150, 100, 0, 60_000)).toBe(0)
  })

  it('orders a drag either way', () => {
    expect(dragRange(5_000, 9_000)).toEqual([5_000, 9_000])
    expect(dragRange(9_000, 5_000)).toEqual([5_000, 9_000])
  })

  it('moves one edge, keeping the range in bounds and at least the minimum', () => {
    expect(moveEdge([10_000, 20_000], 'start', 12_000, 60_000)).toEqual([12_000, 20_000])
    expect(moveEdge([10_000, 20_000], 'end', 30_000, 60_000)).toEqual([10_000, 30_000])
    // Past the other end: the other end gives way.
    expect(moveEdge([10_000, 20_000], 'start', 25_000, 60_000)).toEqual([25_000, 26_000])
    expect(moveEdge([10_000, 20_000], 'end', 5_000, 60_000)).toEqual([4_000, 5_000])
    // At the edges of the recording.
    expect(moveEdge([10_000, 20_000], 'start', -5, 60_000)).toEqual([0, 20_000])
    expect(moveEdge([10_000, 20_000], 'end', 99_000, 60_000)).toEqual([10_000, 60_000])
    expect(moveEdge([59_500, 60_000], 'start', 60_000, 60_000)).toEqual([59_000, 60_000])
  })

  it('knows a usable range and formats a span', () => {
    expect(usableRange(null)).toBe(false)
    expect(usableRange([0, MIN_RANGE_MS - 1])).toBe(false)
    expect(usableRange([0, MIN_RANGE_MS])).toBe(true)
    expect(fmtSpan(28_000)).toBe('28 s')
    expect(fmtSpan(125_000)).toBe('2 m 05 s')
  })

  it('says when a share link expires (#1362)', () => {
    const now = Date.parse('2026-10-10T12:00:00Z')
    expect(expiresIn('2026-10-10T12:20:00Z', now)).toBe('in 20 minutes')
    expect(expiresIn('2026-10-10T13:00:00Z', now)).toBe('in 1 hour')
    expect(expiresIn('2026-10-11T12:00:00Z', now)).toBe('in 24 hours')
    expect(expiresIn('2026-10-13T12:00:00Z', now)).toBe('in 3 days')
    expect(expiresIn('2026-10-10T11:00:00Z', now)).toBe('expired')
  })
})
