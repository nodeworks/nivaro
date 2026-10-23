import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { outOfViewPhrase } from '../../../services/access-explain.js'

// A write whose own read-back the writer cannot see (a User Scope or row
// filter hides the record as written) used to answer 201/200 with data null.
// The record form read `data.id`, threw "Cannot read properties of null", the
// links step after the create never ran and the retry made a duplicate
// (workflows 372777/372778, 2026-10-23). Every answer now carries the id and
// says why the record is hidden.

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'BERNARD', role: 'MEMBER' }
    req.isAdmin = false
  }
}))
vi.mock('../../../middleware/workspace.js', () => ({ resolveWorkspace: async () => {} }))
vi.mock('../../../services/idempotency.js', () => ({
  idempotencyPreHandler: () => async () => {}
}))
vi.mock('../../../services/access-explain.js', async (orig) => ({
  ...(await orig<object>()),
  outOfViewReason: vi.fn(async () => 'no Zone set')
}))
const svc = vi.hoisted(() => ({
  createOneReported: vi.fn(),
  updateOne: vi.fn()
}))
vi.mock('../../../services/items.js', async (orig) => ({
  ...(await orig<object>()),
  ...svc
}))

import { itemsRoutes } from '../../../routes/items.js'

async function app() {
  const a = Fastify()
  await a.register(itemsRoutes, { prefix: '/api/items' })
  return a
}

const made = (over: Partial<Record<string, unknown>>) => ({
  item: null,
  id: 372777,
  readable: false,
  linkFailures: [],
  upserted: false,
  ...over
})

beforeEach(() => {
  svc.createOneReported.mockReset()
  svc.updateOne.mockReset()
})

// Shapes the route must answer the same way: the route is generic, the scope
// lives in the service — what differs is only whether the read-back came back.
const SHAPES = [
  { name: 'M2M-scoped (workflows)', collection: 'workflows', body: { divisions: ['4'] } },
  { name: 'M2O-scoped (units)', collection: 'units', body: { zone: 4 } },
  { name: 'O2M child rows (workflows + lines)', collection: 'workflows', body: { lines: [{}] } },
  {
    name: 'M2A (contacts)',
    collection: 'tickets',
    body: { contacts: [{ collection: 'nivaro_users', id: 'U1' }] }
  },
  { name: 'no scopes (notes)', collection: 'notes', body: { title: 'x' } }
]

describe('POST /items/:collection', () => {
  for (const s of SHAPES) {
    it(`${s.name}: hidden from its creator → 201 with the id and the reason`, async () => {
      svc.createOneReported.mockResolvedValue(made({}))
      const res = await (await app()).inject({
        method: 'POST',
        url: `/api/items/${s.collection}`,
        payload: s.body
      })
      expect(res.statusCode).toBe(201)
      expect(res.json()).toEqual({
        data: { id: 372777 },
        meta: { id: 372777, readable: false, reason: 'no Zone set' }
      })
    })
    it(`${s.name}: readable (or an unscoped caller) → the row, as before`, async () => {
      svc.createOneReported.mockResolvedValue(
        made({ item: { id: 1, ...s.body }, id: 1, readable: true })
      )
      const res = await (await app()).inject({
        method: 'POST',
        url: `/api/items/${s.collection}`,
        payload: s.body
      })
      expect(res.statusCode).toBe(201)
      expect(res.json()).toEqual({ data: { id: 1, ...s.body } })
    })
  }

  it('links the create carried that did not land are named', async () => {
    svc.createOneReported.mockResolvedValue(
      made({ item: { id: 1 }, id: 1, readable: true, linkFailures: ['regions: refused'] })
    )
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/items/workflows',
      payload: { regions: ['14'] }
    })
    expect(res.json()).toEqual({ data: { id: 1 }, meta: { link_failures: ['regions: refused'] } })
  })
})

describe('PATCH /items/:collection/:id', () => {
  it('an edit that moves the record out of view → the id and the reason, never data null', async () => {
    svc.updateOne.mockImplementation(async (...args: unknown[]) => {
      const opts = args[6] as { outcome?: Record<string, unknown> } | undefined
      if (opts?.outcome) {
        opts.outcome.id = '55'
        opts.outcome.readable = false
        opts.outcome.linkFailures = []
      }
      return null
    })
    const res = await (await app()).inject({
      method: 'PATCH',
      url: '/api/items/units/55',
      payload: { zone: 4 }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      data: { id: '55' },
      meta: { id: '55', readable: false, reason: 'no Zone set' }
    })
  })

  it('a readable edit answers the row', async () => {
    svc.updateOne.mockResolvedValue({ id: 55, zone: 2 })
    const res = await (await app()).inject({
      method: 'PATCH',
      url: '/api/items/units/55',
      payload: { zone: 2 }
    })
    expect(res.json()).toEqual({ data: { id: 55, zone: 2 } })
  })
})

describe('POST /items/:collection/batch', () => {
  it('a created row its writer cannot read is ok with its id — never "failed"', async () => {
    svc.createOneReported.mockResolvedValue(made({}))
    svc.updateOne.mockResolvedValue(null)
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/items/workflows/batch',
      payload: { create: [{ divisions: ['4'] }], update: [{ id: 9, title: 'x' }] }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { data: { results: unknown[]; ok: number; failed: number } }
    expect(body.data.failed).toBe(0)
    expect(body.data.results).toEqual([
      { op: 'create', index: 0, ok: true, id: 372777, data: { id: 372777 }, readable: false },
      { op: 'update', index: 0, ok: true, id: 9, data: { id: 9 }, readable: false }
    ])
  })
})

describe('outOfViewPhrase', () => {
  it('says what hides the record in a few words', () => {
    expect(
      outOfViewPhrase([
        {
          type: 'scope',
          message: '',
          dimension: 'division',
          dimension_label: 'Zone',
          record_values: []
        }
      ])
    ).toBe('no Zone set')
    expect(
      outOfViewPhrase([
        {
          type: 'scope',
          message: '',
          dimension_label: 'Zone',
          record_values: ['Zone 4']
        },
        { type: 'row_filter', message: '' }
      ])
    ).toBe('its Zone (Zone 4) is not one of yours; a rule on your role hides it')
    expect(outOfViewPhrase([])).toBeNull()
  })
})
