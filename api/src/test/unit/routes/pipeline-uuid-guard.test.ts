import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// army4 L-1: `GET /pipelines/instance-owners?collection=…` has no route of its
// own, fell into `GET /:id` and SQL Server answered 500 "Conversion failed …
// to uniqueidentifier". A non-uuid template / state / transition id is a 404
// before anything reaches SQL.

vi.mock('../../../middleware/authenticate.js', () => {
  const set = async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'u-admin', role: 'role-admin' }
    req.isAdmin = true
  }
  return { authenticate: vi.fn(set), requireAuth: vi.fn(set), requireAdmin: vi.fn(set) }
})
vi.mock('../../../middleware/workspace.js', () => ({ resolveWorkspace: vi.fn(async () => {}) }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: vi.fn() }))

const tables = vi.hoisted(() => [] as string[])
vi.mock('../../../db/index.js', () => {
  const db = vi.fn((t: string) => {
    tables.push(t)
    const c: Record<string, unknown> = {}
    for (const m of ['where', 'whereIn', 'whereNull', 'orderBy', 'select', 'join', 'leftJoin'])
      c[m] = vi.fn(() => c)
    c.first = vi.fn(async () => undefined)
    c.delete = vi.fn(async () => 1)
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
    c.then = (res: (v: unknown) => unknown) => Promise.resolve([]).then(res)
    return c
  })
  return { db }
})

import {
  badUuidParam,
  offeredOnCompleted,
  pickInstancePerItem,
  pipelinesRoutes,
  uuidParamsOf
} from '../../../routes/pipelines.js'

async function get(url: string, method: 'GET' | 'DELETE' = 'GET') {
  const app = Fastify({ logger: false })
  await app.register(pipelinesRoutes, { prefix: '/pipelines' })
  return app.inject({ method, url })
}

beforeEach(() => {
  tables.length = 0
})

describe('uuid params', () => {
  it('GET /pipelines/instance-owners?… is a 404, never a template lookup', async () => {
    const res = await get('/pipelines/instance-owners?collection=workflows&item=372934')
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ code: 'NOT_FOUND', param: 'id' })
    expect(tables).not.toContain('nivaro_workflow_templates')
  })

  it('a non-uuid state id is a 404 too', async () => {
    const res = await get('/pipelines/states/finance_review/owner-groups')
    expect(res.statusCode).toBe(404)
    expect(tables).toHaveLength(0)
  })

  it('a real uuid reaches the route', async () => {
    const res = await get('/pipelines/590320D5-6249-463A-A63E-349CDA99D73F')
    // the fake DB has no such template: the route's own 404, after its lookup
    expect(res.statusCode).toBe(404)
    expect(tables).toContain('nivaro_workflow_templates')
  })

  // army 4 review H1: the guard ran on every route, and `/owner-group-users/:id` is an
  // integer row — every "remove from owner group" answered 404.
  it('DELETE /owner-group-users/:id takes an integer id', async () => {
    const res = await get('/pipelines/owner-group-users/42', 'DELETE')
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ success: true })
    expect(tables).toContain('nivaro_pipeline_owner_group_users')
  })

  it('uuidParamsOf: `:id` is a template id only as the first segment', () => {
    expect(uuidParamsOf('/:id')).toEqual(['id'])
    expect(uuidParamsOf('/:id/versions/:versionId')).toEqual(['id'])
    expect(uuidParamsOf('/owner-group-users/:id')).toEqual([])
    expect(uuidParamsOf('/states/:stateId/skip')).toEqual(['stateId'])
    expect(uuidParamsOf('/instance/:collection/:item/owners/:stateId')).toEqual(['stateId'])
    expect(uuidParamsOf('/transitions/:txId')).toEqual(['txId'])
    expect(uuidParamsOf('/owner-groups/:groupId')).toEqual([])
  })

  it('badUuidParam names the bad param and ignores the others', () => {
    expect(badUuidParam({ id: 'instance-owners' })).toBe('id')
    expect(badUuidParam({ stateId: 'x', other: 'y' })).toBe('stateId')
    expect(badUuidParam({ txId: '590320D5-6249-463A-A63E-349CDA99D73F' })).toBeNull()
    expect(badUuidParam({ collection: 'workflows', item: '1' })).toBeNull()
    expect(badUuidParam(undefined)).toBeNull()
    expect(badUuidParam({ id: '42' }, [])).toBeNull()
  })
})

describe('owners batch picks the record’s own instance (army4 a08-15)', () => {
  it('open beats completed, newest start beats older, one per record', () => {
    const rows = [
      {
        id: 'old',
        item: '1',
        completed_at: new Date('2026-01-01'),
        started_at: new Date('2025-01-01')
      },
      { id: 'open', item: '1', completed_at: null, started_at: new Date('2024-01-01') },
      {
        id: 'a',
        item: '2',
        completed_at: new Date('2026-01-02'),
        started_at: new Date('2025-01-01')
      },
      {
        id: 'b',
        item: '2',
        completed_at: new Date('2026-01-03'),
        started_at: new Date('2026-01-01')
      },
      { id: 'only', item: '3', completed_at: null, started_at: null }
    ]
    expect(pickInstancePerItem(rows).map((r) => r.id)).toEqual(['open', 'b', 'only'])
  })
})

describe('a finished record offers only its escape hatches (army4 a15-7)', () => {
  const canceled = { completed_at: new Date(), current_state: 'S-CANCELED' }
  it('Cancel (from any state) is not offered on a Canceled record; Uncancel is', () => {
    expect(offeredOnCompleted(canceled, { from_state: null })).toBe(false)
    expect(offeredOnCompleted(canceled, { from_state: 's-canceled' })).toBe(true)
    expect(offeredOnCompleted(canceled, { from_state: 'S-OTHER' })).toBe(false)
  })
  it('an open record is unaffected', () => {
    const open = { completed_at: null, current_state: 'S-L1' }
    expect(offeredOnCompleted(open, { from_state: null })).toBe(true)
  })
})
