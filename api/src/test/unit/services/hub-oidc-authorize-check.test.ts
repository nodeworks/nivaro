import { describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 7: the pure authorize-request check. Order matters: the client and its
// redirect_uri are judged first and answer a PAGE (never a redirect); only after both are known
// good do the other errors go back to the app as a redirect (RFC 6749 §4.1.2.1).

vi.mock('../../../db/index.js', () => ({ db: {} }))

const { checkAuthorizeRequest } = await import('../../../services/hub/oidc/authorize-check.js')
type Client = import('../../../services/hub/oidc/clients.js').HubOidcClient

const CB = 'https://app.example.com/api/auth/callback'
const client: Client = {
  id: 1,
  environment_id: 1,
  app_id: 1,
  app_signin_mode: 'hub',
  env_key: 'production',
  env_status: 'active',
  client_id: `hubc_${'a'.repeat(24)}`,
  active: true,
  redirect_uris: [CB, 'https://app2.example.com/api/auth/callback'],
  post_logout_uris: ['https://app.example.com/login'],
  secret_sealed: 'x'
}
const good = {
  client_id: client.client_id,
  redirect_uri: CB,
  response_type: 'code',
  scope: 'openid email profile',
  state: 'st-1',
  nonce: 'n-1',
  code_challenge: 'c'.repeat(43),
  code_challenge_method: 'S256'
}

describe('checkAuthorizeRequest', () => {
  it('accepts a well-formed request', () => {
    const r = checkAuthorizeRequest(good, client)
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.p).toMatchObject({ client_id: client.client_id, nonce: 'n-1', state: 'st-1' })
  })

  it('unknown client → page, never a redirect', () => {
    const r = checkAuthorizeRequest(good, null)
    expect(r).toMatchObject({ ok: false, redirect: false })
    const other = checkAuthorizeRequest({ ...good, client_id: `hubc_${'b'.repeat(24)}` }, client)
    expect(other).toMatchObject({ ok: false, redirect: false })
  })

  it.each([
    ['missing', undefined],
    ['traversal', `${CB}/../x`],
    ['suffix', `${CB}.evil`],
    ['other host', 'https://app.example.com.evil.com/api/auth/callback'],
    ['prefix host', 'https://evil.app.example.com/api/auth/callback'],
    ['other port', 'https://app.example.com:8443/api/auth/callback'],
    ['trailing slash', `${CB}/`],
    ['trailing path', `${CB}/more`],
    ['query', `${CB}?x=1`],
    ['fragment', `${CB}#x`],
    ['http of an https host', 'http://app.example.com/api/auth/callback'],
    ['path case', 'https://app.example.com/API/auth/callback'],
    ['host case', 'https://APP.example.com/api/auth/callback'],
    ['userinfo', 'https://evil@app.example.com/api/auth/callback'],
    ['encoded slash', 'https://app.example.com/api%2Fauth/callback'],
    ['encoded char', 'https://app.example.com/api/auth/c%61llback'],
    ['explicit default port', 'https://app.example.com:443/api/auth/callback'],
    ['whitespace', ` ${CB}`],
    ['array (repeated parameter)', [CB, CB]]
  ])('redirect_uri near-miss (%s) → page', (_why, uri) => {
    const r = checkAuthorizeRequest({ ...good, redirect_uri: uri as never }, client)
    expect(r).toMatchObject({ ok: false, redirect: false })
  })

  it('a repeated client_id → page', () => {
    const r = checkAuthorizeRequest(
      { ...good, client_id: [good.client_id, good.client_id] },
      client
    )
    expect(r).toMatchObject({ ok: false, redirect: false })
  })

  it('response_type other than code → unsupported_response_type (redirect, state kept)', () => {
    const r = checkAuthorizeRequest({ ...good, response_type: 'token' }, client)
    expect(r).toMatchObject({ ok: false, redirect: true, error: 'unsupported_response_type' })
    if (!r.ok && r.redirect) expect(r.p.state).toBe('st-1')
  })

  it('scope without openid → invalid_scope', () => {
    expect(checkAuthorizeRequest({ ...good, scope: 'email profile' }, client)).toMatchObject({
      ok: false,
      redirect: true,
      error: 'invalid_scope'
    })
    expect(checkAuthorizeRequest({ ...good, scope: 'openidx' }, client)).toMatchObject({
      error: 'invalid_scope'
    })
  })

  it.each([
    ['method missing', { code_challenge_method: undefined }],
    ['plain', { code_challenge_method: 'plain' }],
    ['lowercase s256', { code_challenge_method: 's256' }],
    ['challenge missing', { code_challenge: undefined }],
    ['challenge short', { code_challenge: 'c'.repeat(42) }],
    ['challenge long', { code_challenge: 'c'.repeat(44) }],
    ['challenge not base64url', { code_challenge: `${'c'.repeat(42)}=` }]
  ])('PKCE %s → invalid_request', (_why, patch) => {
    const r = checkAuthorizeRequest({ ...good, ...patch }, client)
    expect(r).toMatchObject({ ok: false, redirect: true, error: 'invalid_request' })
    if (!r.ok && r.redirect) expect(r.p.state).toBe('st-1')
  })

  it('state and nonce are required and bounded', () => {
    for (const patch of [
      { state: undefined },
      { state: 's'.repeat(513) },
      { nonce: undefined },
      { nonce: 'n'.repeat(257) }
    ])
      expect(checkAuthorizeRequest({ ...good, ...patch }, client)).toMatchObject({
        ok: false,
        redirect: true,
        error: 'invalid_request'
      })
    expect(checkAuthorizeRequest({ ...good, state: 's'.repeat(512) }, client).ok).toBe(true)
    expect(checkAuthorizeRequest({ ...good, nonce: 'n'.repeat(256) }, client).ok).toBe(true)
  })

  it('an over-long state is never echoed back', () => {
    const r = checkAuthorizeRequest({ ...good, state: 's'.repeat(513) }, client)
    if (!r.ok && r.redirect) expect(r.p.state).toBe('')
  })

  it('a client that cannot be used → unauthorized_client', () => {
    for (const patch of [
      { active: false },
      { app_signin_mode: 'direct' as const },
      { env_status: 'archived' },
      { env_status: 'suspended' }
    ])
      expect(checkAuthorizeRequest(good, { ...client, ...patch })).toMatchObject({
        ok: false,
        redirect: true,
        error: 'unauthorized_client'
      })
  })

  it('page errors come before redirectable ones', () => {
    const r = checkAuthorizeRequest(
      { ...good, redirect_uri: `${CB}x`, response_type: 'token' },
      { ...client, active: false }
    )
    expect(r).toMatchObject({ ok: false, redirect: false })
  })
})
