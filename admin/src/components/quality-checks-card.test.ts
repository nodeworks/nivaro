import { describe, expect, it } from 'vitest'
import { isStaleVerifying, pickTarget, RUN_ID_SHAPE } from './quality-checks-card'

describe('quality card helpers', () => {
  it('picks the asked target in any case, else the newest', () => {
    expect(pickTarget(['Mirror_DB', 'Old_DB'], 'mirror_db')).toBe('Mirror_DB')
    expect(pickTarget(['Mirror_DB', 'Old_DB'], 'nope')).toBe('Mirror_DB')
    expect(pickTarget(['Mirror_DB'], null)).toBe('Mirror_DB')
    expect(pickTarget([], 'x')).toBeNull()
  })
  it('accepts only a uuid as a run id', () => {
    expect(RUN_ID_SHAPE.test('11111111-2222-3333-4444-555555555555')).toBe(true)
    expect(RUN_ID_SHAPE.test('11111111-2222-3333-4444-555555555555/../../users')).toBe(false)
    expect(RUN_ID_SHAPE.test('x')).toBe(false)
  })
  it('calls a run stale after two hours of verifying', () => {
    const now = Date.parse('2026-10-06T12:00:00Z')
    const run = {
      status: 'verifying' as const,
      started_at: '2026-10-05T00:00:00Z',
      captured_at: '2026-10-05T00:10:00Z',
      verify_started_at: '2026-10-06T11:00:00Z'
    }
    expect(isStaleVerifying(run, now)).toBe(false)
    expect(isStaleVerifying({ ...run, verify_started_at: '2026-10-06T09:00:00Z' }, now)).toBe(true)
    expect(isStaleVerifying({ ...run, verify_started_at: null }, now)).toBe(true)
    expect(isStaleVerifying({ ...run, status: 'done' }, now)).toBe(false)
  })
})
