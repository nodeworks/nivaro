import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Army 2026-10-25: /ai/query ran raw knex (every column, no User Scope) and let a relation
// path reach nivaro_users credential columns as a filter oracle; /ai/summarize-changes and
// /ai/review read any record id with a collection-level gate only.

type Row = Record<string, unknown>
const tables = vi.hoisted(
  () =>
    ({
      nivaro_fields: [
        { collection: 'workflows', field: 'id', type: 'integer', note: null },
        { collection: 'workflows', field: 'name', type: 'string', note: null },
        { collection: 'workflows', field: 'creator', type: 'uuid', note: null }
      ],
      nivaro_relations: [
        {
          many_collection: 'workflows',
          many_field: 'creator',
          one_collection: 'nivaro_users',
          one_field: null,
          junction_field: null
        }
      ],
      nivaro_revisions: []
    }) as Record<string, Row[]>
)
const state = vi.hoisted(() => ({
  visible: true,
  readItems: [] as Array<{ collection: string; query: Record<string, unknown> }>
}))

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'PAUL', role: 'APPROVER' }
    req.isAdmin = false
  },
  requireAdmin: async () => {}
}))
vi.mock('../../../services/ai-client.js', () => ({
  cheapClientFor: vi.fn(async () => null),
  describeAiProvider: vi.fn(),
  getAiClient: vi.fn(async () => ({
    messages: { create: vi.fn(async () => ({ content: [{ type: 'text', text: 'Summary' }] })) }
  })),
  getAiModelSettings: vi.fn(async () => ({ model: 'm' }))
}))
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async () => true),
  getAllowedFields: vi.fn(async () => null)
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/items.js', () => ({
  readOne: vi.fn(async (_u: unknown, _c: string, id: string) =>
    state.visible ? { id, name: 'x' } : null
  ),
  readItems: vi.fn(async (_u: unknown, collection: string, query: Record<string, unknown>) => {
    state.readItems.push({ collection, query })
    return { data: [{ id: 1, name: 'x' }], total: 1 }
  })
}))
vi.mock('../../../db/index.js', () => {
  const builder = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    const b: any = {
      where(c: any, v?: unknown) {
        if (c && typeof c === 'object')
          for (const [k, val] of Object.entries(c)) filters.push((r) => r[k] === val)
        else if (typeof c === 'string' && v !== undefined) filters.push((r) => r[c] === v)
        return b
      },
      whereNull(c: string) {
        filters.push((r) => r[c] == null)
        return b
      },
      whereNotNull(c: string) {
        filters.push((r) => r[c] != null)
        return b
      },
      join: () => b,
      orderBy: () => b,
      limit: () => b,
      select: () => b,
      first: async () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))[0],
      columnInfo: async () => ({}),
      // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve((tables[table] ?? []).filter((r) => filters.every((f) => f(r)))).then(
          res,
          rej
        )
    }
    return b
  }
  return { db: Object.assign(builder, { raw: () => '' }) }
})

import { aiFilterToItems, aiRoutes } from '../../../routes/ai.js'

async function post(url: string, payload: unknown) {
  const a = Fastify()
  await a.register(aiRoutes, { prefix: '/api/ai' })
  return a.inject({ method: 'POST', url: `/api/ai${url}`, payload: payload as never })
}

beforeEach(() => {
  state.visible = true
  state.readItems = []
})

describe('/ai/query', () => {
  it('refuses a filter on a credential column through a relation', async () => {
    const res = await post('/query', {
      collection: 'workflows',
      filters: [{ field: 'creator.static_token', op: 'nnull' }]
    })
    expect(res.statusCode).toBe(422)
    expect(state.readItems).toHaveLength(0)
  })

  it('runs an allowed filter through the items service as the caller', async () => {
    tables.nivaro_fields.push({ collection: 'nivaro_users', field: 'email', type: 'string' })
    tables.nivaro_fields.push({ collection: 'nivaro_users', field: 'static_token', type: 'string' })
    const res = await post('/query', {
      collection: 'workflows',
      filters: [{ field: 'creator.email', op: 'eq', value: 'a@b.c' }]
    })
    expect(res.statusCode).toBe(200)
    expect(state.readItems[0]).toMatchObject({
      collection: 'workflows',
      query: { filter: { _and: [{ creator: { email: { _eq: 'a@b.c' } } }] } }
    })
    expect(res.json().total).toBe(1)
    // …while the registered credential column stays out of reach.
    const secret = await post('/query', {
      collection: 'workflows',
      filters: [{ field: 'creator.static_token', op: 'nnull' }]
    })
    expect(secret.statusCode).toBe(422)
  })

  it('aiFilterToItems maps operators', () => {
    expect(aiFilterToItems({ field: 'a', op: 'nnull' })).toEqual({ a: { _nnull: true } })
    expect(aiFilterToItems({ field: 'a', op: 'eq', value: null })).toEqual({ a: { _null: true } })
    expect(aiFilterToItems({ field: 'v.name', op: 'contains', value: 'x' })).toEqual({
      v: { name: { _contains: 'x' } }
    })
  })
})

describe('/ai/summarize-changes and /ai/review', () => {
  it('answer 404 for a record the caller cannot open', async () => {
    state.visible = false
    expect(
      (await post('/summarize-changes', { collection: 'workflows', item: '372542' })).statusCode
    ).toBe(404)
    expect((await post('/review', { collection: 'workflows', item: '372542' })).statusCode).toBe(
      404
    )
  })

  it('run for a record the caller can open', async () => {
    const res = await post('/summarize-changes', { collection: 'workflows', item: '1' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.changes).toBe(0)
  })
})
