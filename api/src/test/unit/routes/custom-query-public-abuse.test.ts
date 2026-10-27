import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Security audit 2026-10-27, cluster D:
//   M19 — anonymous runs of public queries (execute + /public/:token) are cached for at
//         least PUBLIC_QUERY_MIN_CACHE_S and go through the read gate + single flight;
//   Low — anonymous callers never see driver text, and cannot tell a missing slug from
//         one they may not run.
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: { user?: unknown; isAdmin?: boolean; headers: any }) => {
    const id = req.headers['x-test-user']
    if (id) req.user = { id, role: 'R' }
    req.isAdmin = req.headers['x-test-admin'] === '1'
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
  bustFreshnessInference: vi.fn(),
  parseFreshnessSources: vi.fn(() => []),
  queryFreshness: vi.fn(async () => null)
}))
vi.mock('../../../services/db-tuning/param-sets.js', () => ({
  effectiveParams: vi.fn((p: unknown) => p),
  recordParamSet: vi.fn()
}))
vi.mock('../../../services/custom-query-scope.js', () => ({ applyScopeParams: vi.fn() }))

const exec = vi.hoisted(() => ({ fail: false }))
vi.mock('../../../services/custom-query-exec.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return {
    ...real,
    execCustomQuerySql: vi.fn(async () => {
      if (exec.fail) throw new Error("Invalid object name 'dbo.secret_table'.")
      return [{ total: 7 }]
    })
  }
})

const rows = vi.hoisted(() => ({
  byField: {} as Record<string, Record<string, unknown>>
}))
vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => {
    let where: Record<string, unknown> = {}
    const c: Record<string, unknown> = {}
    c.where = vi.fn((w: Record<string, unknown>) => {
      where = w
      return c
    })
    c.first = vi.fn(async () => {
      if (where.slug) return rows.byField[`slug:${where.slug}`]
      if (where.public_token) return rows.byField[`token:${where.public_token}`]
      return undefined
    })
    return c
  })
}))

import { customQueriesRoutes, effectiveCacheTtl } from '../../../routes/custom-queries.js'
import { execCustomQuerySql } from '../../../services/custom-query-exec.js'
import { resetReadGate } from '../../../services/read-gate.js'
import { resetSingleFlight } from '../../../services/single-flight.js'

const TOKEN = 'a'.repeat(48)
const base = {
  enabled: true,
  sql_text: 'EXEC dbo.report :year',
  params: JSON.stringify([{ name: 'year', type: 'integer' }]),
  scope_params: null
}

function fakeRedis() {
  const store = new Map<string, string>()
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    setex: vi.fn(async (k: string, _ttl: number, v: string) => {
      store.set(k, v)
      return 'OK'
    }),
    ttl: vi.fn(async () => 50)
  }
}

async function app() {
  const a = Fastify({ logger: false })
  const redis = fakeRedis()
  a.decorate('redis', redis as never)
  a.register(customQueriesRoutes, { prefix: '/custom-queries' })
  await a.ready()
  return { a, redis }
}

const execute = (
  a: Awaited<ReturnType<typeof app>>['a'],
  slug: string,
  headers: Record<string, string> = {}
) =>
  a.inject({
    method: 'POST',
    url: `/custom-queries/${slug}/execute`,
    headers,
    payload: { params: { year: 2026 } }
  })

beforeEach(() => {
  resetSingleFlight()
  resetReadGate({ global: 20, perUser: 4, maxWaitMs: 30_000 })
  exec.fail = false
  rows.byField = {
    'slug:pub': { id: 1, slug: 'pub', access: 'public', cache_ttl: 0, ...base },
    'slug:members': { id: 2, slug: 'members', access: 'authenticated', cache_ttl: 0, ...base },
    'slug:admins': { id: 3, slug: 'admins', access: 'admin', cache_ttl: 0, ...base },
    [`token:${TOKEN}`]: { id: 1, slug: 'pub', access: 'public', cache_ttl: 0, ...base }
  }
})
afterEach(() => {
  vi.clearAllMocks()
  delete process.env.PUBLIC_QUERY_MIN_CACHE_S
})

describe('effectiveCacheTtl', () => {
  it('floors anonymous runs at the public minimum; signed-in keep their own', () => {
    expect(effectiveCacheTtl(0, true)).toBe(60)
    expect(effectiveCacheTtl(300, true)).toBe(300)
    expect(effectiveCacheTtl(0, false)).toBe(0)
    process.env.PUBLIC_QUERY_MIN_CACHE_S = '0'
    expect(effectiveCacheTtl(0, true)).toBe(0)
  })
})

describe('anonymous public queries (M19)', () => {
  it('execute: a second anonymous call is served from the cache (cache_ttl 0)', async () => {
    const { a } = await app()
    const first = await execute(a, 'pub')
    const second = await execute(a, 'pub')
    expect(first.statusCode).toBe(200)
    expect(second.json().cached).toBe(true)
    expect(execCustomQuerySql).toHaveBeenCalledTimes(1)
    await a.close()
  })

  it('execute: a signed-in caller of a cache_ttl 0 query still runs live', async () => {
    const { a } = await app()
    await execute(a, 'pub', { 'x-test-user': 'U1' })
    await execute(a, 'pub', { 'x-test-user': 'U1' })
    expect(execCustomQuerySql).toHaveBeenCalledTimes(2)
    await a.close()
  })

  it('/public/:token is cached and shares the execute cache entry', async () => {
    const { a } = await app()
    const one = await a.inject({ url: `/custom-queries/public/${TOKEN}?year=2026` })
    const two = await a.inject({ url: `/custom-queries/public/${TOKEN}?year=2026` })
    const three = await execute(a, 'pub')
    expect(one.statusCode).toBe(200)
    expect(two.json().data).toEqual([{ total: 7 }])
    expect(three.json().cached).toBe(true)
    expect(execCustomQuerySql).toHaveBeenCalledTimes(1)
    await a.close()
  })

  it('never hands an anonymous caller the driver text', async () => {
    const { a } = await app()
    exec.fail = true
    const viaExecute = await execute(a, 'pub')
    const viaToken = await a.inject({ url: `/custom-queries/public/${TOKEN}?year=2026` })
    expect(viaExecute.statusCode).toBe(400)
    expect(viaToken.statusCode).toBe(422)
    expect(viaExecute.body).not.toContain('secret_table')
    expect(viaToken.body).not.toContain('secret_table')
    await a.close()
  })
})

describe('slug enumeration', () => {
  it('anonymous: missing, members-only and admin-only all answer 401', async () => {
    const { a } = await app()
    for (const slug of ['nope', 'members', 'admins']) {
      expect((await execute(a, slug)).statusCode).toBe(401)
    }
    await a.close()
  })

  it('signed in, not admin: admin-only looks exactly like missing', async () => {
    const { a } = await app()
    const missing = await execute(a, 'nope', { 'x-test-user': 'U1' })
    const admin = await execute(a, 'admins', { 'x-test-user': 'U1' })
    expect(missing.statusCode).toBe(404)
    expect(admin.statusCode).toBe(404)
    expect(admin.body).toBe(missing.body)
    expect((await execute(a, 'members', { 'x-test-user': 'U1' })).statusCode).toBe(200)
    expect(
      (await execute(a, 'admins', { 'x-test-user': 'U1', 'x-test-admin': '1' })).statusCode
    ).toBe(200)
    await a.close()
  })
})
