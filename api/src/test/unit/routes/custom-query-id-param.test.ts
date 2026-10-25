import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The /:id routes take the numeric id or the slug: a slug used to reach SQL
// as an int parameter and answer 500 "Validation failed for parameter 'p1'".
const store = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  wheres: [] as Array<Record<string, unknown>>
}))

vi.mock('../../../config.js', () => ({ config: { NODE_ENV: 'test' } }))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async () => {}),
  requireAdmin: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'A', role: 'R' }
    req.isAdmin = true
  })
}))
vi.mock('../../../services/activity.js', () => ({
  logActivity: vi.fn(async () => {}),
  logActivityThrottled: vi.fn(async () => {})
}))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: vi.fn() }))
vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => {
    let where: Record<string, unknown> = {}
    const c: Record<string, unknown> = {}
    c.where = vi.fn((w: Record<string, unknown>) => {
      where = w
      store.wheres.push(w)
      return c
    })
    c.first = vi.fn(async () =>
      store.rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v))
    )
    return c
  })
}))

import { customQueriesRoutes, resolveQueryIdParam } from '../../../routes/custom-queries.js'

async function app() {
  const a = Fastify()
  await a.register(customQueriesRoutes, { prefix: '/custom-queries' })
  return a
}

beforeEach(() => {
  store.wheres = []
  store.rows = [
    {
      id: 7,
      slug: 'forecast-grid',
      name: 'Forecast grid',
      sql_text: 'SELECT 1',
      params: null,
      cache_ttl: 0,
      enabled: true,
      access: 'authenticated'
    }
  ]
})

describe('custom-query :id param', () => {
  it('passes a numeric id through without a lookup', async () => {
    expect(await resolveQueryIdParam('7')).toBe('7')
    expect(store.wheres).toEqual([])
  })

  it('resolves a slug to its id', async () => {
    expect(await resolveQueryIdParam('forecast-grid')).toBe('7')
  })

  it('answers nobody for an unknown slug or a malformed id', async () => {
    expect(await resolveQueryIdParam('nope')).toBeNull()
    expect(await resolveQueryIdParam("1' OR 1=1")).toBeNull()
  })

  it('GET /custom-queries/<slug> answers the query, not a 500', async () => {
    const res = await (await app()).inject({ method: 'GET', url: '/custom-queries/forecast-grid' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.slug).toBe('forecast-grid')
    expect(store.wheres.at(-1)).toEqual({ id: 7 })
  })

  it('GET /custom-queries/<unknown> answers 404', async () => {
    const res = await (await app()).inject({ method: 'GET', url: '/custom-queries/nope' })
    expect(res.statusCode).toBe(404)
  })
})
