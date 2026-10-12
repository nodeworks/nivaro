import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  measureClockOffset,
  serverClockOffset,
  serverNow,
  setServerClockOffset
} from './server-clock'
import { formatRelative } from './utils'

afterEach(() => {
  setServerClockOffset(0)
  vi.useRealTimers()
})

describe('measureClockOffset (#2132)', () => {
  it('takes the midpoint of the shortest round trip', () => {
    const offset = measureClockOffset([
      { sent: 1000, server: 61_200, received: 1400 }, // rtt 400
      { sent: 2000, server: 62_050, received: 2100 } // rtt 100 → midpoint 2050
    ])
    expect(offset).toBe(60_000)
  })
  it('ignores unusable samples and answers null with none left', () => {
    expect(measureClockOffset([{ sent: 10, server: 5, received: 5 }])).toBeNull()
    expect(measureClockOffset([])).toBeNull()
  })
})

describe('serverNow', () => {
  it('applies a real offset and ignores sub-second jitter', () => {
    setServerClockOffset(400)
    expect(serverClockOffset()).toBe(0)
    setServerClockOffset(-120_000)
    expect(serverClockOffset()).toBe(-120_000)
    expect(Math.abs(serverNow() - (Date.now() - 120_000))).toBeLessThan(50)
  })
  it('makes "just now" true on a machine whose clock runs ahead', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-12T12:05:00Z')) // this clock is 5 minutes fast
    const writtenAt = '2026-10-12T12:00:00Z' // the server's "now"
    expect(formatRelative(writtenAt)).toBe('5m ago')
    setServerClockOffset(-5 * 60_000)
    expect(formatRelative(writtenAt)).toBe('just now')
  })
})
