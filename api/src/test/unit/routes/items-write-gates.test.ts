import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Routes beside the items service that read or wrote rows raw (army v3,
// 2026-10-25): /distinct listed values of rows outside the caller's Zones,
// clone copied any row by id, resolve-paths named related records the caller
// could not open, and draft-publish wrote `_status` on any row.

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'U-PAUL', role: 'APPROVER' }
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
const raw = vi.hoisted(() => ({ tables: [] as string[] }))
vi.mock('../../../db/index.js', () => {
  const chain = (): unknown =>
    new Proxy(() => undefined, {
      get(_t, prop) {
        if (prop === 'then')
          return (res: (v: unknown) => unknown) => Promise.resolve([{ ok: 1 }]).then(res)
        if (prop === 'first') return () => Promise.resolve(undefined)
        return () => chain()
      },
      apply: () => chain()
    })
  const db = Object.assign(
    (table: string) => {
      raw.tables.push(table)
      return chain()
    },
    { raw: async () => [{ ok: 1 }] }
  )
  return { db, dbRead: db }
})
vi.mock('../../../services/permissions.js', async (orig) => ({
  ...(await orig<object>()),
  can: vi.fn(async () => true),
  getAllowedFields: vi.fn(async () => null)
}))
vi.mock('../../../services/collections.js', async (orig) => ({
  ...(await orig<object>()),
  getCollection: vi.fn(async (c: string) => ({ collection: c })),
  getFields: vi.fn(async () => [
    { field: 'name', special: null, readonly: false },
    { field: 'creator', special: ['user-created'], readonly: false },
    { field: 'line_total', special: null, readonly: true }
  ]),
  getRelations: vi.fn(async (c: string) =>
    c === 'workflow_line_items'
      ? [
          {
            many_collection: 'workflow_line_items',
            many_field: 'workflow',
            one_collection: 'workflows',
            junction_field: null
          }
        ]
      : c === 'workflows'
        ? [
            {
              many_collection: 'workflow_line_items',
              many_field: 'workflow',
              one_collection: 'workflows',
              one_field: 'line_items',
              junction_field: null
            }
          ]
        : []
  )
}))
vi.mock('../../../services/auto-ids.js', async (orig) => ({
  ...(await orig<object>()),
  autoIdFieldsFor: vi.fn(async () => [])
}))
const paths = vi.hoisted(() => ({ ids: ['W-SEEN'] as string[] }))
vi.mock('../../../services/queues.js', async (orig) => ({
  ...(await orig<object>()),
  resolvePathValues: vi.fn(async (_c: string, ids: string[]) => {
    return new Map(ids.map((id) => [id, { value: 'CR27-1', ids: paths.ids }]))
  })
}))
const svc = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  readable: ['W-SEEN'] as string[],
  aggregate: vi.fn(async () => ({
    data: [{ group: { org_code: 'A' } }, { group: { org_code: 'B' } }],
    total: 2,
    limit: 200,
    offset: 0
  })),
  created: [] as Array<Record<string, unknown>>,
  updated: [] as Array<{ id: string; data: Record<string, unknown> }>
}))
vi.mock('../../../services/items.js', async (orig) => ({
  ...(await orig<object>()),
  readOne: vi.fn(async () => svc.row),
  readItems: vi.fn(
    async (_u: unknown, _c: string, q: { filter?: { id?: { _in?: string[] } } }) => ({
      data: (q.filter?.id?._in ?? [])
        .filter((id) => svc.readable.includes(id))
        .map((id) => ({ id }))
    })
  ),
  aggregateItems: svc.aggregate,
  createOneReported: vi.fn(async (_u: unknown, _c: string, data: Record<string, unknown>) => {
    svc.created.push(data)
    return { id: 99, item: { id: 99 }, readable: true, linkFailures: [], upserted: false }
  }),
  updateOne: vi.fn(async (_u: unknown, _c: string, id: string, data: Record<string, unknown>) => {
    svc.updated.push({ id, data })
    return { id }
  })
}))

// Someone else holds the form lock of record HELD.
vi.mock('../../../services/item-lock-guard.js', async (orig) => ({
  ...(await orig<object>()),
  editLockRefusal: vi.fn(async (_r: unknown, _c: string, id: string) =>
    id === 'HELD'
      ? {
          status: 409,
          body: {
            error: 'Kim is editing this record — your changes were not saved.',
            code: 'RECORD_LOCKED'
          }
        }
      : null
  )
}))

import { draftPublishRoutes } from '../../../routes/draft-publish.js'
import { itemsRoutes } from '../../../routes/items.js'
import { getAllowedFields } from '../../../services/permissions.js'

