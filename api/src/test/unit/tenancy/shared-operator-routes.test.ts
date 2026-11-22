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
