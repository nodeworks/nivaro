import { describe, expect, it } from 'vitest'
import {
  KNOWN_PLACEHOLDER_SECRETS,
  resolveCookieSecure,
  sessionSecretProblem
} from '../../../auth/secret-policy.js'

// Security audit H4/H5/M13: the API never boots on a session secret anyone can read, and a
// deployment served over https gets Secure session cookies without anyone remembering to.

describe('sessionSecretProblem', () => {
  it('refuses a missing, blank or short secret', () => {
    expect(sessionSecretProblem(undefined)).toMatch(/not set/)
    expect(sessionSecretProblem('   ')).toMatch(/not set/)
    expect(sessionSecretProblem('a1b2c3d4e5f6')).toMatch(/at least 32/)
  })

  it('refuses the example-file placeholder and the old cloud default', () => {
    expect(KNOWN_PLACEHOLDER_SECRETS.size).toBeGreaterThanOrEqual(2)
    for (const p of KNOWN_PLACEHOLDER_SECRETS)
      expect(sessionSecretProblem(p)).toMatch(/placeholder/)
    expect(sessionSecretProblem('change_this_to_a_long_random_string_minimum_32_chars')).not.toBe(
      null
    )
    expect(sessionSecretProblem('cloud-mode-session-secret-placeholder-32ch')).not.toBe(null)
  })

  it('refuses a repetitive value that is long enough', () => {
    expect(sessionSecretProblem('x'.repeat(64))).toMatch(/not random/)
    expect(sessionSecretProblem('abababababababababababababababab')).toMatch(/not random/)
  })

  it('accepts a generated secret', () => {
    expect(
      sessionSecretProblem('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08')
    ).toBe(null)
  })
})

describe('resolveCookieSecure', () => {
  it('an explicit COOKIE_SECURE wins either way', () => {
    expect(resolveCookieSecure({ COOKIE_SECURE: 'false', PUBLIC_URL: 'https://a.test' })).toBe(
      false
    )
    expect(resolveCookieSecure({ COOKIE_SECURE: 'true', PUBLIC_URL: 'http://localhost' })).toBe(
      true
    )
  })

  it('unset: on for an https public or admin URL, off for plain http', () => {
    expect(resolveCookieSecure({ PUBLIC_URL: 'https://nivaro.example.com' })).toBe(true)
    expect(
      resolveCookieSecure({ PUBLIC_URL: 'http://localhost:3055', ADMIN_URL: 'https://admin.test' })
    ).toBe(true)
    expect(
      resolveCookieSecure({
        PUBLIC_URL: 'http://localhost:3055',
        ADMIN_URL: 'http://localhost:3056'
      })
    ).toBe(false)
    expect(resolveCookieSecure({ COOKIE_SECURE: '' })).toBe(false)
  })
})
