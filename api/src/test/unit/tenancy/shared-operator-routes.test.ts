import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Hub phase 6 Task 22 fix round 1, ruling P6-13: on a Hub shared deployment every process-wide
// operator route answers an app's administrator 403 SHARED_OPERATOR_ONLY (one gate,
// services/shared-operator.ts). Self-hosted and Nivaro Cloud are unchanged.

vi.mock('../../../middleware/authenticate.js', async (orig) => ({
  ...(await orig<object>()),
  // The caller is an administrator of their app: the gate is what is under test.
  requireAdmin: async () => {}
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))

const { opsRuntimeRoutes } = await import('../../../routes/ops-runtime.js')
const { opsLogsRoutes } = await import('../../../routes/ops-logs.js')
const { healthRoutes } = await import('../../../routes/health.js')
const { realtimeRoutes } = await import('../../../routes/realtime.js')
const { realtimeVerifyRoutes } = await import('../../../routes/realtime-verify.js')
const { telemetryRoutes } = await import('../../../routes/telemetry.js')
const { metricsPlugin } = await import('../../../plugins/metrics.js')
const { opsDbRoutes } = await import('../../../routes/ops-db.js')
const { opsRedisRoutes } = await import('../../../routes/ops-redis.js')
const { infrastructureRoutes } = await import('../../../routes/infrastructure.js')

const ENV = ['HUB_SHARED_DEPLOYMENT', 'CLOUD_META_DB_URL'] as const
afterEach(() => {
  for (const k of ENV) delete process.env[k]
})
const shared = () => {
  process.env.HUB_SHARED_DEPLOYMENT = 'shared-1'
}
const cloud = () => {
  process.env.CLOUD_META_DB_URL = 'postgres://meta.invalid/db'
}

async function serve(
  plugin: (app: FastifyInstance) => Promise<void>,
  prefix: string
): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('redis', { get: async () => null } as never)
  await app.register(plugin, { prefix })
  await app.ready()
  return app
}

const SNAPSHOT = '/api/ops-runtime/heap-snapshot/nivaro-heap-1.heapsnapshot'

describe('heap snapshot (C-1)', () => {
  it('shared: an app admin can neither take nor download one', async () => {
    shared()
    const app = await serve(opsRuntimeRoutes, '/api/ops-runtime')
    const take = await app.inject({ method: 'POST', url: '/api/ops-runtime/heap-snapshot' })
    expect(take.statusCode).toBe(403)
    expect(take.json().code).toBe('SHARED_OPERATOR_ONLY')
    const get = await app.inject({ method: 'GET', url: SNAPSHOT })
    expect(get.statusCode).toBe(403)
    expect(get.json().code).toBe('SHARED_OPERATOR_ONLY')
    await app.close()
  })

  it('self-hosted and cloud: the download route answers as before (no such file: 404)', async () => {
    for (const mode of [() => {}, cloud]) {
      mode()
      const app = await serve(opsRuntimeRoutes, '/api/ops-runtime')
      const get = await app.inject({ method: 'GET', url: SNAPSHOT })
      expect(get.statusCode).toBe(404)
      await app.close()
      for (const k of ENV) delete process.env[k]
    }
  })
})

describe('restart', () => {
  it('shared: an app admin cannot restart the shared process', async () => {
    shared()
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const app = await serve(opsRuntimeRoutes, '/api/ops-runtime')
    const res = await app.inject({
      method: 'POST',
      url: '/api/ops-runtime/restart',
      payload: { reason: 'test', force: true }
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('SHARED_OPERATOR_ONLY')
    await new Promise((r) => setTimeout(r, 300))
    expect(exit).not.toHaveBeenCalled()
    exit.mockRestore()
    await app.close()
  })

  it('self-hosted: unchanged (a reason is still required)', async () => {
    const app = await serve(opsRuntimeRoutes, '/api/ops-runtime')
    const res = await app.inject({ method: 'POST', url: '/api/ops-runtime/restart', payload: {} })
    expect(res.statusCode).toBe(400)
    await app.close()
  })
})

describe('one route from each other group', () => {
  const cases: Array<[string, (app: FastifyInstance) => Promise<void>, string, string]> = [
    ['process runtime', opsRuntimeRoutes, '/api/ops-runtime', '/api/ops-runtime/runtime'],
    [
      'every replica’s in-flight requests',
      opsRuntimeRoutes,
      '/api/ops-runtime',
      '/api/ops-runtime/inflight'
    ],
    ['server-wide expensive SQL', opsDbRoutes, '/api/ops-db', '/api/ops-db/expensive-sql'],
    ['the shared Redis key browser', opsRedisRoutes, '/api/ops-redis', '/api/ops-redis/keys'],
    [
      'the deployment infrastructure',
      infrastructureRoutes,
      '/api/infrastructure',
      '/api/infrastructure/status'
    ],
    ['cache console', opsRuntimeRoutes, '/api/ops-runtime', '/api/ops-runtime/caches'],
    ['deployment environment', opsLogsRoutes, '/api/ops-logs', '/api/ops-logs/env'],
    ['detailed health', healthRoutes, '/api', '/api/health/detailed'],
    ['event pipeline', realtimeRoutes, '/api/realtime', '/api/realtime/pipeline'],
    ['delivery SLO', realtimeVerifyRoutes, '/api/realtime', '/api/realtime/delivery-slo'],
    ['telemetry stack', telemetryRoutes, '/api/telemetry', '/api/telemetry/status']
  ]
  it.each(cases)('shared: %s answers 403 SHARED_OPERATOR_ONLY', async (_n, plugin, prefix, url) => {
    shared()
    const app = await serve(plugin, prefix)
    const res = await app.inject({ method: 'GET', url })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('SHARED_OPERATOR_ONLY')
    await app.close()
  })

  it('self-hosted: the same routes are not refused by the gate', async () => {
    for (const [, plugin, prefix, url] of cases) {
      const app = await serve(plugin, prefix)
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode, url).not.toBe(403)
      await app.close()
    }
  })

  it('metrics: an app admin is refused on shared; the operator scraper token still reads', async () => {
    shared()
    process.env.METRICS_TOKEN = 'm'.repeat(40)
    const app = Fastify()
    await app.register(metricsPlugin)
    await app.ready()
    const admin = await app.inject({ method: 'GET', url: '/api/metrics' })
    expect(admin.statusCode).toBe(403)
    expect(admin.json().code).toBe('SHARED_OPERATOR_ONLY')
    const scraper = await app.inject({
      method: 'GET',
      url: '/api/metrics',
      headers: { authorization: `Bearer ${'m'.repeat(40)}` }
    })
    expect(scraper.statusCode).toBe(200)
    delete process.env.METRICS_TOKEN
    await app.close()
  })
})
