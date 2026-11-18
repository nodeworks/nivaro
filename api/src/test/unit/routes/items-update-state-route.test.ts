import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// REST: move a record to a named step on an update — body `$state` or `?state=` on
// PATCH /items/:c/:id and `$state` per row of POST /items/:c/batch; the answer's
// meta.state says what happened (services/update-state.ts, 2026-11-18).

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'U-LINX', role: 'R-INTEGRATION' }
    req.isAdmin = false
  },
  requireAdmin: async () => {}
}))
vi.mock('../../../middleware/workspace.js', () => ({ resolveWorkspace: async () => {} }))
vi.mock('../../../services/idempotency.js', () => ({
  idempotencyPreHandler: () => async () => {}
}))
vi.mock('../../../services/activity.js', async (orig) => ({
  ...(await orig<object>()),
  logActivity: vi.fn(async () => null)
}))
vi.mock('../../../services/item-lock-guard.js', async (orig) => ({
  ...(await orig<object>()),
  editLockRefusal: vi.fn(async () => null)
}))
vi.mock('../../../services/coedit-fields.js', () => ({ onlySharedText: async () => false }))
vi.mock('../../../services/permissions.js', async (orig) => ({
  ...(await orig<object>()),
  can: vi.fn(async () => true)
}))
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
  return { db, dbRead: db }
})
const svc = vi.hoisted(() => ({
  updates: [] as Array<{ id: string; data: Record<string, unknown> }>,
  state: null as Record<string, unknown> | null,
  refuse: null as null | Error
}))
vi.mock('../../../services/items.js', async (orig) => ({
  ...(await orig<object>()),
  updateOne: vi.fn(
    async (
      _u: unknown,
      _c: string,
      id: string,
      data: Record<string, unknown>,
      _r: unknown,
      _w: unknown,
      opts?: { outcome?: Record<string, unknown> }
    ) => {
      svc.updates.push({ id, data: { ...data } })
      if (svc.refuse) throw svc.refuse
      if (svc.state && opts?.outcome) opts.outcome.state = svc.state
      return { id: Number(id), name: 'x' }
    }
  )
}))

import { itemsRoutes } from '../../../routes/items.js'
import { UpdateStateRefusal } from '../../../services/update-state.js'

async function app() {
  const a = Fastify()
  await a.register(itemsRoutes, { prefix: '/api/items' })
  return a
}

const MOVED = {
  moved: true,
  target: { key: 'canceled', label: 'Canceled' },
  from: { key: 'manager_approval', label: 'Manager Approval' },
  to: { key: 'canceled', label: 'Canceled' },
  transition: { id: 'T-CANCEL', label: 'Cancel Workflow' }
}

beforeEach(() => {
  svc.updates = []
  svc.state = null
  svc.refuse = null
})

