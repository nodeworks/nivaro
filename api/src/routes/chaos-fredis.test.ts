import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../middleware/authenticate.js', () => ({
  // requireChaosOperator (#2862) authenticates, then lets administrators through.
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: '11111111-1111-1111-1111-111111111111' }
    req.isAdmin = true
  },
  requireAuth: async () => {},
  requireAdmin: async (req: { user?: unknown }) => {
    req.user = { id: '11111111-1111-1111-1111-111111111111' }
  }
}))
const check = vi.fn().mockResolvedValue({ overlaps: [], stuck: [], unsafe: [] })
vi.mock('../services/chaos/cron-overlap.js', () => ({
  checkCronOverlap: (...a: unknown[]) => check(...a),
  cronJobsOf: async () => [{ id: 'poll', idempotent: 'unknown', budget_ms: 60_000 }]
}))

import { chaosFredisRoutes } from './chaos-fredis.js'

const saved = { ...process.env }

async function build() {
  const app = Fastify()
  app.decorate('redis', { options: { db: 0 } } as never)
  await app.register(chaosFredisRoutes)
  await app.ready()
  return app
}

beforeEach(() => {
  delete process.env.CLOUD_META_DB_URL
  delete process.env.CHAOS_TEST_CRON
  process.env.NODE_ENV = 'development'
  check.mockClear()
})
afterEach(() => {
  process.env = { ...saved }
})

describe('chaos check routes (#2832, #2833, #2838)', () => {
  it('cron-overlap reads the window it is given and refuses a bad date', async () => {
    const app = await build()
    const ok = await app.inject({
      method: 'GET',
      url: '/checks/cron-overlap?since=2026-10-21T12:00:00Z'
    })
    expect(ok.statusCode).toBe(200)
    expect(check).toHaveBeenCalledWith([{ id: 'poll', idempotent: 'unknown', budget_ms: 60_000 }], {
      since: new Date('2026-10-21T12:00:00Z'),
      until: undefined
    })
    const bad = await app.inject({ method: 'GET', url: '/checks/cron-overlap?since=yesterday' })
    expect(bad.statusCode).toBe(400)
  })

  it('the partition check wants a probe id', async () => {
    const app = await build()
    const bad = await app.inject({ method: 'GET', url: '/checks/partition?probe=../x' })
    expect(bad.statusCode).toBe(400)
  })

  it('the Redis check says why sessions may not be dropped on db 0 here', async () => {
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/checks/redis' })
    expect(res.json().data).toMatchObject({
      db: 0,
      sessions_refusal: expect.stringMatching(/other than 0/),
      counters: expect.objectContaining({ readonly: expect.any(Number) })
    })
  })

  it('the probe is refused at the gate in cloud mode, and without a socket server', async () => {
    const app = await build()
    const none = await app.inject({ method: 'POST', url: '/partition/probe', payload: {} })
    expect(none.statusCode).toBe(503)
    expect(none.json().code).toBe('CHAOS_NO_SOCKETS')
    process.env.CLOUD_META_DB_URL = 'x'
    const cloud = await app.inject({ method: 'POST', url: '/partition/probe', payload: {} })
    expect(cloud.statusCode).toBe(403)
    expect(cloud.json().code).toBe('CHAOS_GATE')
  })

  it('the test scheduler never starts without CHAOS_TEST_CRON=1, nor on production', async () => {
    const { chaosTestCronWanted } = await import('../services/chaos/cron-test-job.js')
    expect(chaosTestCronWanted({ NODE_ENV: 'development' })).toBe(false)
    expect(chaosTestCronWanted({ NODE_ENV: 'development', CHAOS_TEST_CRON: '1' })).toBe(true)
    expect(
      chaosTestCronWanted({ NODE_ENV: 'production', CHAOS_TEST_CRON: '1', CHAOS_ENABLED: 'true' })
    ).toBe(false)
    expect(
      chaosTestCronWanted({ NODE_ENV: 'development', CHAOS_TEST_CRON: '1', CLOUD_META_DB_URL: 'x' })
    ).toBe(false)
  })
})
