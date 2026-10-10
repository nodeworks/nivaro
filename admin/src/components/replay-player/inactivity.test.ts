import { describe, expect, it } from 'vitest'
import {
  findInactiveGaps,
  fmtSkip,
  gapAt,
  isActivityEvent,
  SKIP_SPEED,
  SKIP_TAIL_MS,
  skipDecision,
  skippedTotal
} from './inactivity'

const T0 = 1_700_000_000_000
const meta = (t: number) => ({ type: 4, timestamp: T0 + t })
const full = (t: number) => ({ type: 2, timestamp: T0 + t })
const mutation = (t: number) => ({ type: 3, timestamp: T0 + t, data: { source: 0 } })
const click = (t: number) => ({ type: 3, timestamp: T0 + t, data: { source: 2 } })
const canvas = (t: number) => ({ type: 3, timestamp: T0 + t, data: { source: 9 } })
const consoleLine = (t: number) => ({ type: 5, timestamp: T0 + t, data: { tag: 'console' } })

describe('isActivityEvent', () => {
  it('counts snapshots, mutations and input — not canvas churn or custom events', () => {
    expect(isActivityEvent(meta(0))).toBe(true)
    expect(isActivityEvent(full(0))).toBe(true)
    expect(isActivityEvent(mutation(0))).toBe(true)
    expect(isActivityEvent(click(0))).toBe(true)
    expect(isActivityEvent(canvas(0))).toBe(false)
    expect(isActivityEvent(consoleLine(0))).toBe(false)
    expect(isActivityEvent(null)).toBe(false)
  })
})

describe('findInactiveGaps', () => {
  it('finds stretches over 5 s with no input or mutation', () => {
    const gaps = findInactiveGaps(
      [
        meta(0),
        full(10),
        click(2_000),
        // 2m 10s with only a console line and canvas churn
        consoleLine(30_000),
        canvas(60_000),
        mutation(132_000),
        click(135_000), // 3 s — not a gap
        click(141_000) // 6 s — a gap
      ],
      T0
    )
    expect(gaps).toEqual([
      { start: 2_000, end: 132_000 },
      { start: 135_000, end: 141_000 }
    ])
  })

  it('a gap of exactly the threshold is not skipped', () => {
    expect(findInactiveGaps([meta(0), click(5_000)], T0)).toEqual([])
  })

  it('a quiet tail up to the last event is a gap', () => {
    expect(findInactiveGaps([meta(0), click(1_000), consoleLine(20_000)], T0)).toEqual([
      { start: 1_000, end: 20_000 }
    ])
  })

  it('sorts activity that arrives out of order', () => {
    expect(findInactiveGaps([meta(0), click(12_000), mutation(1_000)], T0)).toEqual([
      { start: 1_000, end: 12_000 }
    ])
  })

  it('returns nothing without activity', () => {
    expect(findInactiveGaps([consoleLine(0), consoleLine(60_000)], T0)).toEqual([])
    expect(findInactiveGaps([], T0)).toEqual([])
  })
})

describe('gapAt / skipDecision', () => {
  const gaps = [
    { start: 2_000, end: 12_000 },
    { start: 20_000, end: 200_000 }
  ]

  it('finds the gap under the playhead, and lets go just before its end', () => {
    expect(gapAt(gaps, 1_000)).toBeNull()
    expect(gapAt(gaps, 2_000)).toBe(gaps[0])
    expect(gapAt(gaps, 11_000)).toBe(gaps[0])
    expect(gapAt(gaps, 11_900)).toBeNull()
    expect(gapAt(gaps, 15_000)).toBeNull()
    expect(gapAt(gaps, 150_000)).toBe(gaps[1])
  })

  it('plays a short gap at 8×', () => {
    expect(skipDecision(gaps, 5_000, 1, true)).toEqual({
      gap: gaps[0],
      speed: SKIP_SPEED,
      seekTo: null
    })
  })

  it('jumps over a long gap to just before it ends', () => {
    expect(skipDecision(gaps, 21_000, 2, true)).toEqual({
      gap: gaps[1],
      speed: SKIP_SPEED,
      seekTo: 200_000 - SKIP_TAIL_MS
    })
    // …and plays the tail at 8× once there.
    expect(skipDecision(gaps, 198_000, 2, true).seekTo).toBeNull()
  })

  it('keeps the chosen speed outside gaps, and real time when skipping is off', () => {
    expect(skipDecision(gaps, 15_000, 2, true)).toEqual({ gap: null, speed: 2, seekTo: null })
    expect(skipDecision(gaps, 5_000, 1, false)).toEqual({ gap: null, speed: 1, seekTo: null })
  })
})

describe('labels', () => {
  it('formats skipped durations', () => {
    expect(fmtSkip(130_000)).toBe('2m 10s')
    expect(fmtSkip(45_400)).toBe('45s')
    expect(fmtSkip(3_780_000)).toBe('1h 3m')
    expect(fmtSkip(-5)).toBe('0s')
  })

  it('totals the skipped time', () => {
    expect(
      skippedTotal([
        { start: 0, end: 10_000 },
        { start: 20_000, end: 26_000 }
      ])
    ).toBe(16_000)
  })
})
