import { describe, expect, it } from 'vitest'
import {
  appOfOrigin,
  browserKey,
  classifyCallbackFailure,
  classifyMissingState,
  decodeFailureComment,
  describeAgent,
  encodeFailureComment,
  hasSessionCookie,
  isKnownBrowser,
  pickIdentityMatch,
  reasonFromLegacyRow,
  SIGN_IN_REASONS,
  shortErrorCode
} from './sign-in-reasons.js'

describe('classifyCallbackFailure', () => {
  it('maps Microsoft AADSTS codes from the error description', () => {
    const c = (d: string) =>
      classifyCallbackFailure({ idpError: 'access_denied', idpDescription: d })
    expect(c('AADSTS50057: The user account is disabled.')).toEqual({
      reason: 'directory_disabled',
      code: 'AADSTS50057'
    })
    expect(c('AADSTS50020: User account from identity provider does not exist')).toMatchObject({
      reason: 'wrong_tenant'
    })
    expect(c('AADSTS90072: not in tenant')).toMatchObject({ reason: 'wrong_tenant' })
    expect(c('AADSTS50105: not assigned to a role')).toMatchObject({ reason: 'not_assigned' })
    expect(c('AADSTS50076: due to a configuration change')).toMatchObject({ reason: 'mfa' })
    expect(c('AADSTS53003: Access has been blocked by Conditional Access')).toMatchObject({
      reason: 'conditional_access'
    })
    expect(c('AADSTS50053: locked')).toMatchObject({ reason: 'locked' })
    expect(c('AADSTS700016: application not found')).toMatchObject({
      reason: 'app_misconfigured'
    })
    expect(c('AADSTS70008: code expired')).toMatchObject({ reason: 'code_expired' })
  })

  it('keeps an unknown AADSTS code under idp_refused', () => {
    expect(
      classifyCallbackFailure({ idpError: 'access_denied', idpDescription: 'AADSTS99999 odd' })
    ).toEqual({ reason: 'idp_refused', code: 'AADSTS99999' })
  })

  it('reads the AADSTS code off a thrown token-exchange error too', () => {
    const err = Object.assign(new Error('server responded with an error'), {
      error: 'invalid_grant',
      error_description: 'AADSTS54005: OAuth2 Authorization code was already redeemed'
    })
    expect(classifyCallbackFailure({ err })).toEqual({
      reason: 'code_expired',
      code: 'AADSTS54005'
    })
  })

  it('maps plain OAuth error words', () => {
    expect(classifyCallbackFailure({ idpError: 'invalid_grant' }).reason).toBe('code_expired')
    expect(classifyCallbackFailure({ idpError: 'consent_required' }).reason).toBe('consent')
    expect(classifyCallbackFailure({ idpError: 'interaction_required' }).reason).toBe('mfa')
    expect(classifyCallbackFailure({ idpError: 'temporarily_unavailable' }).reason).toBe(
      'provider_unavailable'
    )
    expect(classifyCallbackFailure({ idpError: 'invalid_client' }).reason).toBe('app_misconfigured')
    expect(classifyCallbackFailure({ idpError: 'access_denied' })).toEqual({
      reason: 'idp_refused',
      code: 'access_denied'
    })
  })

  it('unreachable beats everything else', () => {
    expect(
      classifyCallbackFailure({ idpDescription: 'AADSTS50057', unreachable: true }).reason
    ).toBe('provider_unavailable')
  })

  it('reads a state mismatch as a stale sign-in, anything else as auth_failed', () => {
    expect(
      classifyCallbackFailure({ err: new Error('unexpected "state" response parameter value') })
        .reason
    ).toBe('session_state')
    expect(classifyCallbackFailure({ err: new Error('boom') })).toEqual({
      reason: 'auth_failed',
      code: null
    })
  })
})

describe('missing state', () => {
  it('no cookie = the browser dropped it; a cookie = a stale sign-in', () => {
    expect(classifyMissingState(false)).toBe('cookie_blocked')
    expect(classifyMissingState(true)).toBe('session_state')
  })
  it('finds the session cookie by name only', () => {
    expect(hasSessionCookie('a=1; nivaro_session=abc', 'nivaro_session')).toBe(true)
    expect(hasSessionCookie('nivaro_session_x=1', 'nivaro_session')).toBe(false)
    expect(hasSessionCookie(undefined, 'nivaro_session')).toBe(false)
  })
})

