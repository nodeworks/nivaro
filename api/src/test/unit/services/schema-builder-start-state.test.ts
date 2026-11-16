import { graphql } from 'graphql'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// GraphQL: `create_<c>_item(data:…, start_state:…)` and the Directus batch
// `create_<c>_items(data:[…], start_state:…)` hand the step to createOne
// (2026-11-16). LinX: "create a workflow in a certain state in one mutation".

vi.mock('../../../db/index.js', () => {
  const chain = (): unknown =>
    new Proxy(() => undefined, {
      get(_t, prop) {
        if (prop === 'then') return (res: (v: unknown) => unknown) => Promise.resolve([]).then(res)
        if (prop === 'first') return () => Promise.resolve(undefined)
        return () => chain()
      },
      apply: () => chain()
    })
  const db = Object.assign(() => chain(), { raw: async () => [] })
  return { db, dbRead: db, isMssql: () => true }
})
vi.mock('../../../services/collections.js', async (orig) => ({
  ...(await orig<object>()),
  listCollections: vi.fn(async () => [{ collection: 'workflows', hidden: false }]),
  getFields: vi.fn(async () => [
    { collection: 'workflows', field: 'id', type: 'integer', hidden: false },
    { collection: 'workflows', field: 'name', type: 'string', hidden: false }
  ]),
  getRelations: vi.fn(async () => [])
}))
vi.mock('../../../services/record-instance.js', async (orig) => ({
  ...(await orig<object>()),
  boundCollections: vi.fn(async () => new Set<string>())
}))
const calls = vi.hoisted(() => ({
  create: [] as Array<{ data: Record<string, unknown>; opts: Record<string, unknown> }>,
  rehearse: [] as Array<Record<string, unknown>>
}))
vi.mock('../../../services/items.js', async (orig) => ({
  ...(await orig<object>()),
  createOne: vi.fn(
    async (
      _u: unknown,
      _c: string,
      data: Record<string, unknown>,
      _r: unknown,
      _w: unknown,
      opts: Record<string, unknown>
    ) => {
      calls.create.push({ data: { ...data }, opts: { ...opts } })
      return { id: calls.create.length, name: data.name }
    }
  ),
  rehearseCreate: vi.fn(async (_u: unknown, _c: string, data: Record<string, unknown>) => {
    calls.rehearse.push({ ...data })
    return { dry_run: true, ok: true }
  })
}))

import { buildGraphQLSchema } from '../../../services/schema-builder.js'

const ctx = { user: { id: 'U-1', role: 'R' }, req: { isAdmin: true } }

beforeEach(() => {
  calls.create = []
  calls.rehearse = []
})

describe('GraphQL create mutations take start_state', () => {
  it('create_<c>_item passes start_state to createOne', async () => {
    const schema = await buildGraphQLSchema()
    const res = await graphql({
      schema,
      source:
        'mutation { create_workflows_item(data: {name: "x"}, start_state: "waiting_on_manager_approval") { id } }',
      contextValue: ctx
    })
    expect(res.errors).toBeUndefined()
    expect(calls.create).toHaveLength(1)
    expect(calls.create[0].opts.startState).toBe('waiting_on_manager_approval')
    expect(calls.create[0].opts.callerPayload).toBe(true)
  })

  it('without start_state nothing is passed', async () => {
    const schema = await buildGraphQLSchema()
    await graphql({
      schema,
      source: 'mutation { create_workflows(data: {name: "x"}) { id } }',
      contextValue: ctx
    })
    expect(calls.create[0].opts).not.toHaveProperty('startState')
  })

  it("the batch applies start_state to every row; a row's own $start_state wins", async () => {
    const schema = await buildGraphQLSchema()
    const res = await graphql({
      schema,
      // A `$` key cannot be written inline in GraphQL; variables carry it.
      source:
        'mutation ($rows: JSON!) { create_workflows_items(data: $rows, start_state: "complete") { id } }',
      variableValues: { rows: [{ name: 'a' }, { name: 'b', $start_state: 'review' }] },
      contextValue: ctx
    })
    expect(res.errors).toBeUndefined()
    expect(calls.create.map((c) => c.opts.startState)).toEqual(['complete', undefined])
    expect(calls.create[1].data.$start_state).toBe('review')
  })

  it('the dry run rehearses the step too', async () => {
    const schema = await buildGraphQLSchema()
    await graphql({
      schema,
      source: 'mutation { create_workflows_dry_run(data: {name: "x"}, start_state: "complete") }',
      contextValue: ctx
    })
    expect(calls.rehearse[0]).toEqual({ name: 'x', $start_state: 'complete' })
  })
})
