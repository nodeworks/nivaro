import { describe, expect, it } from 'vitest'
import { extractTransitions, type LegacySnap } from '../../../services/legacy-history.js'

const snap = (revId: number, state: number | null, ts: string, activityId = revId): LegacySnap => ({
  revId,
  activityId,
  timestamp: ts,
  state
})

describe('extractTransitions', () => {
  it('emits initial state with null from', () => {
    expect(extractTransitions([snap(1, 10, '2020-01-01T00:00:00Z')])).toEqual([
      { fromLegacyState: null, toLegacyState: 10, activityId: 1 }
    ])
  })

  it('emits one row per consecutive state change and skips no-ops', () => {
    const out = extractTransitions([
      snap(1, 10, '2020-01-01T00:00:00Z'),
      snap(2, 10, '2020-01-02T00:00:00Z'),
      snap(3, 20, '2020-01-03T00:00:00Z'),
      snap(4, 20, '2020-01-04T00:00:00Z'),
      snap(5, 10, '2020-01-05T00:00:00Z')
    ])
    expect(out).toEqual([
      { fromLegacyState: null, toLegacyState: 10, activityId: 1 },
      { fromLegacyState: 10, toLegacyState: 20, activityId: 3 },
      { fromLegacyState: 20, toLegacyState: 10, activityId: 5 }
    ])
  })

  it('null-state snaps carry the previous state forward (no fabricated transitions)', () => {
    const out = extractTransitions([
      snap(1, 10, '2020-01-01T00:00:00Z'),
      snap(2, null, '2020-01-02T00:00:00Z'),
      snap(3, 10, '2020-01-03T00:00:00Z'),
      snap(4, null, '2020-01-04T00:00:00Z'),
      snap(5, 20, '2020-01-05T00:00:00Z')
    ])
    expect(out).toEqual([
      { fromLegacyState: null, toLegacyState: 10, activityId: 1 },
      { fromLegacyState: 10, toLegacyState: 20, activityId: 5 }
    ])
  })

  it('orders by timestamp then revId (revId breaks ties)', () => {
    const out = extractTransitions([
      snap(2, 20, '2020-01-01T00:00:00Z'),
      snap(1, 10, '2020-01-01T00:00:00Z')
    ])
    expect(out).toEqual([
      { fromLegacyState: null, toLegacyState: 10, activityId: 1 },
      { fromLegacyState: 10, toLegacyState: 20, activityId: 2 }
    ])
  })

  it('returns empty for empty or all-null input', () => {
    expect(extractTransitions([])).toEqual([])
    expect(extractTransitions([snap(1, null, '2020-01-01T00:00:00Z')])).toEqual([])
  })
})
