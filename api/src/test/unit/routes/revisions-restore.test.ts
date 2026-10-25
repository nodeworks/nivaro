import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Restores (O2M restore, whole-snapshot rollback) write AS THE CALLER through
// the items service — field policy, edit lock, approval lock, hooks — and
// O2M restore never takes free-form rows from a non-admin.
const s = vi.hoisted(() => ({
  isAdmin: false,
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  updatable: true
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'cj', role: 'R' }
    req.isAdmin = s.isAdmin
  }
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async () => true),
  getAllowedFields: vi.fn(async () => null)
}))
vi.mock('../../../services/revision-access.js', () => ({
  o2mParentCollection: vi.fn(async () => 'workflows'),
  o2mParentVisibleTo: vi.fn(async () => true),
  recordVisibleTo: vi.fn(async () => true)
}))
const lock = vi.hoisted(() => ({ assertNotEditLocked: vi.fn(async () => {}) }))
vi.mock('../../../services/edit-lock.js', () => lock)
vi.mock('../../../services/collections.js', () => ({
  getFields: vi.fn(async () => [
    { field: 'id', type: 'integer', special: null },
    { field: 'workflow', type: 'integer', special: null },
    { field: 'amount', type: 'decimal', special: null },
    { field: 'vendor', type: 'string', special: null, readonly: true },
    { field: 'changed', type: 'timestamp', special: ['date-updated'] }
  ])
}))
const items = vi.hoisted(() => ({
  canUpdateItem: vi.fn(async () => s.updatable),
  createOne: vi.fn(async () => ({})),
  deleteOne: vi.fn(async () => {}),
  updateOne: vi.fn(async () => ({}))
}))
vi.mock('../../../services/items.js', () => items)
vi.mock('../../../db/index.js', () => ({
  db: vi.fn((table: string) => {
    const rows = () => s.tables[table.split(' ')[0]] ?? []
    const c: Record<string, unknown> = {}
    for (const m of ['where', 'whereIn', 'whereRaw', 'join', 'select', 'orderBy']) c[m] = () => c
    c.first = async () => rows()[0]
    c.pluck = async (col: string) => rows().map((r) => r[col])
    c.update = async () => {
      throw new Error('raw write')
    }
    c.delete = async () => {
      throw new Error('raw delete')
    }
    // biome-ignore lint/suspicious/noThenProperty: knex builders are awaitable
    c.then = (res: (v: unknown) => unknown) => Promise.resolve(rows()).then(res)
    return c
  })
}))

import { revisionsRoutes } from '../../../routes/revisions.js'

async function post(url: string, payload: Record<string, unknown> = {}) {
  const app = Fastify({ logger: false })
  await app.register(revisionsRoutes, { prefix: '/revisions' })
  return app.inject({ method: 'POST', url: `/revisions${url}`, payload })
}

const restore = { collection: 'workflow_line_items', many_field: 'workflow', parent_id: '100' }

describe('O2M restore', () => {
  beforeEach(() => {
    s.isAdmin = false
    s.updatable = true
    for (const f of Object.values(items)) f.mockClear()
    lock.assertNotEditLocked.mockReset()
    s.tables = {
      workflow_line_items: [
        { id: 1, workflow: 100, amount: 5 },
        { id: 2, workflow: 100, amount: 9 }
      ],
      nivaro_revisions: [
        {
          item_id: '1',
          action: 'update',
          timestamp: '2026-10-01',
          data: JSON.stringify({ id: 1, workflow: 100, amount: 7, changed: 'then' })
        },
        {
          item_id: '3',
          action: 'update',
          timestamp: '2026-10-01',
          data: JSON.stringify({ id: 3, workflow: 100, amount: 4, vendor: 'v' })
        }
      ]
    }
  })

  it('refuses free-form rows from a non-admin, a record they may not change, and a locked record', async () => {
    const rows = await post('/o2m-restore', { ...restore, rows: [{ amount: 1e9 }] })
    expect(rows.statusCode).toBe(403)
    s.updatable = false
    expect(
      (await post('/o2m-restore', { ...restore, target_timestamp: '2026-10-02' })).statusCode
    ).toBe(403)
    s.updatable = true
    lock.assertNotEditLocked.mockRejectedValueOnce(
      Object.assign(new Error('This record is at Level 1'), {
        statusCode: 403,
        code: 'EDIT_LOCKED'
      })
    )
    expect(
      (await post('/o2m-restore', { ...restore, target_timestamp: '2026-10-02' })).statusCode
    ).toBe(403)
    expect(items.deleteOne).not.toHaveBeenCalled()
    expect(items.createOne).not.toHaveBeenCalled()
  })

  it('rebuilds the rows on the server and writes them through the items service', async () => {
    const res = await post('/o2m-restore', { ...restore, target_timestamp: '2026-10-02' })
    expect(res.statusCode).toBe(200)
    expect(items.deleteOne).toHaveBeenCalledWith(
      expect.anything(),
      'workflow_line_items',
      '2',
      expect.anything(),
      undefined
    )
    expect(items.updateOne).toHaveBeenCalledWith(
      expect.anything(),
      'workflow_line_items',
      '1',
      { amount: 7 },
      expect.anything(),
      undefined
    )
    // re-created without its id; the readonly vendor is not the caller's to set
    expect(items.createOne).toHaveBeenCalledWith(
      expect.anything(),
      'workflow_line_items',
      { amount: 4, workflow: '100' },
      expect.anything(),
      undefined
    )
    expect(res.json().data).toMatchObject({
      created: 1,
      updated: 1,
      deleted: 1,
      skipped_fields: ['vendor']
    })
  })
})

describe('whole-snapshot rollback', () => {
  beforeEach(() => {
    s.isAdmin = false
    for (const f of Object.values(items)) f.mockReset()
    s.tables = {
      nivaro_revisions: [
        {
          id: 5,
          activity: 50,
          data: JSON.stringify({ id: 1, amount: 3, vendor: 'old', changed: 'x' })
        }
      ],
      nivaro_activity: [{ id: 50, collection: 'workflow_line_items', item: '1' }],
      workflow_line_items: [{ id: 1, amount: 9, vendor: 'new' }]
    }
  })

  it('applies only the changed fields the caller may write, through updateOne', async () => {
    const res = await post('/5/rollback')
    expect(res.statusCode).toBe(200)
    expect(items.updateOne).toHaveBeenCalledWith(
      expect.anything(),
      'workflow_line_items',
      '1',
      { amount: 3 },
      expect.anything(),
      undefined
    )
    expect(res.json().data.skipped_fields).toEqual(['vendor'])
  })

  it('answers the items service refusal (approval edit lock) and writes nothing raw', async () => {
    items.updateOne.mockRejectedValueOnce(
      Object.assign(new Error('This record is at Level 1'), {
        statusCode: 403,
        code: 'EDIT_LOCKED'
      })
    )
    expect((await post('/5/rollback')).statusCode).toBe(403)
  })
})
