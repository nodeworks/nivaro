import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Route harness for the overview/explain endpoints: mocked auth + activity and
// a loose knex stand-in — every builder method chains and the builder resolves
// to the table's rows. Only object .where() filters apply, and only on columns
// a row carries (the column filters are checked against the real database;
// these tests pin the wiring and the shapes).

type Row = Record<string, unknown>

const fake = vi.hoisted(() => {
  process.env.LAYOUT_EDIT_WARNING = 'Layouts here are replaced every night from development.'
  const tables: Record<string, Row[]> = {}
  const inserts: Array<{ table: string; rows: Row[] }> = []
  const failInsertInto: { table: string | null } = { table: null }
  let nextId = 500
  const chain = (table: string) => {
    const filters: Row[] = []
    const rows = () =>
      (tables[table] ?? []).filter((r) =>
        filters.every((f) =>
          Object.entries(f).every(([k, v]) => r[k] === undefined || String(r[k]) === String(v))
        )
      )
    const q: Record<string, unknown> = {}
    for (const m of [
      'whereIn',
      'whereNotNull',
      'orWhere',
      'orWhereIn',
      'orWhereNull',
      'orderBy',
      'orderByRaw',
      'select',
      'join',
      'groupBy',
      'count',
      'max'
    ]) {
      q[m] = () => q
    }
    q.where = (f: unknown) => {
      if (f && typeof f === 'object') filters.push(f as Row)
      return q
    }
    q.first = async () => rows()[0]
    q.pluck = async (col: string) => rows().map((r) => r[col])
    q.insert = async (data: Row | Row[]) => {
      if (failInsertInto.table === table) throw new Error(`insert into ${table} failed`)
      const list = (Array.isArray(data) ? data : [data]).map((d) => ({ id: nextId++, ...d }))
      tables[table] = [...(tables[table] ?? []), ...list]
      inserts.push({ table, rows: list })
      return list.map((r) => r.id)
    }
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenables
    q.then = (ok: (r: Row[]) => unknown, fail?: (e: unknown) => unknown) =>
      Promise.resolve(rows()).then(ok, fail)
    return q
  }
  const db = Object.assign((table: string) => chain(table), {
    // Rolls back like a real transaction: a throw restores every table.
    transaction: async (cb: (trx: unknown) => unknown) => {
      const before = JSON.parse(JSON.stringify(tables)) as Record<string, Row[]>
      try {
        return await cb(db)
      } catch (err) {
        for (const k of Object.keys(tables)) delete tables[k]
        Object.assign(tables, before)
        throw err
      }
    }
  })
  const reset = (seed: Record<string, Row[]>) => {
    for (const k of Object.keys(tables)) delete tables[k]
    Object.assign(tables, seed)
    inserts.length = 0
    failInsertInto.table = null
    nextId = 500
  }
  return { db, tables, inserts, reset, failInsertInto }
})

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: { user?: { id: string; role?: string }; isAdmin?: boolean }) => {
    req.user = { id: 'test-user', role: 'user' }
    req.isAdmin = false
  }),
  requireAdmin: vi.fn(async (req: { user?: { id: string; role?: string }; isAdmin?: boolean }) => {
    req.user = { id: 'test-admin', role: 'admin-role' }
    req.isAdmin = true
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async () => true),
  getAllowedFields: vi.fn(async () => null)
}))
vi.mock('../../../db/index.js', () => ({ db: fake.db }))

import { collectionLayoutsRoutes } from '../../../routes/collection-layouts.js'

async function call(method: 'GET' | 'POST', url: string, payload?: Row) {
  const app = Fastify({ logger: false })
  app.register(collectionLayoutsRoutes, { prefix: '/collection-layouts' })
  await app.ready()
  const res = await app.inject({ method, url: `/collection-layouts${url}`, payload })
  await app.close()
  return res
}

// Candidate order as fetchLayoutsForCollection returns it (is_active desc, sort asc).
const layouts: Row[] = [
  { id: 22, name: 'Unit Order', layout_type: 'grouped', is_active: 1, sort: 1, slug: 'inv-unit' },
  {
    id: 30,
    name: 'Ops only',
    layout_type: 'grouped',
    is_active: 0,
    sort: 2,
    slug: 'ops',
    conditions: JSON.stringify({ role_ids: ['ops-role'] })
  },
  {
    id: 24,
    name: 'Sparing Order',
    layout_type: 'grouped',
    is_active: 0,
    sort: 3,
    slug: 'inv-sparing',
    record_conditions: JSON.stringify([{ field: 'is_sparing', op: 'eq', value: true }])
  }
]

beforeEach(() =>
  fake.reset({
    nivaro_collection_layouts: layouts.map((l) => ({ ...l })),
    nivaro_collections: [{ collection: 'inventory_request' }],
    inventory_request: [{ id: 9, is_sparing: true }],
    nivaro_roles: [
      { id: 'ops-role', name: 'Operations', admin_access: false },
      { id: 'admin-role', name: 'Administrator', admin_access: true }
    ]
  })
)

