import { beforeEach, describe, expect, it, vi } from 'vitest'

let issued = 0
const fetchMock = vi.fn(async () => {
  issued++
  return new Response(JSON.stringify({ access_token: `tok${issued}`, expires_in: 3600 }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
})
vi.mock('../../../lib/ssrf.js', () => ({ fetchGuardedInCloud: fetchMock }))
vi.mock('../../../services/outbound-recorder.js', () => ({ recordSideCall: vi.fn() }))

const { resolveAuth, forgetOAuthToken, clearOAuthTokenCache } = await import(
  '../../../services/external-apis.js'
)

const cfg = { token_url: 'https://sat.example/token', client_id: 'efp', client_secret: 's1' }

describe('oauth2_cc token reuse', () => {
  beforeEach(() => {
    issued = 0
    fetchMock.mockClear()
    clearOAuthTokenCache()
  })

  it('reuses a token until it nears expiry instead of fetching per call', async () => {
    const a = await resolveAuth('oauth2_cc', cfg)
    const b = await resolveAuth('oauth2_cc', cfg)
    expect(a.headers.Authorization).toBe('Bearer tok1')
    expect(b.headers.Authorization).toBe('Bearer tok1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a health probe always fetches fresh', async () => {
    await resolveAuth('oauth2_cc', cfg)
    await resolveAuth('oauth2_cc', cfg, { apiId: 1, kind: 'token_probe' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a partner 401 drops the kept token', async () => {
    await resolveAuth('oauth2_cc', cfg)
    forgetOAuthToken(cfg)
    const c = await resolveAuth('oauth2_cc', cfg)
    expect(c.headers.Authorization).toBe('Bearer tok2')
  })

  it('a changed secret never reuses the old token', async () => {
    await resolveAuth('oauth2_cc', cfg)
    const d = await resolveAuth('oauth2_cc', { ...cfg, client_secret: 's2' })
    expect(d.headers.Authorization).toBe('Bearer tok2')
  })

  it('a token without expires_in is not kept', async () => {
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ access_token: 'noexp' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    )
    await resolveAuth('oauth2_cc', cfg)
    await resolveAuth('oauth2_cc', cfg)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
