import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { agingOf } from '../../../services/user-profile.js'

// Army 11 a4: the team card divided BUSINESS hours by 24 ("oldest 14d" for a
// record 60 days in its step). Aging is calendar time in the step.
describe('agingOf', () => {
  const now = Date.parse('2026-11-08T20:20:00Z')
  it('counts calendar hours from the step entry, not the SLA elapsed', () => {
    const h = agingOf({ elapsed_hours: 343, entered_at: '2026-09-09T14:43:35Z' }, now)
    expect(h).toBeCloseTo(1445.6, 0)
  })
  it('falls back to the SLA elapsed only when no entry time is known', () => {
    expect(agingOf({ elapsed_hours: 12.34 }, now)).toBe(12.3)
    expect(agingOf(undefined, now)).toBeNull()
  })
})
