import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: vi.fn(async () => {})
}))

const registered: Array<{ id: string }> = []
vi.mock('../../../services/readiness.js', () => ({
  registerReadinessCheck: vi.fn((c: { id: string }) => registered.push(c))
}))

const dep = {
  key: 'key:7',
  kind: 'api_key',
  label: 'Warehouse feed',
  partner: true,
  account_kind: null,
  calls: 12,
  last_seen: '2026-09-29T10:00:00.000Z',
  collections: [
    {
      collection: 'orders',
      read: [{ field: 'id' }],
      written: [{ field: 'total' }]
    }
  ],
  operations: [],
  endpoints: [{ method: 'GET', path: '/api/items/orders' }]
}

vi.mock('../../../services/partner-dependencies.js', () => ({
  dependencyMap: vi.fn(async () => ({
    days: 14,
    generated_at: 'now',
    truncated: false,
    callers: [dep]
  })),
  callerDependencies: vi.fn(async (key: string) => (key === 'key:7' ? dep : null)),
  openApiSubset: vi.fn(async () => ({ openapi: '3.1.0', paths: { '/items/orders': {} } })),
  graphqlSdlSubset: vi.fn(async () => 'type Query {\n}\n'),
  callersUsingField: vi.fn(async () => [{ key: 'key:7', label: 'Warehouse feed' }]),
  checkDependencies: vi.fn(async () => ({
    findings: [
      { severity: 'break', message: 'Warehouse feed writes orders.total, which no longer exists' }
    ],
    callers: 1,
    fields: 2,
    days: 14
  }))
}))

import { partnerDependencyRoutes } from '../../../routes/partner-dependencies.js'

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(partnerDependencyRoutes, { prefix: '/partner-dependencies' })
  return app
}

describe('partner dependency routes', () => {
  it('lists callers summarised', async () => {
    const res = await buildApp().inject({ method: 'GET', url: '/partner-dependencies?days=7' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data[0]).toMatchObject({ key: 'key:7', collections: 1, fields: 2, endpoints: 1 })
  })

  it('serves one caller, 404 for an unknown one', async () => {
    const app = buildApp()
    expect((await app.inject({ url: '/partner-dependencies/key%3A7' })).statusCode).toBe(200)
    expect((await app.inject({ url: '/partner-dependencies/key%3A99' })).statusCode).toBe(404)
  })

  it('wraps exports as {filename, content} and downloads them as files', async () => {
    const app = buildApp()
    const wrapped = (await app.inject({ url: '/partner-dependencies/key%3A7/openapi.json' })).json()
    expect(wrapped.data.filename).toBe('Warehouse-feed.openapi.json')
    expect(JSON.parse(wrapped.data.content).openapi).toBe('3.1.0')
    const file = await app.inject({
      url: '/partner-dependencies/key%3A7/schema.graphql?download=1'
    })
    expect(file.headers['content-disposition']).toContain('Warehouse-feed.graphql')
    expect(file.body).toContain('type Query')
  })

  it('answers the check and the per-field callers', async () => {
    const app = buildApp()
    const check = (await app.inject({ url: '/partner-dependencies/check' })).json()
    expect(check.data.findings).toHaveLength(1)
    const field = (await app.inject({ url: '/partner-dependencies/field/orders/total' })).json()
    expect(field.data[0].key).toBe('key:7')
  })

  it('registers one readiness check that warns on findings', async () => {
    buildApp()
    await buildApp().ready()
    const check = registered.find((c) => c.id === 'partner-dependencies') as unknown as {
      run: () => Promise<{ status: string; blockers?: string[] }>
    }
    expect(registered.filter((c) => c.id === 'partner-dependencies')).toHaveLength(1)
    const r = await check.run()
    expect(r.status).toBe('warn')
    expect(r.blockers?.[0]).toContain('orders.total')
  })
})
