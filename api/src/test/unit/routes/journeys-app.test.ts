import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A knex-shaped fake: every builder call is recorded and returns the chain;
// awaiting it resolves the rows queued for that table. `where(fn)` runs fn on
// the same chain so nested clauses are recorded too.
const state = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown[]]>,
  rows: new Map<string, unknown[][]>(),
  hasApp: true
}))

function chain(table: string): unknown {
  const target: Record<string, unknown> = {}
  const proxy: unknown = new Proxy(target, {
    get(_t, prop: string) {
      if (prop === 'then') {
        const queue = state.rows.get(table) ?? []
        const rows = queue.shift() ?? []
        return (res: (v: unknown) => void) => res(rows)
      }
      return (...args: unknown[]) => {
        state.calls.push([prop, args])
        if (typeof args[0] === 'function') (args[0] as (q: unknown) => void)(proxy)
        return proxy
      }
    }
  })
  return proxy
}

vi.mock('../../../db/index.js', () => {
  const db = Object.assign((table: string) => chain(table), { raw: (s: string) => s })
  return { db }
})
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => state.hasApp) }))
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: async (req: Record<string, unknown>) => {
    req.user = { id: 'A1' }
    req.isAdmin = true
  }
}))

import { journeyAppFilter, journeyRoutes } from '../../../routes/journeys.js'
import { parsePageAt } from '../../../services/page-at.js'

async function app() {
  const a = Fastify()
  await a.register(journeyRoutes, { prefix: '/api/journeys' })
  return a
}

beforeEach(() => {
  state.calls = []
  state.rows = new Map()
  state.hasApp = true
})

describe('page:at app plumbing', () => {
  it('takes the ping label, else the client:hello label, else none', () => {
    expect(parsePageAt({ path: '/claims/1', app: 'efp' }, 'admin')).toEqual({
      path: '/claims/1',
      app: 'efp'
    })
    expect(parsePageAt({ path: '/claims/1' }, 'efp-new')).toEqual({
      path: '/claims/1',
      app: 'efp-new'
    })
    expect(parsePageAt({ path: '/claims/1', app: '<script>' }, null)).toEqual({
      path: '/claims/1',
      app: null
    })
    expect(parsePageAt({ path: '//evil' }, 'x')).toBeNull()
    expect(parsePageAt(null, 'x')).toBeNull()
  })

  it("filters 'admin' including legacy NULL rows", () => {
    expect(journeyAppFilter('admin')).toEqual({ app: 'admin', includeNull: true })
    expect(journeyAppFilter('efp')).toEqual({ app: 'efp', includeNull: false })
    expect(journeyAppFilter('')).toBeNull()
    expect(journeyAppFilter("x' OR 1=1 --")).toBeNull()
  })
})

describe('GET /journeys/user/:id?app=', () => {
  it('narrows to one app and stamps app on sessions and steps', async () => {
    state.rows.set('nivaro_admin_journeys', [
      [
        {
          id: 1,
          user: 'U1',
          session_id: 's1',
          path: '/claims',
          entered_at: new Date('2026-10-10T10:00:00Z'),
          duration_seconds: 30,
          app: 'efp'
        }
      ]
    ])
    const res = await (await app()).inject({
      method: 'GET',
      url: '/api/journeys/user/U1?date=2026-10-10&app=efp'
    })
    expect(res.statusCode).toBe(200)
    const where = state.calls.filter(([m]) => m === 'where' || m === 'orWhereNull')
    expect(where).toContainEqual(['where', ['app', 'efp']])
    expect(state.calls.some(([m]) => m === 'orWhereNull')).toBe(false)
    const s = res.json().data.sessions[0]
    expect(s.app).toBe('efp')
    expect(s.steps[0].app).toBe('efp')
  })

  it('reads NULL rows as the admin and skips the filter before the migration', async () => {
    state.hasApp = false
    state.rows.set('nivaro_admin_journeys', [
      [
        {
          id: 1,
          user: 'U1',
          session_id: 's1',
          path: '/x',
          entered_at: new Date(),
          duration_seconds: null
        }
      ]
    ])
    const res = await (await app()).inject({
      method: 'GET',
      url: '/api/journeys/user/U1?app=admin'
    })
    expect(state.calls.some(([m, a]) => m === 'where' && a[0] === 'app')).toBe(false)
    expect(res.json().data.sessions[0].steps[0].app).toBe('admin')
  })
})

describe('GET /journeys/days/:id', () => {
  it('lists the apps seen for the app filter', async () => {
    state.rows.set('nivaro_admin_journeys', [
      [{ day: '2026-10-10', n: 4 }],
      [{ app: null }, { app: 'efp' }, { app: 'admin' }]
    ])
    const res = await (await app()).inject({ method: 'GET', url: '/api/journeys/days/U1' })
    expect(res.json()).toEqual({ apps: ['admin', 'efp'], data: [{ date: '2026-10-10', steps: 4 }] })
  })
})
