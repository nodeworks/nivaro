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

import { db } from '../../../db/index.js'
import { externalApisRoutes } from '../../../routes/external-apis.js'

const MASK = '••••••'

let row: Record<string, unknown>
let updates: Record<string, unknown>[]

function wireDb() {
  updates = []
  vi.mocked(db).mockImplementation(((table: string) => {
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
