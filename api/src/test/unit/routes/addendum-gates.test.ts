import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Addendums (army 2026-10-25): created on records the caller cannot see, on
// any pipeline id they name; the summary listed titles + money of hidden
// records; money and title stayed editable while in review.

const who = vi.hoisted(() => ({ hidden: new Set<string>(), status: 'draft' }))
const inserts = vi.hoisted(() => [] as Array<{ table: string; row: unknown }>)
const updates = vi.hoisted(() => [] as unknown[])

vi.mock('../../../middleware/authenticate.js', () => {
  const set = async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'u-paul', role: 'role-approver' }
    req.isAdmin = false
  }
  return { authenticate: vi.fn(set), requireAdmin: vi.fn(set) }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
vi.mock('../../../services/items.js', () => ({
  readOne: vi.fn(async (_u: unknown, _c: string, id: string) =>
    who.hidden.has(id) ? null : { id }
  )
}))
vi.mock('../../../services/addendum-approve.js', () => ({
  canCreateAddendum: vi.fn(async () => ({ ok: true }))
}))
vi.mock('../../../services/addendum-summary.js', () => ({
  addendumSummaryBatch: vi.fn(
    async (_c: string, ids: string[]) => new Map(ids.map((i) => [i, { total: 1 }]))
  )
}))
vi.mock('../../../services/addendum-lines.js', () => ({
  snapshotAddendumBase: vi.fn(async () => ({})),
  redactAddendumData: vi.fn(async (_u: unknown, _a: unknown, _c: unknown, d: unknown) => d)
}))
vi.mock('../../../services/addendum-render.js', () => ({
  storeAddendumImpact: vi.fn(async () => {})
}))
vi.mock('../../../services/queue-materialization.js', () => ({
  syncAddendumInQueues: vi.fn(async () => {})
}))
vi.mock('../../../services/record-events.js', () => ({
  announceAddendumChange: vi.fn(async () => {})
}))
vi.mock('../../../services/workflow-transitions.js', () => ({
  emitWorkflowStartEvent: vi.fn(async () => {})
}))
vi.mock('../../../services/instance-start.js', () => ({ writeStartHistory: vi.fn(async () => {}) }))
vi.mock('../../../services/record-access.js', () => ({
  compileAccessGates: vi.fn(async () => ({})),
  visibleIds: vi.fn(
    async (_g: unknown, ids: string[]) => new Set(ids.filter((i) => !who.hidden.has(i)))
  )
}))
vi.mock('../../../db/index.js', () => ({
  db: vi.fn((t: string) => {
    const rows: Record<string, unknown[]> = {
      nivaro_collections: [{ addendum_start_states: null }],
      nivaro_collection_layouts: [{ workflow_template_id: 'TPL-ADD' }],
      nivaro_addendums: [
        {
          id: 3,
          created_by: 'u-paul',
          status: who.status,
          parent_collection: 'workflows',
          parent_id: '1'
        }
      ]
    }
    const r = rows[t] ?? []
    const c: Record<string, unknown> = {}
    for (const m of ['where', 'whereNotNull', 'join', 'select', 'orderBy']) c[m] = vi.fn(() => c)
    c.first = vi.fn(async () => r[0])
    c.insert = vi.fn((row: unknown) => {
      inserts.push({ table: t, row })
      return { returning: vi.fn(async () => [{ id: 3 }]) }
    })
    c.update = vi.fn(async (row: unknown) => {
      updates.push(row)
      return 1
    })
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
    c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(r).then(res, rej)
    return c
  })
}))

import { addendumsRoutes } from '../../../routes/addendums.js'
import { addendumSummaryBatch } from '../../../services/addendum-summary.js'

async function call(method: 'POST' | 'PATCH', url: string, payload: unknown) {
  const app = Fastify({ logger: false })
  await app.register(addendumsRoutes)
  return app.inject({ method, url, payload: payload as object })
}

beforeEach(() => {
  who.hidden.clear()
  who.status = 'draft'
  inserts.length = 0
  updates.length = 0
  vi.clearAllMocks()
})

const create = { parent_collection: 'workflows', parent_id: '1', title: 'Close out' }

describe('POST / (create)', () => {
  it('404s a parent record the caller cannot see and writes nothing', async () => {
    who.hidden.add('1')
    expect((await call('POST', '/', create)).statusCode).toBe(404)
    expect(inserts).toHaveLength(0)
  })
  it('refuses a pipeline the collection does not run addendums on', async () => {
    const res = await call('POST', '/', { ...create, workflow_template_id: 'TPL-ANY' })
    expect(res.statusCode).toBe(400)
    expect(inserts).toHaveLength(0)
  })
  it('refuses a non-number cost impact', async () => {
    expect((await call('POST', '/', { ...create, cost_impact: 'lots' })).statusCode).toBe(400)
  })
  it('creates on a visible record with its configured pipeline', async () => {
    const res = await call('POST', '/', {
      ...create,
      workflow_template_id: 'tpl-add',
      cost_impact: -42950.88
    })
    expect(res.statusCode).toBe(201)
    expect(inserts.some((i) => i.table === 'nivaro_addendums')).toBe(true)
  })
})

describe('POST /summary', () => {
  it('answers only for records the caller can see', async () => {
    who.hidden.add('372542')
    const res = await call('POST', '/summary', { collection: 'workflows', ids: ['1', '372542'] })
    expect(res.statusCode).toBe(200)
    expect(vi.mocked(addendumSummaryBatch).mock.calls[0][1]).toEqual(['1'])
    expect(Object.keys(JSON.parse(res.body).data)).toEqual(['1'])
  })
})

describe('PATCH /:id', () => {
  it('freezes the money figure once the addendum is in review', async () => {
    who.status = 'review'
    const res = await call('PATCH', '/3', { cost_impact: -1 })
    expect(res.statusCode).toBe(409)
    expect(updates).toHaveLength(0)
  })
  it('lets the author edit a draft', async () => {
    const res = await call('PATCH', '/3', { title: 'Close out — revised', cost_impact: -10 })
    expect(res.statusCode).toBe(200)
    expect(updates[0]).toMatchObject({ title: 'Close out — revised', cost_impact: -10 })
  })
})
