import { describe, expect, it } from 'vitest'
import {
  judgeSession,
  limitsFor,
  parseSessionPolicy,
  validateSessionPolicy
} from '../../../services/session-policy.js'

const ROLE = 'DCD96470-0000-0000-0000-000000000000'

describe('session policy', () => {
  it('role entry beats the default field by field', () => {
    const p = parseSessionPolicy({
      max_age_hours: 24,
      idle_minutes: 60,
      roles: { [ROLE.toLowerCase()]: { idle_minutes: 15 } }
    })
    expect(limitsFor(p, ROLE)).toEqual({ max_age_hours: 24, idle_minutes: 15 })
    expect(limitsFor(p, 'other')).toEqual({ max_age_hours: 24, idle_minutes: 60 })
    expect(limitsFor(null, ROLE)).toEqual({ max_age_hours: null, idle_minutes: null })
  })

  it('judges max age from loginAt and idle from lastSeenAt', () => {
    const now = 10 * 3_600_000
    const limits = { max_age_hours: 8, idle_minutes: 30 }
    expect(
      judgeSession(limits, { loginAt: now - 9 * 3_600_000, lastSeenAt: now - 1000 }, now)
    ).toEqual({ ok: false, reason: 'max_age' })
    expect(
      judgeSession(limits, { loginAt: now - 3_600_000, lastSeenAt: now - 31 * 60_000 }, now)
    ).toEqual({ ok: false, reason: 'idle' })
    expect(
      judgeSession(limits, { loginAt: now - 3_600_000, lastSeenAt: now - 60_000 }, now)
    ).toEqual({ ok: true })
  })

  it('a session without stamps is never expired', () => {
    expect(judgeSession({ max_age_hours: 1, idle_minutes: 1 }, {}, Date.now())).toEqual({
      ok: true
    })
  })

  it('validation refuses bad numbers and non-uuid role keys', () => {
    expect(validateSessionPolicy({ max_age_hours: 0 })).toMatch(/max_age_hours/)
    expect(validateSessionPolicy({ idle_minutes: 1.5 })).toMatch(/idle_minutes/)
    expect(validateSessionPolicy({ roles: { admin: { idle_minutes: 5 } } })).toMatch(
      /not a role id/
    )
    expect(
      validateSessionPolicy({ max_age_hours: 12, roles: { [ROLE]: { idle_minutes: 20 } } })
    ).toBeNull()
    expect(validateSessionPolicy(null)).toBeNull()
  })
})
