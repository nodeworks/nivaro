import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// #2452 — concurrent POST /custom-queries/:slug/execute calls that resolve to
// the same final key share ONE SQL run (cache_ttl 0 included); each caller is
// still authorised on its own, and different scope values never share a run.
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
vi.mock('../../../services/db-tuning/param-sets.js', () => ({
  effectiveParams: vi.fn((p: unknown) => p),
  recordParamSet: vi.fn()
}))
const scope = vi.hoisted(() => ({
  applyScopeParams: vi.fn(
    async (_def: unknown, params: Record<string, unknown>, userId?: string) => {
      // A restricted caller gets its zone mixed into the params (and the key).
      if (userId === 'restricted') params.__zone = 'Z1'
    }
  )
}))
vi.mock('../../../services/custom-query-scope.js', () => scope)

const exec = vi.hoisted(() => ({
  gate: null as null | { promise: Promise<void>; resolve: () => void },
  fail: false
}))
vi.mock('../../../services/custom-query-exec.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return {
    ...real,
    execCustomQuerySql: vi.fn(async () => {
      await exec.gate?.promise
      if (exec.fail) throw new Error('proc failed')
      return [{ total: 7 }]
    })
  }
})
vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => {
    const c: Record<string, unknown> = {}
    c.where = vi.fn(() => c)
    c.first = vi.fn(async () => ({
      id: 3,
      slug: 'pub-health',
      access: 'authenticated',
      enabled: true,
      sql_text: 'EXEC dbo.pub_health :year',
      params: JSON.stringify([{ name: 'year', type: 'integer' }]),
      scope_params: null,
      cache_ttl: 0
    }))
    return c
  })
}))

import { customQueriesRoutes } from '../../../routes/custom-queries.js'
import { execCustomQuerySql } from '../../../services/custom-query-exec.js'
import { resetReadGate } from '../../../services/read-gate.js'
import { resetSingleFlight } from '../../../services/single-flight.js'

function hold() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  exec.gate = { promise, resolve }
  return exec.gate
}

async function app() {
  const a = Fastify({ logger: false })
  a.register(customQueriesRoutes, { prefix: '/custom-queries' })
  await a.ready()
  return a
}

const run = (a: Awaited<ReturnType<typeof app>>, user: string | null, year = 2026) =>
  a.inject({
    method: 'POST',
    url: '/custom-queries/pub-health/execute',
    headers: user ? { 'x-test-user': user } : {},
    payload: { params: { year } }
  })

beforeEach(() => {
  resetSingleFlight()
  resetReadGate({ global: 20, perUser: 4, maxWaitMs: 30_000 })
  exec.fail = false
})
afterEach(() => {
  vi.clearAllMocks()
  exec.gate = null
})

describe('POST /custom-queries/:slug/execute single-flight', () => {
  it('runs the SQL once for 10 concurrent same-key callers (cache_ttl 0)', async () => {
    const a = await app()
    const g = hold()
    const calls = Array.from({ length: 10 }, (_, i) => run(a, `u${i}`))
    await new Promise((r) => setTimeout(r, 20))
    g.resolve()
    const res = await Promise.all(calls)
    expect(res.map((r) => r.statusCode)).toEqual(Array(10).fill(200))
    expect(res.every((r) => r.json().data[0].total === 7)).toBe(true)
    expect(execCustomQuerySql).toHaveBeenCalledTimes(1)
    expect(
      res.filter((r) => String(r.headers['server-timing'] ?? '').includes('shared'))
    ).toHaveLength(9)
  })

  it('checks access per caller before joining: an anonymous caller is refused', async () => {
    const a = await app()
    const g = hold()
    const ok = run(a, 'u1')
    const anon = await run(a, null)
    expect(anon.statusCode).toBe(401)
    g.resolve()
    expect((await ok).statusCode).toBe(200)
    expect(execCustomQuerySql).toHaveBeenCalledTimes(1)
  })

  it('never shares across scope values or params', async () => {
    const a = await app()
    const g = hold()
    const calls = [run(a, 'u1'), run(a, 'restricted'), run(a, 'u2', 2025)]
    await new Promise((r) => setTimeout(r, 20))
    g.resolve()
    await Promise.all(calls)
    expect(execCustomQuerySql).toHaveBeenCalledTimes(3)
  })

  it('a failed run reaches its waiters, not later callers', async () => {
    const a = await app()
    const g = hold()
    exec.fail = true
    const calls = [run(a, 'u1'), run(a, 'u2')]
    await new Promise((r) => setTimeout(r, 20))
    g.resolve()
    expect((await Promise.all(calls)).map((r) => r.statusCode)).toEqual([400, 400])
    exec.fail = false
    exec.gate = null
    expect((await run(a, 'u3')).statusCode).toBe(200)
    expect(execCustomQuerySql).toHaveBeenCalledTimes(2)
  })
})