describe('PATCH /items/:collection/:id with a step', () => {
  it('passes the body $state through and answers meta.state', async () => {
    svc.state = MOVED
    const res = await (await app()).inject({
      method: 'PATCH',
      url: '/api/items/workflows/373049',
      payload: { cancel_reason: 'Duplicate', $state: 'canceled' }
    })
    expect(res.statusCode).toBe(200)
    expect(svc.updates[0].data).toEqual({ cancel_reason: 'Duplicate', $state: 'canceled' })
    expect(res.json().meta).toEqual({ state: MOVED })
  })

  it('reads ?state= (and ?state_comment=) into the body', async () => {
    const res = await (await app()).inject({
      method: 'PATCH',
      url: '/api/items/workflows/373049?state=canceled&state_comment=per%20LinX',
      payload: { name: 'x' }
    })
    expect(res.statusCode).toBe(200)
    expect(svc.updates[0].data).toEqual({
      name: 'x',
      $state: 'canceled',
      $state_comment: 'per LinX'
    })
    // Nothing moved here: no meta at all.
    expect(res.json()).not.toHaveProperty('meta')
  })

  it('?state= with no body at all is a step change alone', async () => {
    await (await app()).inject({
      method: 'PATCH',
      url: '/api/items/workflows/373049?state=canceled'
    })
    expect(svc.updates[0].data).toEqual({ $state: 'canceled' })
  })

  it("the body's own $state wins over the query", async () => {
    await (await app()).inject({
      method: 'PATCH',
      url: '/api/items/workflows/373049?state=open',
      payload: { $state: 'canceled' }
    })
    expect(svc.updates[0].data.$state).toBe('canceled')
  })

  it('a refusal answers with its status, code and details — never a 500', async () => {
    svc.refuse = new UpdateStateRefusal(
      409,
      'NO_TRANSITION',
      'No move takes this record from "Draft" to "Canceled".',
      { value: 'canceled', current: 'draft', target: 'canceled' }
    )
    const res = await (await app()).inject({
      method: 'PATCH',
      url: '/api/items/workflows/373049',
      payload: { $state: 'canceled' }
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({
      code: 'NO_TRANSITION',
      message: 'No move takes this record from "Draft" to "Canceled".'
    })
  })

  it('a move that did not happen after the save: 200 with the fields, meta.state says why', async () => {
    svc.state = {
      moved: false,
      target: { key: 'canceled', label: 'Canceled' },
      status: 422,
      fields_saved: true,
      error:
        'Cancel Workflow did not go through. The record was not moved (your other changes were saved): Fusion refused'
    }
    const res = await (await app()).inject({
      method: 'PATCH',
      url: '/api/items/workflows/373049',
      payload: { name: 'x', $state: 'canceled' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().meta.state).toMatchObject({ moved: false, fields_saved: true })
  })
})

describe('POST /items/:collection/batch rows with a step', () => {
  it("each row's $state reaches its update and its result carries state", async () => {
    svc.state = MOVED
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/items/workflows/batch',
      payload: { update: [{ id: 373049, $state: 'canceled' }] }
    })
    expect(res.statusCode).toBe(200)
    expect(svc.updates[0].data).toEqual({ $state: 'canceled' })
    expect(res.json().data.results[0]).toMatchObject({ ok: true, state: MOVED })
  })
})

describe('review round 3: REST surfaces', () => {
  it('bulk-update refuses $state / _state: moves go through bulk-transition', async () => {
    for (const key of ['$state', '_state']) {
      const res = await (await app()).inject({
        method: 'POST',
        url: '/api/items/workflows/bulk-update',
        payload: { ids: [1, 2], data: { [key]: 'canceled' } }
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ code: 'STATE_NOT_ALLOWED_HERE' })
      expect(res.json().error).toContain('bulk-transition')
    }
    expect(svc.updates).toHaveLength(0)
  })

  it('the batch route: a refused row keeps its status, code and requirements (rowError)', async () => {
    svc.refuse = new UpdateStateRefusal(
      422,
      'TRANSITION_REQUIREMENTS',
      'Moving to "Canceled" needs information this record does not have yet: Cancel reason.',
      { requirements: [{ type: 'record_fields', title: 'Cancel reason' }] }
    )
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/items/workflows/batch',
      payload: { update: [{ id: 1, $state: 'canceled' }] }
    })
    expect(res.json().data.results[0]).toMatchObject({
      ok: false,
      status: 422,
      code: 'TRANSITION_REQUIREMENTS',
      requirements: [{ type: 'record_fields', title: 'Cancel reason' }]
    })
  })

  const REFUSED_AFTER = {
    result: 'refused_after_write',
    moved: false,
    target: { key: 'canceled', label: 'Canceled' },
    status: 422,
    code: 'TRANSITION_REFUSED',
    reason: 'Fusion refused',
    fields_saved: true,
    error:
      'Cancel Workflow did not go through. The record was not moved (your other changes were saved): Fusion refused'
  }

  it('the batch route: fields saved, move refused = a refused row with the move’s code and reason', async () => {
    svc.state = REFUSED_AFTER
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/items/workflows/batch',
      payload: { update: [{ id: 1, name: 'x', $state: 'canceled' }] }
    })
    expect(res.json().data.results[0]).toMatchObject({
      ok: false,
      status: 422,
      code: 'TRANSITION_REFUSED',
      error: REFUSED_AFTER.error,
      state: { result: 'refused_after_write', fields_saved: true }
    })
  })

  it('the bulk route: fields saved, move refused = a non-200 row with the move’s code and reason', async () => {
    svc.state = REFUSED_AFTER
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/items/workflows/bulk',
      payload: { rows: [{ id: 1, name: 'x', $state: 'canceled' }] }
    })
    const body = res.json()
    const row = body.data?.results?.[0] ?? body.results?.[0]
    expect({ status: res.statusCode, body }).toMatchObject({ status: 207 })
    expect(row).toMatchObject({
      status: 422,
      code: 'TRANSITION_REFUSED',
      error: REFUSED_AFTER.error,
      state: { result: 'refused_after_write' }
    })
  })
})
