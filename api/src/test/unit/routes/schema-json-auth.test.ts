import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

// GET /schema.json (OpenAPI listing of every collection and field) answered
// anyone, signed in or not, with `Access-Control-Allow-Origin: *`. It now
// needs a signed-in caller (session cookie — the Swagger page sends it — or a
// Bearer token for CI and code generators).

vi.mock('../../../config.js', () => ({ config: { PORT: 3055 } }))
vi.mock('../../../middleware/authenticate.js', () => {
  const authenticate = vi.fn(async (req: { headers: Record<string, string | undefined> }) => {
    if (!req.headers['x-test-user'])
      throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
  })
  return { authenticate, requireAdmin: authenticate }
})
const spec = vi.hoisted(() => vi.fn(async () => ({ openapi: '3.1.0', paths: { '/items/po': {} } })))
vi.mock('../../../services/schema-builder.js', () => ({ buildOpenAPISpec: spec }))

import { schemaRoutes } from '../../../routes/schema.js'

async function buildApp() {
  const app = Fastify()
  await app.register(schemaRoutes)
  await app.ready()
  return app
}

describe('GET /schema.json', () => {
  it('refuses a caller who is not signed in and builds nothing', async () => {
    const app = await buildApp()
    spec.mockClear()
    const res = await app.inject({ url: '/schema.json' })
    expect(res.statusCode).toBe(401)
    expect(spec).not.toHaveBeenCalled()
    await app.close()
  })

  it('answers a signed-in caller', async () => {
    const app = await buildApp()
    const res = await app.inject({ url: '/schema.json', headers: { 'x-test-user': 'u1' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().paths['/items/po']).toBeDefined()
    await app.close()
  })
})
