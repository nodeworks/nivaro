import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiRow = {
  id: 7,
  name: 'MWF',
  base_url: 'https://partner.example',
  auth_type: 'oauth2_cc',
  auth_config: JSON.stringify({
    token_url: 'https://sat.example/token',
    client_id: 'efp',
    client_secret: 's1'
  }),
  headers: null,
  enabled: true,
  retry_policy: null,
  mock_config: null,
  instance_overrides: null,
  redaction: null
}

vi.mock('../../../db/index.js', () => {
  const chain: any = {
    where: () => chain,
    whereIn: () => chain,
    andWhere: () => chain,
    orderBy: () => chain,
    select: () => chain,
    first: async () => apiRow,
    insert: async () => [],
    update: async () => 1,
    returning: async () => [],
    then: (res: (v: unknown) => unknown) => Promise.resolve([]).then(res),
    catch: () => Promise.resolve([])
  }
  const db: any = () => chain
  db.raw = async () => []
  db.schema = { hasTable: async () => true, hasColumn: async () => true }
  return { db }
})

const calls: Array<{ url: string; auth?: string }> = []
let tokenN = 0
let partner401Once = true
vi.mock('../../../lib/ssrf.js', () => ({
  fetchGuardedInCloud: vi.fn(async (url: string, init: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>
    calls.push({ url, auth: h.Authorization })
    if (url.includes('/token')) {
      tokenN++
      return new Response(JSON.stringify({ access_token: `tok${tokenN}`, expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    if (h.Authorization === 'Bearer tok1' && partner401Once) {
      partner401Once = false
      return new Response('{"error":"expired"}', {
        status: 401,
        headers: { 'content-type': 'application/json' }
      })
    }
    return new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  })
}))
vi.mock('../../../services/outbound-recorder.js', async (orig) => ({
  ...((await orig()) as object),
  recordSideCall: vi.fn(async () => {}),
  redactionFor: vi.fn(async () => ({})),
  outboundDetailFields: vi.fn(async () => ({})),
  mockRecordOn: vi.fn(() => false)
}))

const ext = await import('../../../services/external-apis.js')

describe('a kept token the partner refuses is replaced, never a failed call', () => {
  beforeEach(() => {
    calls.length = 0
    tokenN = 0
    partner401Once = true
    ext.clearOAuthTokenCache()
  })

  it('a kept token the partner refuses → one fresh token → the call succeeds', async () => {
    partner401Once = false
    const first = await ext.callExternalApi('MWF', { method: 'GET', path: '/a' } as never)
    expect(first.status).toBe(200) // tok1 fetched and kept
    partner401Once = true // the partner now refuses tok1 once (revoked / expired early)
    const second = await ext.callExternalApi('MWF', { method: 'GET', path: '/b' } as never)
    expect(second.status).toBe(200)
    const partnerCalls = calls.filter((c) => !c.url.includes('/token'))
    expect(partnerCalls.map((c) => c.auth)).toEqual(['Bearer tok1', 'Bearer tok1', 'Bearer tok2'])
    expect(tokenN).toBe(2)
  })

  it('a refused FRESH token is not retried (same as before caching) and is not kept', async () => {
    const r = await ext.callExternalApi('MWF', { method: 'GET', path: '/a' } as never)
    expect(r.status).toBe(401)
    partner401Once = false
    await ext.callExternalApi('MWF', { method: 'GET', path: '/b' } as never)
    expect(tokenN).toBe(2) // tok1 was dropped after its 401
  })

  it('OAUTH_TOKEN_CACHE=off fetches a token for every call', async () => {
    process.env.OAUTH_TOKEN_CACHE = 'off'
    try {
      partner401Once = false
      await ext.callExternalApi('MWF', { method: 'GET', path: '/a' } as never)
      await ext.callExternalApi('MWF', { method: 'GET', path: '/b' } as never)
      expect(tokenN).toBe(2)
    } finally {
      delete process.env.OAUTH_TOKEN_CACHE
    }
  })
})
