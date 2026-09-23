import { describe, expect, it } from 'vitest'
import { failureStreak, isAuthFailure } from '../../../services/integration-signals-core.js'

describe('failureStreak', () => {
  it('counts consecutive failures from the newest call and flags auth', () => {
    expect(
      failureStreak([
        { ok: false, status: 401, error: null },
        { ok: false, status: 500, error: null },
        { ok: true, status: 200, error: null },
        { ok: false, status: 500, error: null }
      ])
    ).toEqual({ streak: 2, auth: true })
  })
  it('is zero when the newest call succeeded', () => {
    expect(failureStreak([{ ok: true, status: 200, error: null }])).toEqual({ streak: 0, auth: false })
  })
})

describe('isAuthFailure', () => {
  it('reads 401/403 and token-exchange errors', () => {
    expect(isAuthFailure(401, null)).toBe(true)
    expect(isAuthFailure(403, null)).toBe(true)
    expect(isAuthFailure(null, 'Token exchange failed (HTTP 401): invalid_client')).toBe(true)
    expect(isAuthFailure(500, 'boom')).toBe(false)
  })
})
