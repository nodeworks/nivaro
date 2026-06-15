import { afterEach, describe, expect, it, vi } from 'vitest'

// Mock config before importing the route
vi.mock('../../../config.js', () => ({
  config: {
    NODE_ENV: 'test',
    DB_DATABASE: 'testdb',
    DB_HOST: 'localhost',
    REDIS_URL: 'redis://localhost:6379',
  },
}))

// Mock the requireAdmin middleware so /health/detailed doesn't need auth in these tests
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async () => {}),
  requireAuth: vi.fn(async () => {}),
  requireAdmin: vi.fn(async () => {}),
  cidrMatch: vi.fn(() => true),
  checkApiKeyScope: vi.fn(() => true),
}))

import Fastify from 'fastify'
import { db } from '../../../db/index.js'
import { healthRoutes } from '../../../routes/health.js'

function buildApp(redisPing: () => Promise<'PONG'>) {
  const app = Fastify({ logger: false })

  // @ts-ignore — test shim; partial Redis mock, not full ioredis instance
  app.decorate('redis', { ping: redisPing })

  app.register(healthRoutes)
  return app
}

afterEach(() => vi.clearAllMocks())

describe('GET /health', () => {
  it('returns 200 and status ok when db and redis are up', async () => {
    // DB raw('SELECT 1') resolves
    vi.mocked(db as unknown as { raw: (sql: string) => Promise<unknown> }).raw = vi
      .fn()
      .mockResolvedValue([])

    const app = buildApp(async () => 'PONG')
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/health' })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body.status).toBe('ok')
    expect((body.db as Record<string, unknown>).status).toBe('connected')
    expect((body.redis as Record<string, unknown>).status).toBe('connected')
    expect(body.version).toBe('0.1.0')
    expect(typeof body.ts).toBe('string')
  })

  it('returns 503 and status degraded when db is down', async () => {
    vi.mocked(db as unknown as { raw: (sql: string) => Promise<unknown> }).raw = vi
      .fn()
      .mockRejectedValue(new Error('connection refused'))

    const app = buildApp(async () => 'PONG')
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/health' })

    expect(res.statusCode).toBe(503)
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body.status).toBe('degraded')
    expect((body.db as Record<string, unknown>).status).toBe('disconnected')
    expect((body.redis as Record<string, unknown>).status).toBe('connected')
  })

  it('returns 503 and status degraded when redis is down', async () => {
    vi.mocked(db as unknown as { raw: (sql: string) => Promise<unknown> }).raw = vi
      .fn()
      .mockResolvedValue([])

    const app = buildApp(async () => {
      throw new Error('redis down')
    })
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/health' })

    expect(res.statusCode).toBe(503)
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body.status).toBe('degraded')
    expect((body.db as Record<string, unknown>).status).toBe('connected')
    expect((body.redis as Record<string, unknown>).status).toBe('disconnected')
  })

  it('returns 503 when both db and redis are down', async () => {
    vi.mocked(db as unknown as { raw: (sql: string) => Promise<unknown> }).raw = vi
      .fn()
      .mockRejectedValue(new Error('db down'))

    const app = buildApp(async () => {
      throw new Error('redis down')
    })
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/health' })

    expect(res.statusCode).toBe(503)
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body.status).toBe('degraded')
  })

  it('includes environment from config', async () => {
    vi.mocked(db as unknown as { raw: (sql: string) => Promise<unknown> }).raw = vi
      .fn()
      .mockResolvedValue([])

    const app = buildApp(async () => 'PONG')
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/health' })
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body.environment).toBe('test')
  })
})
