import { describe, expect, it } from 'vitest'
import { maskHeaders } from '../../../services/external-apis.js'

// Task 15e fix round 1, item 4 — `maskHeaders` used to only catch a hand-
// picked set of header names plus a few hardcoded `.includes(...)` substrings
// (secret/token/password/api-key/apikey). A partner-invented header carrying
// a credential under any OTHER name — `x-session-key`, `x-custom-auth` — rode
// straight through unmasked. The broadened match is a single regex against
// every header whose lowercased name even LOOKS like it might carry a
// credential: secret/token/password/passwd/key/cookie/auth/session/
// signature/credential — never the request/response BODY, only headers.
describe('maskHeaders — broadened sensitive-name match (Task 15e fix)', () => {
  it('masks a header invented outside the explicit known-name set', () => {
    expect(maskHeaders({ 'x-session-key': 'raw-session-key-value' })['x-session-key']).toBe(
      '••••••'
    )
    expect(maskHeaders({ 'x-custom-auth': 'raw-auth-value' })['x-custom-auth']).toBe('••••••')
  })

  it('still masks the previously-explicit names', () => {
    expect(maskHeaders({ 'set-cookie': 'sid=abc123' })['set-cookie']).toBe('••••••')
    expect(maskHeaders({ 'Proxy-Authorization': 'Basic xyz' })['Proxy-Authorization']).toBe(
      '••••••'
    )
  })

  it('never masks a harmless header', () => {
    const out = maskHeaders({
      'Content-Type': 'application/json',
      'content-length': '128',
      Accept: 'application/json',
      'x-request-id': 'req-1234'
    })
    expect(out['Content-Type']).toBe('application/json')
    expect(out['content-length']).toBe('128')
    expect(out.Accept).toBe('application/json')
    expect(out['x-request-id']).toBe('req-1234')
  })

  it('still splits an Authorization scheme from its token, and masks only the token half', () => {
    expect(maskHeaders({ Authorization: 'Bearer super-secret-token' }).Authorization).toBe(
      'Bearer ••••••'
    )
  })

  it('a header with no value is left as-is, never masked to a bare bullet string', () => {
    expect(maskHeaders({ 'x-session-key': '' })['x-session-key']).toBe('')
  })
})