describe('legacy rows', () => {
  it('reads the older login-refused sentences', () => {
    expect(
      reasonFromLegacyRow('login-refused', "Sign-in is turned off for this account's role (oidc)")
    ).toBe('sign_in_disabled')
    expect(reasonFromLegacyRow('login-refused', 'Account is not active (saml)')).toBe('suspended')
    expect(
      reasonFromLegacyRow(
        'login-refused',
        'This email belongs to an account linked to a different sign-in. Ask an administrator.'
      )
    ).toBe('account_link')
    expect(reasonFromLegacyRow('login-refused', null)).toBe('auth_failed')
    expect(reasonFromLegacyRow('device-revoked', 'Nivaro on iPhone: sign-in expired')).toBe(
      'device_ended'
    )
  })
})

describe('failure comment', () => {
  it('round-trips and never keeps free text as a code', () => {
    const raw = encodeFailureComment({
      reason: 'directory_disabled',
      method: 'oidc',
      app: 'admin',
      code: 'AADSTS50057: User account pat@example.com is disabled. Trace ID: x'
    })
    expect(raw).not.toContain('pat@example.com')
    expect(decodeFailureComment(raw)).toEqual({
      reason: 'directory_disabled',
      method: 'oidc',
      app: 'admin',
      code: 'AADSTS50057'
    })
  })
  it('an unreadable or unknown reason reads as auth_failed', () => {
    expect(decodeFailureComment('not json').reason).toBe('auth_failed')
    expect(decodeFailureComment('{"reason":"nope"}').reason).toBe('auth_failed')
  })
  it('short codes: AADSTS or one OAuth word, never a sentence', () => {
    expect(shortErrorCode('access_denied')).toBe('access_denied')
    expect(shortErrorCode('The user typed pat@example.com')).toBeNull()
  })
})

describe('every reason has words', () => {
  it('label, explanation and a what-to-do', () => {
    for (const [k, r] of Object.entries(SIGN_IN_REASONS)) {
      expect(r.label, k).toBeTruthy()
      expect(r.explain, k).toBeTruthy()
      expect(r.todo, k).toBeTruthy()
    }
  })
})

describe('appOfOrigin', () => {
  const allowed = ['http://admin.test', 'https://portal.example.com']
  it('admin, another allowed app by host, or nothing', () => {
    expect(appOfOrigin('http://admin.test/collections', 'http://admin.test', allowed)).toBe('admin')
    expect(appOfOrigin('https://portal.example.com/x', 'http://admin.test', allowed)).toBe(
      'portal.example.com'
    )
    expect(appOfOrigin('https://evil.test/', 'http://admin.test', allowed)).toBeNull()
    expect(appOfOrigin(null, 'http://admin.test', allowed)).toBeNull()
    expect(appOfOrigin('not a url', 'http://admin.test', allowed)).toBeNull()
  })
})

describe('matching an attempt to a person', () => {
  const rows = [
    { id: 'A', external_id: 'sub-a', entra_oid: null, email: 'pat@example.com' },
    { id: 'B', external_id: 'sub-b', entra_oid: 'OID-B', email: 'sam@example.com' }
  ]
  it('subject first, then Microsoft id, then email (case-insensitive)', () => {
    expect(pickIdentityMatch(rows, { sub: 'sub-b', email: 'pat@example.com' })).toEqual({
      id: 'B',
      by: 'subject'
    })
    expect(pickIdentityMatch(rows, { sub: 'other', oid: 'oid-b' })).toEqual({
      id: 'B',
      by: 'microsoft_id'
    })
    expect(pickIdentityMatch(rows, { sub: 'other', email: 'PAT@Example.com ' })).toEqual({
      id: 'A',
      by: 'email'
    })
    expect(pickIdentityMatch(rows, { sub: 'other', email: 'nobody@example.com' })).toBeNull()
    expect(pickIdentityMatch(rows, {})).toBeNull()
  })

  it('an unnamed attempt is "probably them" only on the same address AND browser', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Edg/120'
    const known = new Set([browserKey('10.0.0.5', ua) as string])
    expect(isKnownBrowser(known, '10.0.0.5', ua)).toBe(true)
    expect(isKnownBrowser(known, '10.0.0.5', 'Mozilla/5.0 (Macintosh) Safari/605')).toBe(false)
    expect(isKnownBrowser(known, '10.0.0.6', ua)).toBe(false)
    expect(isKnownBrowser(known, '', '')).toBe(false)
    expect(browserKey('', ua)).toBeNull()
  })
})

describe('describeAgent', () => {
  it('names common browsers', () => {
    expect(describeAgent('Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537 Edg/120')).toBe(
      'Edge on Windows'
    )
    expect(
      describeAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit Version/17 Safari/604')
    ).toBe('Safari on iPhone')
    expect(describeAgent(null)).toBeNull()
  })
})
