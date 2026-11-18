import { graphql } from 'graphql'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// GraphQL: `update_<c>_item(id, data, state)` — and `data._state`, what LinX sends —
// hand the step to updateOne (services/update-state.ts, 2026-11-18). Refusals are
// errors with extensions.code; a move that failed after the save is STATE_NOT_MOVED.

const m = vi.hoisted(() => ({ bound: true }))
vi.mock('../../../db/index.js', () => {
  const chain = (table: string): unknown =>
    new Proxy(() => undefined, {
      get(_t, prop) {
        if (prop === 'then') return (res: (v: unknown) => unknown) => Promise.resolve([]).then(res)
        if (prop === 'first')
          return () =>
            Promise.resolve(
              table === 'nivaro_workflow_bindings' && m.bound ? { template: 'T-WF' } : undefined
            )
        return () => chain(table)
      },
      apply: () => chain(table)
    })
  const db = Object.assign((t: string) => chain(t), { raw: async () => [] })
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
vi.mock('../../../services/graphql-strict.js', async (orig) => ({
  ...(await orig<object>()),
  graphqlStrictMutations: async () => false
}))
const calls = vi.hoisted(() => ({
  update: [] as Array<{ id: string; data: Record<string, unknown>; opts: Record<string, unknown> }>,
  outcomeState: null as Record<string, unknown> | null,
  refuse: null as Error | null
}))
vi.mock('../../../services/items.js', async (orig) => ({
  ...(await orig<object>()),
  readOne: vi.fn(async (_u: unknown, _c: string, id: string) => ({ id: Number(id), name: 'old' })),
  updateOne: vi.fn(
    async (
      _u: unknown,
      _c: string,
      id: string,
      data: Record<string, unknown>,
      _r: unknown,
      _w: unknown,
      opts: Record<string, unknown> & { outcome?: Record<string, unknown> }
    ) => {
      calls.update.push({ id, data: { ...data }, opts: { ...opts } })
      if (calls.refuse) throw calls.refuse
      if (calls.outcomeState && opts.outcome) opts.outcome.state = calls.outcomeState
      return { id: Number(id), name: data.name ?? 'x' }
    }
  )
}))

import { buildGraphQLSchema } from '../../../services/schema-builder.js'
import { UpdateStateRefusal } from '../../../services/update-state.js'

const ctx = { user: { id: 'U-LINX', role: 'R' }, req: { isAdmin: false } }

beforeEach(() => {
  m.bound = true
  calls.update = []
  calls.outcomeState = null
  calls.refuse = null
})

async function run(source: string, variableValues?: Record<string, unknown>) {
  return graphql({ schema: await buildGraphQLSchema(), source, contextValue: ctx, variableValues })
}

describe('GraphQL update mutations take a step', () => {
  it('update_<c>_item(state:) passes it to updateOne', async () => {
    const res = await run(
      'mutation { update_workflows_item(id: 373049, data: {name: "x"}, state: "canceled", state_comment: "per LinX") { id } }'
    )
    expect(res.errors).toBeUndefined()
    expect(calls.update[0].opts).toMatchObject({
      callerPayload: true,
      state: 'canceled',
      stateComment: 'per LinX'
    })
  })

  it('data._state (what LinX sends) is the same thing, and never reaches the write as a field', async () => {
    const res = await run(
      'mutation { update_workflows_item(id: 373049, data: { _state: "canceled" }) { id } }'
    )
    expect(res.errors).toBeUndefined()
    expect(calls.update[0].opts.state).toBe('canceled')
    expect(calls.update[0].data).toEqual({})
  })

  it('state and data._state naming different steps → 400 STATE_CONFLICT, nothing written', async () => {
    const res = await run(
      'mutation { update_workflows_item(id: 373049, data: { _state: "open" }, state: "canceled") { id } }'
    )
    expect(res.errors?.[0].extensions).toMatchObject({ code: 'STATE_CONFLICT', status: 400 })
    expect(calls.update).toHaveLength(0)
  })

  it('without a step nothing is passed', async () => {
    await run('mutation { update_workflows_item(id: 1, data: {name: "x"}) { id } }')
    expect(calls.update[0].opts).not.toHaveProperty('state')
  })

  it('on a collection that runs no pipeline, _state stays the field it always was', async () => {
    m.bound = false
    await run('mutation { update_workflows_item(id: 1, data: { _state: "x" }) { id } }')
    expect(calls.update[0].opts).not.toHaveProperty('state')
    expect(calls.update[0].data).toEqual({ _state: 'x' })
  })

  it('a refusal is an error with extensions.code (never a 500)', async () => {
    calls.refuse = new UpdateStateRefusal(
      403,
      'TRANSITION_OWNER_REQUIRED',
      'Only the owner of Manager Approval can make this move.',
      { current: 'manager_approval', target: 'canceled', meta: { transition: { id: 'T' } } }
    )
    const res = await run(
      'mutation { update_workflows_item(id: 373049, data: {}, state: "canceled") { id } }'
    )
    expect(res.errors?.[0].message).toBe('Only the owner of Manager Approval can make this move.')
    expect(res.errors?.[0].extensions).toMatchObject({
      code: 'TRANSITION_OWNER_REQUIRED',
      status: 403,
      current: 'manager_approval',
      target: 'canceled'
    })
  })

  it('a move that failed after the save is STATE_NOT_MOVED, fields_saved', async () => {
    calls.outcomeState = {
      moved: false,
      target: { key: 'canceled', label: 'Canceled' },
      from: { key: 'manager_approval', label: 'Manager Approval' },
      status: 422,
      code: 'TRANSITION_REFUSED',
      fields_saved: true,
      error:
        'Cancel Workflow did not go through. The record was not moved (your other changes were saved): Fusion refused'
    }
    const res = await run(
      'mutation { update_workflows_item(id: 373049, data: {name: "x"}, state: "canceled") { id } }'
    )
    expect(res.errors?.[0].extensions).toMatchObject({
      code: 'STATE_NOT_MOVED',
      status: 422,
      meta: { fields_saved: true, reason_code: 'TRANSITION_REFUSED' }
    })
  })

  it('the step it already stands in answers the record (no error)', async () => {
    calls.outcomeState = {
      moved: false,
      already: true,
      target: { key: 'canceled', label: 'Canceled' }
    }
    const res = await run(
      'mutation { update_workflows_item(id: 1, data: {}, state: "canceled") { id } }'
    )
    expect(res.errors).toBeUndefined()
    expect(res.data).toEqual({ update_workflows_item: { id: '1' } })
  })

  it('update_<c>_items applies state to every record; update_<c>_batch rows carry their own', async () => {
    const many = await run(
      'mutation { update_workflows_items(ids: [1, 2], data: {name: "x"}, state: "canceled") { id } }'
    )
    expect(many.errors).toBeUndefined()
    expect(calls.update.map((c) => c.opts.state)).toEqual(['canceled', 'canceled'])
    calls.update = []
    const batch = await run(
      'mutation ($rows: JSON!) { update_workflows_batch(data: $rows) { id } }',
      {
        rows: [
          { id: 1, name: 'a', _state: 'canceled' },
          { id: 2, name: 'b' }
        ]
      }
    )
    expect(batch.errors).toBeUndefined()
    expect(calls.update.map((c) => c.opts.state)).toEqual(['canceled', undefined])
  })

  it('a batch refused part-way names the records it already moved (moves are not undone)', async () => {
    let n = 0
    const items = await import('../../../services/items.js')
    vi.mocked(items.updateOne).mockImplementation((async (
      _u: unknown,
      _c: string,
      id: string,
      data: Record<string, unknown>,
      _r: unknown,
      _w: unknown,
      opts: { outcome?: Record<string, unknown> }
    ) => {
      calls.update.push({ id, data: { ...data }, opts: { ...opts } })
      n++
      if (n === 3)
        throw new UpdateStateRefusal(403, 'TRANSITION_OWNER_REQUIRED', 'Only the owner may.')
      if (opts.outcome && (opts as { state?: unknown }).state)
        opts.outcome.state = { result: 'moved', moved: true, target: { key: 'canceled' } }
      return { id: Number(id) }
    }) as never)
    const res = await run(
      'mutation { update_workflows_items(ids: [11, 12, 13], data: {}, state: "canceled") { id } }'
    )
    expect(res.errors?.[0].message).toContain(
      'records already moved to another step stay there: 11, 12'
    )
    expect(res.errors?.[0].extensions).toMatchObject({
      code: 'TRANSITION_OWNER_REQUIRED',
      meta: { moved_ids: ['11', '12'] }
    })
  })
})
