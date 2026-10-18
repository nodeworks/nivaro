import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// #2452 — the REAL applyScopeParams feeds the execute route's final params:
// a restricted caller's allowance lands in the SQL params AND the cq: key
// (so single-flight and the Redis cache only ever share between callers with
// the same allowance). Only the scopes reader is faked.
vi.mock('../../../config.js', () => ({ config: { NODE_ENV: 'test' } }))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: { user?: unknown; isAdmin?: boolean; headers: any }) => {
    const id = req.headers['x-test-user']
    if (id) req.user = { id, role: 'R' }
    req.isAdmin = false
  }),
  requireAdmin: vi.fn(async () => {})
}))
vi.mock('../../../services/activity.js', () => ({
  logActivity: vi.fn(async () => {}),
  logActivityThrottled: vi.fn(async () => {})
}))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: vi.fn() }))
vi.mock('../../../services/traffic-map.js', () => ({ markCacheHit: vi.fn() }))
vi.mock('../../../services/query-freshness.js', () => ({
  queryFreshness: vi.fn(async () => null),
  bustFreshnessInference: vi.fn(),
  parseFreshnessSources: vi.fn(() => [])
}))
vi.mock('../../../services/db-tuning/param-sets.js', () => ({
  effectiveParams: vi.fn((p: unknown) => p),
  recordParamSet: vi.fn()
}))
vi.mock('../../../services/user-scopes.js', () => ({
  getUserScopes: vi.fn(async (userId: string) =>
    userId.startsWith('zoned')
      ? [{ mode: 'restrict', dimension: 'zone', values: ['Z1', 'Z2'] }]
      : []
  ),
  listScopeDimensions: vi.fn(async () => [])
}))

const exec = vi.hoisted(() => ({ hold: null as Promise<void> | null }))
vi.mock('../../../services/custom-query-exec.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return {
    ...real,
    execCustomQuerySql: vi.fn(async () => {
      await exec.hold
      return [{ total: 1 }]
    })
  }
})
vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => {
    const c: Record<string, unknown> = {}
    c.where = vi.fn(() => c)
    c.first = vi.fn(async () => ({
      id: 4,
      slug: 'zone-spend',
      access: 'authenticated',
      enabled: true,
      sql_text: 'EXEC dbo.zone_spend :year, :zone',
      params: JSON.stringify([
        { name: 'year', type: 'integer' },
        { name: 'zone', type: 'string' }
      ]),
      scope_params: JSON.stringify({ zone: { dimension: 'zone' } }),
      cache_ttl: 60
    }))
    return c
  })
}))

import { customQueriesRoutes } from '../../../routes/custom-queries.js'
import { execCustomQuerySql } from '../../../services/custom-query-exec.js'
import { resetReadGate } from '../../../services/read-gate.js'
import { resetSingleFlight } from '../../../services/single-flight.js'

const redis = {
  get: vi.fn(async (_key: string) => null as string | null),
  setex: vi.fn(async (_key: string, _ttl: number, _value: string) => 'OK'),
  ttl: vi.fn(async () => 60)
}

async function app() {
  const a = Fastify({ logger: false })
  a.decorate('redis', redis as never)
  a.register(customQueriesRoutes, { prefix: '/custom-queries' })
  await a.ready()
  return a
}

const run = (a: Awaited<ReturnType<typeof app>>, user: string, zone?: string) =>
  a.inject({
    method: 'POST',
    url: '/custom-queries/zone-spend/execute',
    headers: { 'x-test-user': user },
    payload: { params: { year: 2026, ...(zone ? { zone } : {}) } }
  })

beforeEach(() => {
  resetSingleFlight()
  resetReadGate({ global: 20, perUser: 4, maxWaitMs: 30_000 })
})
afterEach(() => {
  vi.clearAllMocks()
  exec.hold = null
})

describe('execute key carries the real User Scope allowance', () => {
  it('a restricted caller runs and caches under its allowance; an unrestricted one does not', async () => {
    const a = await app()
    await run(a, 'zoned-1')
    await run(a, 'free-1')
    const keys = redis.setex.mock.calls.map((c) => c[0])
    expect(keys).toEqual([
      `cq:zone-spend:${JSON.stringify({ year: 2026, zone: 'Z1,Z2' })}`,
      `cq:zone-spend:${JSON.stringify({ year: 2026, zone: null })}`
    ])
    const params = vi.mocked(execCustomQuerySql).mock.calls.map((c) => c[1])
    expect(params[0]).toEqual({ year: 2026, zone: 'Z1,Z2' })
  })

  it('asking outside the allowance never reaches an unscoped key', async () => {
    const a = await app()
    await run(a, 'zoned-1', 'Z9')
    expect(redis.setex.mock.calls[0][0]).toBe(
      `cq:zone-spend:${JSON.stringify({ year: 2026, zone: '__scope_empty__' })}`
    )
  })

  it('concurrent callers share a run only with callers of the same allowance', async () => {
    const a = await app()
    let open!: () => void
    exec.hold = new Promise<void>((r) => {
      open = r
    })
    const calls = [run(a, 'zoned-1'), run(a, 'zoned-2'), run(a, 'free-1'), run(a, 'free-2')]
    await new Promise((r) => setTimeout(r, 20))
    open()
    const res = await Promise.all(calls)
    expect(res.map((r) => r.statusCode)).toEqual([200, 200, 200, 200])
    expect(execCustomQuerySql).toHaveBeenCalledTimes(2)
    const zones = vi
      .mocked(execCustomQuerySql)
      .mock.calls.map((c) => (c[1] as { zone: unknown }).zone)
      .sort()
    expect(zones).toEqual(['Z1,Z2', null].sort())
  })
})
