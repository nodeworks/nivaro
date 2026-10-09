import { describe, expect, it } from 'vitest'
import { ACTIVITY_LIMITS, normalizeActivity } from '../../../services/help-video-walk.js'

describe('normalizeActivity', () => {
  it('keeps null as null (capture was off)', () => {
    expect(normalizeActivity(null)).toBeNull()
    expect(normalizeActivity(undefined)).toBeNull()
    expect(normalizeActivity('nope')).toBeNull()
  })
  it('drops unknown kinds, broken spans and short ones; clamps and rounds', () => {
    expect(
      normalizeActivity([
        { kind: 'typing', start_ms: 1000.4, end_ms: 3000.6 },
        { kind: 'keys', start_ms: 0, end_ms: 9000 },
        { kind: 'idle', start_ms: 'x', end_ms: 9000 },
        { kind: 'idle', start_ms: 5000, end_ms: 5200 },
        { kind: 'idle', start_ms: -50, end_ms: 4000, text: 'secret' },
        null,
        7
      ])
    ).toEqual([
      { kind: 'idle', start_ms: 0, end_ms: 4000 },
      { kind: 'typing', start_ms: 1000, end_ms: 3001 }
    ])
  })
  it('merges overlapping spans of one kind and sorts them', () => {
    expect(
      normalizeActivity([
        { kind: 'typing', start_ms: 6000, end_ms: 8000 },
        { kind: 'typing', start_ms: 1000, end_ms: 3000 },
        { kind: 'typing', start_ms: 2500, end_ms: 4000 }
      ])
    ).toEqual([
      { kind: 'typing', start_ms: 1000, end_ms: 4000 },
      { kind: 'typing', start_ms: 6000, end_ms: 8000 }
    ])
  })
  it('caps the list', () => {
    const many = Array.from({ length: ACTIVITY_LIMITS.spans + 50 }, (_, i) => ({
      kind: 'idle',
      start_ms: i * 1000,
      end_ms: i * 1000 + 600
    }))
    expect(normalizeActivity(many)).toHaveLength(ACTIVITY_LIMITS.spans)
  })
})
