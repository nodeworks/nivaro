import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  ready: vi.fn(),
  record: vi.fn(),
  activity: vi.fn(),
  admin: vi.fn()
}))

vi.mock('../services/activity.js', () => ({ logActivity: m.activity }))
// Stands in for the real requireAdmin: a request without a bearer is refused.
vi.mock('../middleware/authenticate.js', () => ({ requireAdmin: m.admin }))
vi.mock('../services/infra-drift/store.js', async (orig) => {
  const real = await orig<typeof import('../services/infra-drift/store.js')>()
  return {
    ...real,
    driftTablesReady: m.ready,
    // The real validation runs first; only the DB write is replaced.
    recordBaseline: async (body: Record<string, unknown>, user: string | null) => {
      const p = await real.prepareBaseline(body)
      return m.record(p, user)
    }
  }
})

const { infrastructureDriftRoutes } = await import('./infrastructure-drift.js')

const saved = { ...process.env }

async function build() {
  const app = Fastify()
  app.decorateRequest('user', undefined)
  await app.register(infrastructureDriftRoutes)
  return app
}

const ADMIN = { authorization: 'Bearer admin-token' }

const svc = (name: string) => ({
  ID: name,
  Version: { Index: 10 },
  Spec: {
    Name: name,
    Labels: { 'com.docker.stack.namespace': 'efp' },
    TaskTemplate: {
      ContainerSpec: { Image: 'nodeworks/nivaro:0.3.4@sha256:abc', Env: ['DB_PASSWORD=hunter2'] }
    }
  }
})

beforeEach(() => {
  delete process.env.CLOUD_META_DB_URL
  delete process.env.DOCKER_HOSTS
  process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef'
  m.ready.mockResolvedValue(true)
  m.record.mockImplementation(async (p: any) => ({
    id: 7,
    stack: p.stack,
    environment: p.environment,
    source: p.source,
    services: p.services.length,
    ignored: p.ignored,
    resolved_findings: 0
  }))
  m.activity.mockResolvedValue(1)
  m.admin.mockImplementation(async (req: any) => {
    if (req.headers.authorization !== ADMIN.authorization)
      throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    req.user = { id: 'admin-1' }
  })
})
afterEach(() => {
  process.env = { ...saved }
  vi.clearAllMocks()
})

describe('POST /drift/baseline (the deploy script contract)', () => {
  it('stores a posted baseline and answers 200', async () => {
    const app = await build()
    const res = await app.inject({
      method: 'POST',
      url: '/drift/baseline',
      headers: ADMIN,
      payload: {
        stack: 'efp',
        environment: 'production',
        version: '0.3.4',
        release: 'efp-2026.10.22',
        services: [svc('efp_api'), svc('efp_worker')]
      }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toMatchObject({ id: 7, services: 2, source: 'posted' })
    const stored = m.record.mock.calls[0][0]
    expect(JSON.stringify(stored)).not.toContain('hunter2')
    expect(m.activity.mock.calls[0][0]).toMatchObject({
      action: 'infra-drift-baseline',
      item: 'efp:production'
    })
    expect(m.activity.mock.calls[0][0].comment).toContain('version 0.3.4')
  })

  it('400s a bad body, and says so when there is no live source to read', async () => {
    const app = await build()
    const bad = await app.inject({
      method: 'POST',
      url: '/drift/baseline',
      headers: ADMIN,
      payload: { stack: 'efp', environment: 'production', services: 'nope' }
    })
    expect(bad.statusCode).toBe(400)
    const noSource = await app.inject({
      method: 'POST',
      url: '/drift/baseline',
      headers: ADMIN,
      payload: { stack: 'efp', environment: 'production' }
    })
    expect(noSource.statusCode).toBe(400)
    expect(noSource.json().error).toMatch(/No live source — set DOCKER_HOSTS/)
    expect(m.record).not.toHaveBeenCalled()
  })

  it('503s before the migration, 404s in cloud mode, 413s an oversized body', async () => {
    const app = await build()
    m.ready.mockResolvedValue(false)
    const r1 = await app.inject({
      method: 'POST',
      url: '/drift/baseline',
      headers: ADMIN,
      payload: {}
    })
    expect(r1.statusCode).toBe(503)
    const big = await app.inject({
      method: 'POST',
      url: '/drift/baseline',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ stack: 'efp', pad: 'x'.repeat(9 * 1024 * 1024) })
    })
    expect(big.statusCode).toBe(413)
    process.env.CLOUD_META_DB_URL = 'x'
    expect((await app.inject({ method: 'GET', url: '/drift' })).statusCode).toBe(404)
    expect(
      (await app.inject({ method: 'POST', url: '/drift/baseline', payload: {} })).statusCode
    ).toBe(404)
  })
})

describe('auth runs before the body is read', () => {
  it('refuses an anonymous 9 MB post with 401, never 413, and never parses it', async () => {
    const app = await build()
    const res = await app.inject({
      method: 'POST',
      url: '/drift/baseline',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ stack: 'efp', pad: 'x'.repeat(9 * 1024 * 1024) })
    })
    expect(res.statusCode).toBe(401)
    expect(m.ready).not.toHaveBeenCalled()
    expect(m.record).not.toHaveBeenCalled()
    expect((await app.inject({ method: 'GET', url: '/drift' })).statusCode).toBe(401)
  })
})