describe('GET /collection-layouts/explain', () => {
  it('resolves a saved record through the /active path and explains each candidate', async () => {
    const res = await call('GET', '/explain?collection=inventory_request&item=9')
    expect(res.statusCode).toBe(200)
    const { data } = JSON.parse(res.body)
    expect(data.layout_id).toBe(24)
    expect(data.reason).toEqual({
      kind: 'record_rule',
      rules: [{ field: 'is_sparing', op: 'eq', value: true }]
    })
    expect(data.checked.map((c: { layout_id: number }) => c.layout_id)).toEqual([22, 30, 24])
    expect(data.checked.find((c: { layout_id: number }) => c.layout_id === 24).matched).toBe(true)
  })

  it('tests as a role: role preference wins with role names', async () => {
    fake.tables.inventory_request = [{ id: 9, is_sparing: false }]
    const res = await call('GET', '/explain?collection=inventory_request&item=9&role_id=ops-role')
    const { data } = JSON.parse(res.body)
    expect(data.layout_id).toBe(30)
    expect(data.reason).toEqual({
      kind: 'role',
      role_ids: ['ops-role'],
      role_names: ['Operations']
    })
  })

  it('404s an unknown role', async () => {
    const res = await call('GET', '/explain?collection=inventory_request&item=9&role_id=nope')
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /collection-layouts/preview-as-role — the live path', () => {
  it('an admin role gets no role preference (the default), as on /active', async () => {
    fake.tables.nivaro_collection_layouts = [
      layouts[0],
      { ...layouts[1], conditions: JSON.stringify({ role_ids: ['admin-role'] }) }
    ]
    const res = await call(
      'GET',
      '/preview-as-role?collection=inventory_request&role_id=admin-role'
    )
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.layout.id).toBe(22)
  })

  it('a plain role gets its role-preference layout', async () => {
    const res = await call('GET', '/preview-as-role?collection=inventory_request&role_id=ops-role')
    expect(JSON.parse(res.body).data.layout.id).toBe(30)
  })
})

describe('GET /collection-layouts/overview', () => {
  it('wraps rows and the edit warning in data', async () => {
    const res = await call('GET', '/overview?collection=inventory_request')
    expect(res.statusCode).toBe(200)
    const { data } = JSON.parse(res.body)
    expect(data.warning).toBe('Layouts here are replaced every night from development.')
    expect(data.rows.map((r: { layout_id: number }) => r.layout_id)).toEqual([24, 30, 22])
    expect(data.rows[1].reason.role_names).toEqual(['Operations'])
  })

  it('400s without a collection', async () => {
    expect((await call('GET', '/overview')).statusCode).toBe(400)
  })
})

describe('POST /collection-layouts seed_fields', () => {
  it('creates a Main section holding every visible, non-system field in field order', async () => {
    fake.reset({
      nivaro_collection_layouts: [],
      nivaro_fields: [
        { field: 'id', hidden: false, type: 'integer' },
        { field: 'title', hidden: false, type: 'string' },
        { field: 'secret', hidden: true, type: 'string' },
        { field: 'divider', hidden: false, type: 'alias', interface: 'presentation-divider' },
        { field: 'lines', hidden: false, type: 'alias', interface: 'list-o2m' },
        { field: 'date_created', hidden: false, type: 'timestamp' }
      ]
    })
    const res = await call('POST', '', {
      collection: 'things',
      name: 'Main form',
      layout_type: 'grouped',
      seed_fields: true
    })
    expect(res.statusCode).toBe(201)
    const layoutId = JSON.parse(res.body).data.id
    const group = fake.inserts.find((i) => i.table === 'nivaro_field_groups')
    expect(group?.rows).toEqual([
      expect.objectContaining({ key: 'main', label: 'Main', type: 'section', layout_id: layoutId })
    ])
    const assigned = fake.inserts
      .filter((i) => i.table === 'nivaro_layout_field_assignments')
      .flatMap((i) => i.rows)
    expect(assigned.map((a) => [a.field, a.group_key, a.sort])).toEqual([
      ['title', 'main', 0],
      ['lines', 'main', 1]
    ])
  })

  it('a failed seed leaves no layout behind (create + seed are one transaction)', async () => {
    fake.reset({
      nivaro_collection_layouts: [],
      nivaro_fields: [{ field: 'title', hidden: false, type: 'string' }]
    })
    fake.failInsertInto.table = 'nivaro_layout_field_assignments'
    const res = await call('POST', '', {
      collection: 'things',
      name: 'Main form',
      seed_fields: true
    })
    expect(res.statusCode).toBe(500)
    expect(fake.tables.nivaro_collection_layouts).toEqual([])
    expect(fake.tables.nivaro_field_groups ?? []).toEqual([])
  })

  it('a seed_fields list places those fields in that order, unknown and pseudo names left out', async () => {
    fake.reset({
      nivaro_collection_layouts: [],
      nivaro_fields: [
        { field: 'title', hidden: false, type: 'string' },
        { field: 'amount', hidden: false, type: 'decimal' },
        { field: 'secret', hidden: true, type: 'string' },
        { field: 'divider', hidden: false, type: 'alias', interface: 'presentation-divider' }
      ]
    })
    const res = await call('POST', '', {
      collection: 'things',
      name: 'From a list',
      seed_fields: ['amount', 'nope', 'divider', 'secret', 'title', 'amount']
    })
    expect(res.statusCode).toBe(201)
    const assigned = fake.inserts
      .filter((i) => i.table === 'nivaro_layout_field_assignments')
      .flatMap((i) => i.rows)
    expect(assigned.map((a) => [a.field, a.sort])).toEqual([
      ['amount', 0],
      ['secret', 1],
      ['title', 2]
    ])
  })

  it('refuses a seed_fields list that is not field names', async () => {
    fake.reset({ nivaro_collection_layouts: [] })
    const res = await call('POST', '', { collection: 'things', name: 'X', seed_fields: [1, 2] })
    expect(res.statusCode).toBe(400)
  })

  it('without seed_fields creates an empty layout', async () => {
    fake.reset({ nivaro_collection_layouts: [] })
    const res = await call('POST', '', { collection: 'things', name: 'Empty' })
    expect(res.statusCode).toBe(201)
    expect(fake.inserts.map((i) => i.table)).toEqual(['nivaro_collection_layouts'])
  })
})
