import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same harness as external-apis-logs.test.ts: admin gate + db mocked, the route's own masking
// and merging run for real.
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: vi.fn(async (req: { user?: { id: string }; isAdmin?: boolean }) => {
    req.user = { id: 'test-admin' }
    req.isAdmin = true
  }),
  authenticate: vi.fn(async (req: { user?: { id: string }; isAdmin?: boolean }) => {
    req.user = { id: 'test-admin' }
    req.isAdmin = true
  })
}))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/outbound-recorder.js', () => ({
  bustRedactionCache: vi.fn(),
  redactionFor: vi.fn(async () => ({ headers: [], body_paths: [] })),
  recordSideCall: vi.fn(async () => {}),
  mockRecordOn: vi.fn(() => false),
  outboundDetailFields: vi.fn(async () => ({})),
  recordMockAnswer: vi.fn(async () => {})
}))
vi.mock('../../../services/chain-columns.js', () => ({ chainFields: vi.fn(async () => ({})) }))

import { db } from '../../../db/index.js'
import { externalApisRoutes } from '../../../routes/external-apis.js'

const MASK = '••••••'

let row: Record<string, unknown>
let updates: Record<string, unknown>[]
let logInserts: Record<string, unknown>[]

function wireDb() {
  updates = []
  logInserts = []
  vi.mocked(db).mockImplementation(((table: string) => {
    if (table === 'nivaro_external_api_logs') {
      return {
        insert: vi.fn(async (r: Record<string, unknown>) => {
          logInserts.push(r)
          return [1]
        })
      }
    }
    if (table !== 'nivaro_external_apis') throw new Error(`unexpected table: ${table}`)
    const chain: Record<string, unknown> = {}
    chain.where = vi.fn(() => chain)
    chain.first = vi.fn(async () => row)
    chain.update = vi.fn(async (patch: Record<string, unknown>) => {
      updates.push(patch)
      row = { ...row, ...patch }
      return 1
    })
    return chain
  }) as never)
}

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(externalApisRoutes)
  return app
}

beforeEach(() => {
  row = {
    id: 3,
    name: 'MWF',
    base_url: 'https://mwf.example',
    auth_type: 'none',
    auth_config: JSON.stringify({ body_secrets: { token: 'S3CRET-TOKEN', site: 'SITE-KEY' } }),
    headers: null,
    enabled: true,
    instance_overrides: JSON.stringify({
      production: { auth_config: { body_secrets: { token: 'PROD-TOKEN' } } }
    })
  }
  wireDb()
})
afterEach(() => vi.clearAllMocks())

describe('external API body secrets — read masking', () => {
  it('GET masks body_secrets values', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/3' })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.auth_config.body_secrets).toEqual({ token: MASK, site: MASK })
    expect(d.instance_overrides.production.auth_config.body_secrets).toEqual({ token: MASK })
    expect(res.body).not.toContain('S3CRET-TOKEN')
    expect(res.body).not.toContain('SITE-KEY')
    expect(res.body).not.toContain('PROD-TOKEN')
    await app.close()
  })

  it('an Authorization header in an instance override is masked on GET', async () => {
    row.instance_overrides = JSON.stringify({
      production: { headers: { Authorization: 'Bearer RAW-PROD', Accept: 'application/json' } }
    })
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/3' })
    expect(res.json().data.instance_overrides.production.headers).toEqual({
      Authorization: MASK,
      Accept: 'application/json'
    })
    expect(res.body).not.toContain('RAW-PROD')
    await app.close()
  })

  it('the list masks them too', async () => {
    vi.mocked(db).mockImplementation((() => ({
      orderBy: vi.fn(async () => [row])
    })) as never)
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.json().data[0].auth_config.body_secrets).toEqual({ token: MASK, site: MASK })
    expect(res.body).not.toContain('S3CRET-TOKEN')
    await app.close()
  })
})

