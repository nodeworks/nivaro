import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

const fake = vi.hoisted(() => {
  const tables: Record<string, Row[]> = {}
  let nextId = 500
  const match = (r: Row, w: Row) => Object.entries(w).every(([k, v]) => String(r[k]) === String(v))
  const q = (table: string) => {
    const wheres: Row[] = []
    let ids: unknown[] | null = null
    const rows = () =>
      (tables[table] ?? []).filter(
        (r) =>
          wheres.every((w) => match(r, w)) && (!ids || ids.some((i) => String(i) === String(r.id)))
      )
    const api: Record<string, unknown> = {
      where(w: Row) {
        wheres.push(w)
        return api
      },
      whereIn(_c: string, v: unknown[]) {
        ids = v
        return api
      },
      select() {
        return api
      },
      orderBy() {
        return api
      },
      first: async () => rows()[0],
      delete: async () => {
        const drop = new Set(rows())
        tables[table] = (tables[table] ?? []).filter((r) => !drop.has(r))
      },
      update: async (p: Row) => {
        for (const r of rows()) Object.assign(r, p)
      },
      insert: async (p: Row) => {
        tables[table] = tables[table] ?? []
        tables[table].push({ id: nextId++, ...p })
      },
      then: (res: (v: Row[]) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(rows().map((r) => ({ ...r }))).then(res, rej)
    }
    return api
  }
  const db = Object.assign((t: string) => q(t), {
    transaction: async (cb: (t: unknown) => unknown) => cb(db)
  })
  const reset = (init: Record<string, Row[]>) => {
    for (const k of Object.keys(tables)) delete tables[k]
    for (const [k, v] of Object.entries(init)) tables[k] = v.map((r) => ({ ...r }))
  }
  return { db, tables, reset }
})

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async () => {}),
  requireAdmin: vi.fn(async (req: { user?: { id: string }; isAdmin?: boolean }) => {
    req.user = { id: 'test-admin' }
    req.isAdmin = true
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../db/index.js', () => ({ db: fake.db }))
vi.mock('../../../services/layout-versions.js', () => ({
  snapshotLayoutVersion: vi.fn(async () => {}),
  restoreLayoutVersion: vi.fn(async () => {})
}))

import { collectionLayoutsRoutes } from '../../../routes/collection-layouts.js'
import { fieldGroupsRoutes } from '../../../routes/field-groups.js'
import { snapshotLayoutVersion } from '../../../services/layout-versions.js'

async function call(method: 'PUT' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const app = Fastify({ logger: false })
  app.register(collectionLayoutsRoutes, { prefix: '/collection-layouts' })
  app.register(fieldGroupsRoutes, { prefix: '/field-groups' })
  await app.ready()
  const res = await app.inject({ method, url, payload: payload as Record<string, unknown> })
  await app.close()
  return res
}

const asg = (id: number, field: string, group_key: string | null, sort = 0): Row => ({
  id,
  layout_id: 1,
  field,
  group_key,
  sort
})
const stored = () => fake.tables.nivaro_layout_field_assignments

beforeEach(() => {
  vi.mocked(snapshotLayoutVersion).mockClear()
  fake.reset({
    nivaro_collection_layouts: [{ id: 1, collection: 'c' }],
    nivaro_field_groups: [{ id: 9, layout_id: 1, collection: 'c', key: 'main', sort: 0 }],
    nivaro_layout_field_assignments: []
  })
})

describe('PUT /collection-layouts/:id/assignments', () => {
  it('keeps a field placed in two groups', async () => {
    const res = await call('PUT', '/collection-layouts/1/assignments', {
      assignments: [
        { field: 'order_number', group_key: '__header__', sort: 0 },
        { field: 'order_number', group_key: 'main', sort: 1 }
      ]
    })
    expect(res.statusCode).toBe(200)
    expect(
      stored()
        .map((r) => [r.field, r.group_key])
        .sort()
    ).toEqual([
      ['order_number', '__header__'],
      ['order_number', 'main']
    ])
  })

  it('keeps __ext_* placements the payload repeats', async () => {
    fake.tables.nivaro_layout_field_assignments = [asg(1, '__ext_a', null), asg(2, 'x', 'main')]
    await call('PUT', '/collection-layouts/1/assignments', {
      assignments: [
        { field: '__ext_a', group_key: null, sort: 0 },
        { field: 'x', group_key: 'main', sort: 1 }
      ]
    })
    expect(
      stored()
        .map((r) => r.id)
        .sort()
    ).toEqual([1, 2])
  })

  it('deletes only (field,group_key) pairs that left', async () => {
    fake.tables.nivaro_layout_field_assignments = [asg(1, 'f', '__header__'), asg(2, 'f', 'main')]
    await call('PUT', '/collection-layouts/1/assignments', {
      assignments: [{ field: 'f', group_key: 'main', sort: 3 }]
    })
    expect(stored()).toHaveLength(1)
    expect(stored()[0]).toMatchObject({ id: 2, group_key: 'main', sort: 3 })
  })
})

describe('field-group writes snapshot the layout first', () => {
  it('POST', async () => {
    await call('POST', '/field-groups', {
      collection: 'c',
      key: 'g2',
      label: 'G2',
      type: 'section',
      layout_id: 1
    })
    expect(snapshotLayoutVersion).toHaveBeenCalledWith(
      1,
      expect.any(String),
      'test-admin',
      expect.anything()
    )
  })
  it('PATCH', async () => {
    await call('PATCH', '/field-groups/9', { label: 'New' })
    expect(snapshotLayoutVersion).toHaveBeenCalledWith(
      1,
      expect.any(String),
      'test-admin',
      expect.anything()
    )
  })
  it('DELETE', async () => {
    await call('DELETE', '/field-groups/9')
    expect(snapshotLayoutVersion).toHaveBeenCalledWith(
      1,
      expect.any(String),
      'test-admin',
      expect.anything()
    )
  })
  it('reorder', async () => {
    await call('POST', '/field-groups/reorder', { collection: 'c', order: [{ id: 9, sort: 2 }] })
    expect(snapshotLayoutVersion).toHaveBeenCalledWith(
      1,
      expect.any(String),
      'test-admin',
      expect.anything()
    )
  })
})