async function app() {
  const a = Fastify()
  await a.register(itemsRoutes, { prefix: '/api/items' })
  await a.register(draftPublishRoutes, { prefix: '/api/draft-publish' })
  return a
}

beforeEach(() => {
  raw.tables = []
  svc.row = null
  svc.readable = ['W-SEEN']
  svc.created = []
  svc.updated = []
  svc.aggregate.mockClear()
  paths.ids = ['W-SEEN']
})

describe('GET /items/:collection/distinct', () => {
  it('lists values through the scoped aggregate, never a raw table read', async () => {
    const res = await (await app()).inject({
      method: 'GET',
      url: '/api/items/workflows/distinct?field=org_code'
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual(['A', 'B'])
    expect(svc.aggregate).toHaveBeenCalledTimes(1)
    expect(raw.tables).not.toContain('workflows')
  })
})

describe('POST /items/:collection/:id/clone', () => {
  it('a record the caller cannot read is a 404 and nothing is created', async () => {
    svc.row = null
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/items/workflow_line_items/474938/clone',
      payload: { field_overrides: { workflow: 5 } }
    })
    expect(res.statusCode).toBe(404)
    expect(svc.created).toEqual([])
  })

  it('a readable record is copied through the create, without its server-set fields', async () => {
    svc.row = { id: 7, name: 'Line', creator: 'U-OTHER', line_total: 12 }
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/items/workflow_line_items/7/clone',
      payload: {}
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().data).toEqual({ id: 99 })
    expect(svc.created).toEqual([{ name: 'Line' }])
  })
})

describe('resolve-paths', () => {
  it('drops a value naming a related record the caller cannot open', async () => {
    svc.row = { id: 1 }
    paths.ids = ['W-HIDDEN']
    const res = await (await app()).inject({
      method: 'GET',
      url: '/api/items/workflow_line_items/1/resolve-paths?paths=workflow.name'
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({})
  })

  it('keeps a value naming a readable related record', async () => {
    svc.row = { id: 1 }
    const res = await (await app()).inject({
      method: 'GET',
      url: '/api/items/workflow_line_items/1/resolve-paths?paths=workflow.name'
    })
    expect(Object.keys(res.json().data)).toEqual(['workflow.name'])
  })

  it('checks the segments after a to-many hop against that collection field list', async () => {
    svc.row = { id: 1 }
    vi.mocked(getAllowedFields).mockImplementation(async (_u, _a, c) =>
      c === 'workflow_line_items' ? ['id', 'workflow', 'name'] : null
    )
    try {
      const refused = await (await app()).inject({
        method: 'GET',
        url: '/api/items/workflows/1/resolve-paths?paths=line_items.secret_note'
      })
      expect(refused.json().data).toEqual({})
      const allowed = await (await app()).inject({
        method: 'GET',
        url: '/api/items/workflows/1/resolve-paths?paths=line_items.name'
      })
      expect(Object.keys(allowed.json().data)).toEqual(['line_items.name'])
    } finally {
      vi.mocked(getAllowedFields).mockImplementation(async () => null)
    }
  })
})

describe('draft-publish', () => {
  it('a record the caller cannot read is a 404 and nothing is written', async () => {
    svc.row = null
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/draft-publish/articles/5/publish'
    })
    expect(res.statusCode).toBe(404)
    expect(svc.updated).toEqual([])
    expect(raw.tables).not.toContain('articles')
  })

  it('a readable record is published through the items service as the caller', async () => {
    svc.row = { id: 5 }
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/draft-publish/articles/5/unpublish'
    })
    expect(res.statusCode).toBe(200)
    expect(svc.updated).toEqual([{ id: '5', data: { _status: 'draft' } }])
  })
})

describe('batch and bulk updates honour the record edit lock', () => {
  it('a row someone else holds is refused; the others are written', async () => {
    const a = await app()
    const batch = await a.inject({
      method: 'POST',
      url: '/api/items/workflows/batch',
      payload: {
        update: [
          { id: 'HELD', name: 'x' },
          { id: 'FREE', name: 'y' }
        ]
      }
    })
    const results = batch.json().data.results as Array<{ id?: string; ok: boolean; error?: string }>
    expect(results[0]).toMatchObject({ ok: false, error: expect.stringContaining('editing') })
    expect(results[1]).toMatchObject({ ok: true, id: 'FREE' })

    const bulk = await a.inject({
      method: 'POST',
      url: '/api/items/workflows/bulk',
      payload: { rows: [{ id: 'HELD', name: 'x' }] }
    })
    expect(bulk.json().data.results[0]).toMatchObject({ status: 409, code: 'RECORD_LOCKED' })
    expect(svc.updated.map((u) => u.id)).toEqual(['FREE'])
  })
})
