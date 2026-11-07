import Fastify from 'fastify'
import knexFactory from 'knex'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// army6 M40: /api/provenance/forecasts/7917869 answered in 13.7–16.8 s and kept
// running after the page was left. Every statement now rides one 3 s budget and
// is cancelled on the server (bounded-sql) when it runs out.

const state = vi.hoisted(() => ({
  calls: [] as { sql: string; timeoutMs: number }[],
  answer: (_sql: string): Record<string, unknown>[] | 'cancel' => []
}))

vi.mock('../../../middleware/authenticate.js', () => {
  const sign = async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'U1', role: 'R' }
    req.isAdmin = true
  }
  return { requireAuth: sign }
})
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
vi.mock('../../../services/chain-columns.js', () => ({ hasChainColumns: vi.fn(async () => false) }))
vi.mock('../../../db/index.js', () => {
  const k = knexFactory({ client: 'mssql' })
  return { db: k }
})
vi.mock('../../../services/bounded-sql.js', () => {
  class StatementCancelled extends Error {}
  return {
    StatementCancelled,
    boundedRaw: vi.fn(async (sql: string, _b: unknown[], opts: { timeoutMs: number }) => {
      state.calls.push({ sql, timeoutMs: opts.timeoutMs })
      const a = state.answer(sql)
      if (a === 'cancel') throw new StatementCancelled('timeout')
      return a
    })
  }
})

const { lastTouchRoutes, PROVENANCE_BUDGET_MS } = await import('../../../routes/last-touch.js')

const created = {
  id: 5,
  action: 'create',
  timestamp: new Date('2026-11-01T12:00:00Z'),
  comment: null,
  legacy_id: null,
  user: 'U9',
  first_name: 'Beth',
  last_name: 'Ray',
  email: 'b@x',
  status: 'active'
}

async function get(url: string) {
  const app = Fastify()
  await app.register(lastTouchRoutes)
  return app.inject({ url })
}

beforeEach(() => {
  state.calls = []
  state.answer = () => []
})

describe('provenance', () => {
  it('reads the earliest activity as a TOP 1 in timestamp order, inside the budget', async () => {
    state.answer = (sql) =>
      sql.includes('nivaro_activity') && sql.includes('[u]') ? [created] : []
    const res = await get('/provenance/forecasts/7917869')
    expect(res.statusCode).toBe(200)
    expect(res.json().data.user_name).toBe('Beth Ray')
    const firstSql = state.calls[0].sql
    expect(firstSql).toMatch(/top \(\?\)/i)
    expect(firstSql).toMatch(/order by \[a\]\.\[timestamp\] asc, \[a\]\.\[id\] asc/i)
    for (const c of state.calls) {
      expect(c.timeoutMs).toBeGreaterThan(0)
      expect(c.timeoutMs).toBeLessThanOrEqual(PROVENANCE_BUDGET_MS)
    }
  })

  it('answers null (not a 15 s wait) when the earliest-activity read runs out of time', async () => {
    state.answer = () => 'cancel'
    const res = await get('/provenance/forecasts/7917869')
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toBeNull()
  })

  it('a cut API-log scan still answers with the origin it knows', async () => {
    state.answer = (sql) =>
      sql.includes('nivaro_api_logs') ? 'cancel' : sql.includes('[u]') ? [created] : []
    const res = await get('/provenance/forecasts/7917869')
    expect(res.statusCode).toBe(200)
    expect(res.json().data.origin).toBe('Manual')
    expect(res.json().data.api).toBeNull()
  })
})