describe('external API body secrets — PATCH', () => {
  it('PATCH lets a bad name be removed (null / empty / masked echo) but not set', async () => {
    const app = buildApp()
    for (const v of [null, '', MASK]) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/3',
        payload: { auth_config: { body_secrets: { 'old name': v } } }
      })
      expect(res.statusCode).toBe(200)
    }
    const bad = await app.inject({
      method: 'PATCH',
      url: '/3',
      payload: {
        instance_overrides: { production: { auth_config: { body_secrets: { 'a b': 'x' } } } }
      }
    })
    expect(bad.statusCode).toBe(400)
    await app.close()
  })
  it('POST refuses a body secret name outside letters, digits, - and _', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/',
      payload: {
        name: 'X',
        base_url: 'https://x.test',
        auth_config: { body_secrets: { 'a b': 'x' } }
      }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('Secret names use letters, digits, - and _')
    await app.close()
  })

  it('PATCH refuses a body secret name outside letters, digits, - and _', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'PATCH',
      url: '/3',
      payload: { auth_config: { body_secrets: { 'bad name': 'x' } } }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('Secret names use letters, digits, - and _')
    expect(updates).toHaveLength(0)
    await app.close()
  })

  it('PATCH with masked value keeps the stored secret', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'PATCH',
      url: '/3',
      payload: { auth_config: { body_secrets: { token: MASK, site: 'NEW-SITE' } } }
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(String(updates[0].auth_config))).toEqual({
      body_secrets: { token: 'S3CRET-TOKEN', site: 'NEW-SITE' }
    })
    expect(res.json().data.auth_config.body_secrets).toEqual({ token: MASK, site: MASK })
    await app.close()
  })

  it('a name absent from the PATCH is removed', async () => {
    const app = buildApp()
    await app.inject({
      method: 'PATCH',
      url: '/3',
      payload: { auth_config: { body_secrets: { token: MASK } } }
    })
    expect(JSON.parse(String(updates[0].auth_config))).toEqual({
      body_secrets: { token: 'S3CRET-TOKEN' }
    })
    await app.close()
  })

  it('a masked value for a name that never existed is not stored as the mask', async () => {
    const app = buildApp()
    await app.inject({
      method: 'PATCH',
      url: '/3',
      payload: { auth_config: { body_secrets: { token: MASK, brand_new: MASK } } }
    })
    const saved = JSON.parse(String(updates[0].auth_config))
    expect(saved.body_secrets).toEqual({ token: 'S3CRET-TOKEN' })
    await app.close()
  })

  it('auth_config null (auth type none) or a config without body_secrets keeps them', async () => {
    const app = buildApp()
    await app.inject({ method: 'PATCH', url: '/3', payload: { auth_config: null } })
    expect(JSON.parse(String(updates[0].auth_config))).toEqual({
      body_secrets: { token: 'S3CRET-TOKEN', site: 'SITE-KEY' }
    })
    await app.inject({
      method: 'PATCH',
      url: '/3',
      payload: { auth_type: 'bearer', auth_config: { token: 'abc' } }
    })
    expect(JSON.parse(String(updates[1].auth_config))).toEqual({
      token: 'abc',
      body_secrets: { token: 'S3CRET-TOKEN', site: 'SITE-KEY' }
    })
    await app.close()
  })

  it("a name set to null or '' is removed; only non-empty strings are stored", async () => {
    const app = buildApp()
    await app.inject({
      method: 'PATCH',
      url: '/3',
      payload: { auth_config: { body_secrets: { token: null, site: '', n: 5, keep: 'K' } } }
    })
    expect(JSON.parse(String(updates[0].auth_config))).toEqual({ body_secrets: { keep: 'K' } })
    await app.close()
  })

  it('body_secrets null or {} clears them', async () => {
    const app = buildApp()
    await app.inject({
      method: 'PATCH',
      url: '/3',
      payload: { auth_config: { client_id: 'c', body_secrets: {} } }
    })
    expect(JSON.parse(String(updates[0].auth_config))).toEqual({ client_id: 'c' })
    await app.close()
  })

  it('instance override: a flattened body_secrets string never replaces the stored map', async () => {
    const app = buildApp()
    await app.inject({
      method: 'PATCH',
      url: '/3',
      payload: {
        instance_overrides: { production: { auth_config: { body_secrets: MASK } } }
      }
    })
    expect(JSON.parse(String(updates[0].instance_overrides))).toEqual({
      production: { auth_config: { body_secrets: { token: 'PROD-TOKEN' } } }
    })
    await app.close()
  })

  it('instance override: a masked body secret keeps the stored per-instance value', async () => {
    const app = buildApp()
    await app.inject({
      method: 'PATCH',
      url: '/3',
      payload: {
        instance_overrides: {
          production: { auth_config: { body_secrets: { token: MASK, extra: 'X' } } }
        }
      }
    })
    expect(JSON.parse(String(updates[0].instance_overrides))).toEqual({
      production: { auth_config: { body_secrets: { token: 'PROD-TOKEN', extra: 'X' } } }
    })
    await app.close()
  })
})

describe('POST /:id/test — body secrets', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('substitutes on the wire, logs the placeholder, scrubs an echo from log and response', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('{"echo":"S3CRET-TOKEN"}', {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-echo': 'S3CRET-TOKEN' }
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/3/test',
      payload: { method: 'POST', path: '/s', body: { t: '⟦nvr-secret:token⟧' } }
    })
    expect(res.statusCode).toBe(200)
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(JSON.parse(String(init.body))).toEqual({ t: 'S3CRET-TOKEN' })
    expect(res.body).not.toContain('S3CRET-TOKEN')
    expect(res.json().data.body).toEqual({ echo: '⟦nvr-secret:token⟧' })
    expect(String(logInserts[0].request_body)).toContain('⟦nvr-secret:token⟧')
    expect(JSON.stringify(logInserts[0])).not.toContain('S3CRET-TOKEN')
    await app.close()
  })

  it('an unknown body secret answers 400 and sends nothing', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/3/test',
      payload: { method: 'POST', path: '/s', body: { t: '⟦nvr-secret:nope⟧' } }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe("MWF API has no body secret 'nope'")
    expect(fetchMock).not.toHaveBeenCalled()
    await app.close()
  })
})
