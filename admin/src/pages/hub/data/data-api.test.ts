import { describe, expect, it } from 'vitest'
import { ago, backupAge, fmtMs } from './data-api'

// The Data tab's plain-word helpers: how long ago, how fresh a backup is, how long a step took.

describe('data tab words', () => {
  const now = Date.parse('2026-11-24T12:00:00Z')
  it('says how long ago', () => {
    expect(ago(null, now)).toBe('never')
    expect(ago('2026-11-24T11:59:30Z', now)).toBe('just now')
    expect(ago('2026-11-24T11:15:00Z', now)).toBe('45 min ago')
    expect(ago('2026-11-24T02:00:00Z', now)).toBe('10 h ago')
    expect(ago('2026-11-20T12:00:00Z', now)).toBe('4 days ago')
  })

  it('rates a backup’s age', () => {
    expect(backupAge(null, now)).toBe('none')
    expect(backupAge('2026-11-24T00:00:00Z', now)).toBe('fresh')
    expect(backupAge('2026-11-22T12:00:00Z', now)).toBe('late')
    expect(backupAge('2026-11-01T00:00:00Z', now)).toBe('stale')
  })

  it('formats durations', () => {
    expect(fmtMs(null)).toBe('—')
    expect(fmtMs(250)).toBe('250 ms')
    expect(fmtMs(42_000)).toBe('42 s')
    expect(fmtMs(600_000)).toBe('10 min')
  })
})
