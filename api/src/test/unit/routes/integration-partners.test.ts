import { describe, expect, it } from 'vitest'
import { healthWord, hourBuckets, percentile } from '../../../routes/integration-partners.js'

describe('percentile', () => {
  it('nearest-rank on a sorted list', () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20)
    expect(percentile([10, 20, 30, 40], 95)).toBe(40)
    expect(percentile([], 50)).toBeNull()
  })
})

describe('healthWord', () => {
  const t = (m: number) => new Date(Date.now() - m * 60_000)
  it('healthy needs a success after the last failure', () => {
    expect(
      healthWord({
        calls24: 10,
        failures24: 1,
        lastOkAt: t(1),
        lastFailAt: t(5),
        authFailing: false
      })
    ).toBe('healthy')
    expect(
      healthWord({
        calls24: 10,
        failures24: 1,
        lastOkAt: t(5),
        lastFailAt: t(1),
        authFailing: false
      })
    ).toBe('failing')
  })
  it('degraded when failures are frequent but it still lands; idle with no calls; auth wins', () => {
    expect(
      healthWord({
        calls24: 10,
        failures24: 4,
        lastOkAt: t(1),
        lastFailAt: t(2),
        authFailing: false
      })
    ).toBe('degraded')
    expect(
      healthWord({
        calls24: 0,
        failures24: 0,
        lastOkAt: null,
        lastFailAt: null,
        authFailing: false
      })
    ).toBe('idle')
    expect(
      healthWord({ calls24: 5, failures24: 1, lastOkAt: t(1), lastFailAt: t(2), authFailing: true })
    ).toBe('failing')
  })
})

describe('hourBuckets', () => {
  it('fills every hour, oldest first', () => {
    const now = new Date('2026-09-23T12:30:00Z')
    const b = hourBuckets(
      [
        { created_at: new Date('2026-09-23T12:05:00Z'), ok: true },
        { created_at: new Date('2026-09-23T11:10:00Z'), ok: false }
      ],
      now,
      3
    )
    expect(b.map((x) => [x.hour, x.ok, x.failed])).toEqual([
      ['2026-09-23T10', 0, 0],
      ['2026-09-23T11', 0, 1],
      ['2026-09-23T12', 1, 0]
    ])
  })
})
