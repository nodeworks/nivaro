import { describe, expect, it, vi } from 'vitest'

// Hub people calls to the apps (services/hub/people/link-calls.ts): the bearer only in the
// header, no redirects, an answer read for its shape, a refusal as a short code. fetch injected.

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/hub/secrets.js', () => ({
  openSecret: (s: string | null) => (s ? `open:${s}` : null)
}))
vi.mock('../../../services/hub/shared/store.js', () => ({
  deploymentLinkBearer: (t: string) => `hmac(${t})`,
  getShared: vi.fn(),
  linkUrlOrigin: (u: string) => (u.startsWith('https://') ? new URL(u).origin : null),
  openSharedPrevToken: vi.fn(),
  openSharedToken: vi.fn(),
  tenantIdFor: (a: { key: string }, e: { id: number }) => `${a.key}-e${e.id}`
}))

const { callPeople } = await import('../../../services/hub/people/link-calls.js')

const ident = { emails: ['a@b.io'], entra: [] }
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('callPeople', () => {
  it('dedicated: posts to the hub link with the opened token, reads accounts', async () => {
    const fetch = vi.fn(async () =>
      json(200, {
        accounts: [{ user_id: 'u1', status: 'active', role: 'Staff', admin: false }]
      })
    )
    const r = await callPeople(
      { kind: 'dedicated', envId: 1, base_url: 'https://app.x.io/', token: 'sealed' },
      'lookup',
      ident,
      { fetch: fetch as never }
    )
    expect(r).toEqual({
      ok: true,
      accounts: [
        { user_id: 'u1', status: 'active', role: 'Staff', admin: false, matched_by: 'email' }
      ]
    })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://app.x.io/api/hub-link/people/lookup')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer open:sealed')
    expect(init.redirect).toBe('error')
    expect(JSON.parse(String(init.body))).toEqual(ident)
  })

  it('never sends the token over plain http to another host', async () => {
    const fetch = vi.fn()
    const r = await callPeople(
      { kind: 'dedicated', envId: 1, base_url: 'http://app.x.io', token: 'sealed' },
      'suspend',
      ident,
      { fetch: fetch as never }
    )
    expect(r).toEqual({ ok: false, code: 'BAD_BASE_URL', status: 0 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('passes the app’s own code on (LAST_ADMIN), maps 401 and a missing route', async () => {
    const t = { kind: 'dedicated' as const, envId: 1, base_url: 'https://a.io', token: 's' }
    const one = (status: number, body: unknown) =>
      callPeople(t, 'suspend', ident, { fetch: (async () => json(status, body)) as never })
    expect(await one(409, { code: 'LAST_ADMIN', message: 'text never passed on' })).toEqual({
      ok: false,
      code: 'LAST_ADMIN',
      status: 409
    })
    expect(await one(401, { code: 'HUB_LINK_REFUSED' })).toMatchObject({ code: 'LINK_REFUSED' })
    expect(await one(404, { message: 'Route not found' })).toMatchObject({ code: 'LINK_MISSING' })
    expect(await one(200, { state: 'weird', accounts: [] })).toMatchObject({
      code: 'LINK_BAD_ANSWER'
    })
    expect(await one(200, { state: 'suspended', accounts: [] })).toEqual({
      ok: true,
      state: 'suspended',
      accounts: []
    })
  })

  it('a hung app answers TIMEOUT within the bound', async () => {
    const fetch = vi.fn(
      (_u: string, init: RequestInit) =>
        new Promise((_res, rej) =>
          init.signal?.addEventListener('abort', () => rej(new Error('aborted')))
        )
    )
    const r = await callPeople(
      { kind: 'dedicated', envId: 1, base_url: 'https://a.io', token: 's' },
      'lookup',
      ident,
      { fetch: fetch as never, timeoutMs: 30 }
    )
    expect(r).toEqual({ ok: false, code: 'TIMEOUT', status: 0 })
  })

  it('shared: the deployment link for the app, HMAC bearer, previous token on a 401', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(401, { code: 'DEPLOYMENT_LINK_REFUSED' }))
      .mockResolvedValueOnce(json(200, { accounts: [] }))
    const r = await callPeople(
      { kind: 'shared', envId: 4, sharedId: 2, link_url: 'https://dep.x.io', tenantId: 'efp-e4' },
      'lookup',
      ident,
      {
        fetch: fetch as never,
        sharedTokens: async () => ({ current: 'new', previous: 'old' })
      }
    )
    expect(r).toEqual({ ok: true, accounts: [] })
    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>
    expect(calls[0][0]).toBe('https://dep.x.io/api/hub-deployment/apps/efp-e4/people/lookup')
    expect((calls[0][1].headers as Record<string, string>).Authorization).toBe('Bearer hmac(new)')
    expect((calls[1][1].headers as Record<string, string>).Authorization).toBe('Bearer hmac(old)')
  })
})
