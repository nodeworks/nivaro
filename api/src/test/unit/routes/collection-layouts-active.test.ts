import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Same route-harness idiom as review-list-render.test.ts: mock auth so routes
// don't need real sessions.
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: { user?: { id: string; role?: string }; isAdmin?: boolean }) => {
    req.user = { id: 'test-user', role: 'user' }
    req.isAdmin = false
  }),
  requireAdmin: vi.fn(async (req: { user?: { id: string }; isAdmin?: boolean }) => {
    req.user = { id: 'test-admin' }
    req.isAdmin = true
  })
}))

vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { db } from '../../../db/index.js'
import { authenticate } from '../../../middleware/authenticate.js'
import {
  collectionLayoutsRoutes,
  matchesRecordConditions
} from '../../../routes/collection-layouts.js'

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(collectionLayoutsRoutes, { prefix: '/collection-layouts' })
  return app
}

afterEach(() => vi.clearAllMocks())

// ─── matchesRecordConditions (pure helper) ─────────────────────────────────

describe('matchesRecordConditions', () => {
  it('matches eq via String coercion (number stored, string on record and vice versa)', () => {
    expect(
      matchesRecordConditions([{ field: 'workflow_type', op: 'eq', value: 2 }], {
        workflow_type: '2'
      })
    ).toBe(true)
    expect(
      matchesRecordConditions([{ field: 'workflow_type', op: 'eq', value: '2' }], {
        workflow_type: 2
      })
    ).toBe(true)
    expect(
      matchesRecordConditions([{ field: 'workflow_type', op: 'eq', value: 2 }], {
        workflow_type: 1
      })
    ).toBe(false)
  })

  it('matches neq as the inverse of eq', () => {
    expect(
      matchesRecordConditions([{ field: 'workflow_type', op: 'neq', value: 2 }], {
        workflow_type: 1
      })
    ).toBe(true)
    expect(
      matchesRecordConditions([{ field: 'workflow_type', op: 'neq', value: 2 }], {
        workflow_type: 2
      })
    ).toBe(false)
  })

  it('matches nnull on raw != null, regardless of value', () => {
    expect(matchesRecordConditions([{ field: 'region', op: 'nnull' }], { region: 'west' })).toBe(
      true
    )
    expect(matchesRecordConditions([{ field: 'region', op: 'nnull' }], { region: null })).toBe(
      false
    )
    expect(matchesRecordConditions([{ field: 'region', op: 'nnull' }], {})).toBe(false)
  })

  it('requires EVERY rule to match', () => {
    const rules = [
      { field: 'workflow_type', op: 'eq' as const, value: 2 },
      { field: 'region', op: 'eq' as const, value: 'west' }
    ]
    expect(matchesRecordConditions(rules, { workflow_type: 2, region: 'west' })).toBe(true)
    expect(matchesRecordConditions(rules, { workflow_type: 2, region: 'east' })).toBe(false)
  })
})

// ─── GET /collection-layouts/active — selection precedence ────────────────

function makeActiveDbMock(opts: {
  slugRow?: Record<string, unknown>
  layouts: Record<string, unknown>[]
  records?: Record<string, Record<string, unknown>>
  groups?: unknown[]
  assignments?: unknown[]
}) {
  return vi.fn((table: string) => {
    if (table === 'nivaro_collection_layouts') {
      return {
        where: vi.fn((cond: Record<string, unknown>) => {
          if ('slug' in cond) {
            return { first: vi.fn(() => Promise.resolve(opts.slugRow)) }
          }
          return { orderByRaw: vi.fn(() => Promise.resolve(opts.layouts)) }
        })
      }
    }
    if (table === 'nivaro_field_groups') {
      return { where: vi.fn(() => ({ orderBy: vi.fn(() => Promise.resolve(opts.groups ?? [])) })) }
    }
    if (table === 'nivaro_layout_field_assignments') {
      return {
        where: vi.fn(() => ({
          select: vi.fn(() => ({ orderBy: vi.fn(() => Promise.resolve(opts.assignments ?? [])) }))
        }))
      }
    }
    // Dynamic item-record lookup, e.g. table === 'workflows'.
    return {
      where: vi.fn((cond: Record<string, unknown>) => ({
        first: vi.fn(() => Promise.resolve(opts.records?.[String(cond.id)]))
      }))
    }
  })
}

async function getActive(query: Record<string, string>) {
  const app = buildApp()
  await app.ready()
  const qs = new URLSearchParams(query).toString()
  return app.inject({ method: 'GET', url: `/collection-layouts/active?${qs}` })
}

describe('GET /collection-layouts/active — record-condition precedence', () => {
  it('record-condition layout beats both role-condition and default when it matches', async () => {
    const defaultLayout = {
      id: 3,
      is_active: 1,
      sort: 0,
      conditions: null,
      record_conditions: null,
      default_values: null
    }
    const roleLayout = {
      id: 1,
      is_active: 0,
      sort: 1,
      conditions: JSON.stringify({ role_ids: ['user'] }),
      record_conditions: null,
      default_values: null
    }
    const recordLayout = {
      id: 2,
      is_active: 0,
      sort: 2,
      conditions: null,
      record_conditions: JSON.stringify([{ field: 'workflow_type', op: 'eq', value: 2 }]),
      default_values: null
    }

    vi.mocked(db).mockImplementation(
      makeActiveDbMock({
        layouts: [defaultLayout, roleLayout, recordLayout],
        records: { w1: { id: 'w1', workflow_type: 2 } }
      }) as unknown as typeof db
    )

    const res = await getActive({ collection: 'workflows', item: 'w1' })
    expect(res.statusCode).toBe(200)
    expect((JSON.parse(res.body).data.layout as { id: number }).id).toBe(2)
  })

  it('role-condition layout wins over default when the record does not match', async () => {
    const defaultLayout = {
      id: 3,
      is_active: 1,
      sort: 0,
      conditions: null,
      record_conditions: null,
      default_values: null
    }
    const roleLayout = {
      id: 1,
      is_active: 0,
      sort: 1,
      conditions: JSON.stringify({ role_ids: ['user'] }),
      record_conditions: null,
      default_values: null
    }
    const recordLayout = {
      id: 2,
      is_active: 0,
      sort: 2,
      conditions: null,
      record_conditions: JSON.stringify([{ field: 'workflow_type', op: 'eq', value: 2 }]),
      default_values: null
    }

    vi.mocked(db).mockImplementation(
      makeActiveDbMock({
        layouts: [defaultLayout, roleLayout, recordLayout],
        records: { w1: { id: 'w1', workflow_type: 1 } }
      }) as unknown as typeof db
    )

    const res = await getActive({ collection: 'workflows', item: 'w1' })
    expect(res.statusCode).toBe(200)
    expect((JSON.parse(res.body).data.layout as { id: number }).id).toBe(1)
  })

  it('a non-matching conditional layout is excluded from the fallback pool even when is_active', async () => {
    const recordLayout = {
      id: 2,
      is_active: 1,
      sort: 0,
      conditions: null,
      record_conditions: JSON.stringify([{ field: 'workflow_type', op: 'eq', value: 2 }]),
      default_values: null
    }
    const plainLayout = {
      id: 3,
      is_active: 0,
      sort: 1,
      conditions: null,
      record_conditions: null,
      default_values: null
    }

    vi.mocked(db).mockImplementation(
      makeActiveDbMock({
        layouts: [recordLayout, plainLayout],
        records: { w1: { id: 'w1', workflow_type: 1 } }
      }) as unknown as typeof db
    )

    const res = await getActive({ collection: 'workflows', item: 'w1' })
    expect(res.statusCode).toBe(200)
    expect((JSON.parse(res.body).data.layout as { id: number }).id).toBe(3)
  })

  it('among matching conditional layouts, more rules (more specific) wins', async () => {
    const oneRule = {
      id: 1,
      is_active: 0,
      sort: 0,
      conditions: null,
      record_conditions: JSON.stringify([{ field: 'workflow_type', op: 'eq', value: 2 }]),
      default_values: null
    }
    const twoRules = {
      id: 2,
      is_active: 0,
      sort: 1,
      conditions: null,
      record_conditions: JSON.stringify([
        { field: 'workflow_type', op: 'eq', value: 2 },
        { field: 'region', op: 'eq', value: 'west' }
      ]),
      default_values: null
    }

    vi.mocked(db).mockImplementation(
      makeActiveDbMock({
        layouts: [oneRule, twoRules],
        records: { w1: { id: 'w1', workflow_type: 2, region: 'west' } }
      }) as unknown as typeof db
    )

    const res = await getActive({ collection: 'workflows', item: 'w1' })
    expect(res.statusCode).toBe(200)
    expect((JSON.parse(res.body).data.layout as { id: number }).id).toBe(2)
  })

  it('ties in rule-count break by is_active desc, sort asc (DB order)', async () => {
    const lower = {
      id: 1,
      is_active: 0,
      sort: 0,
      conditions: null,
      record_conditions: JSON.stringify([{ field: 'workflow_type', op: 'eq', value: 2 }]),
      default_values: null
    }
    const higher = {
      id: 2,
      is_active: 1,
      sort: 1,
      conditions: null,
      record_conditions: JSON.stringify([{ field: 'workflow_type', op: 'eq', value: 2 }]),
      default_values: null
    }

    vi.mocked(db).mockImplementation(
      makeActiveDbMock({
        // Already DB-ordered by is_active desc, sort asc: `higher` first.
        layouts: [higher, lower],
        records: { w1: { id: 'w1', workflow_type: 2 } }
      }) as unknown as typeof db
    )

    const res = await getActive({ collection: 'workflows', item: 'w1' })
    expect(res.statusCode).toBe(200)
    expect((JSON.parse(res.body).data.layout as { id: number }).id).toBe(2)
  })

  it('unknown item id falls through as if no item was supplied (no 404)', async () => {
    const defaultLayout = {
      id: 3,
      is_active: 1,
      sort: 0,
      conditions: null,
      record_conditions: null,
      default_values: null
    }
    const recordLayout = {
      id: 2,
      is_active: 0,
      sort: 1,
      conditions: null,
      record_conditions: JSON.stringify([{ field: 'workflow_type', op: 'eq', value: 2 }]),
      default_values: null
    }

    vi.mocked(db).mockImplementation(
      makeActiveDbMock({
        layouts: [defaultLayout, recordLayout],
        records: {} // 'missing' not found
      }) as unknown as typeof db
    )

    const res = await getActive({ collection: 'workflows', item: 'missing' })
    expect(res.statusCode).toBe(200)
    expect((JSON.parse(res.body).data.layout as { id: number }).id).toBe(3)
  })

  it('no item, no slug (legacy path): behaves exactly as before, conditional layouts excluded', async () => {
    const defaultLayout = {
      id: 3,
      is_active: 1,
      sort: 0,
      conditions: null,
      record_conditions: null,
      default_values: null
    }
    const roleLayout = {
      id: 1,
      is_active: 0,
      sort: 1,
      conditions: JSON.stringify({ role_ids: ['user'] }),
      record_conditions: null,
      default_values: null
    }
    const recordLayout = {
      id: 2,
      is_active: 0,
      sort: 2,
      conditions: null,
      record_conditions: JSON.stringify([{ field: 'workflow_type', op: 'eq', value: 2 }]),
      default_values: null
    }

    vi.mocked(db).mockImplementation(
      makeActiveDbMock({
        layouts: [defaultLayout, roleLayout, recordLayout]
      }) as unknown as typeof db
    )

    const res = await getActive({ collection: 'workflows' })
    expect(res.statusCode).toBe(200)
    expect((JSON.parse(res.body).data.layout as { id: number }).id).toBe(1)
  })

  it('slug pin is unaffected by item / record-condition matching', async () => {
    const slugLayout = {
      id: 9,
      slug: 'pub-request',
      is_active: 0,
      sort: 5,
      conditions: null,
      record_conditions: null,
      default_values: null
    }
    const recordLayout = {
      id: 2,
      is_active: 0,
      sort: 1,
      conditions: null,
      record_conditions: JSON.stringify([{ field: 'workflow_type', op: 'eq', value: 2 }]),
      default_values: null
    }

    vi.mocked(db).mockImplementation(
      makeActiveDbMock({
        slugRow: slugLayout,
        layouts: [recordLayout],
        records: { w1: { id: 'w1', workflow_type: 2 } }
      }) as unknown as typeof db
    )

    const res = await getActive({ collection: 'workflows', slug: 'pub-request', item: 'w1' })
    expect(res.statusCode).toBe(200)
    expect((JSON.parse(res.body).data.layout as { id: number }).id).toBe(9)
  })

  it('admins bypass role conditions but conditional exclusion + record match still apply', async () => {
    vi.mocked(authenticate).mockImplementationOnce(async (req: unknown) => {
      const r = req as { user?: { id: string; role?: string }; isAdmin?: boolean }
      r.user = { id: 'admin-1', role: 'admin-role' }
      r.isAdmin = true
    })
    const defaultLayout = {
      id: 3,
      is_active: 1,
      sort: 0,
      conditions: null,
      record_conditions: null,
      default_values: null
    }
    const recordLayout = {
      id: 2,
      is_active: 0,
      sort: 1,
      conditions: null,
      record_conditions: JSON.stringify([{ field: 'workflow_type', op: 'eq', value: 2 }]),
      default_values: null
    }

    vi.mocked(db).mockImplementation(
      makeActiveDbMock({
        layouts: [defaultLayout, recordLayout],
        records: { w1: { id: 'w1', workflow_type: 2 } }
      }) as unknown as typeof db
    )

    const res = await getActive({ collection: 'workflows', item: 'w1' })
    expect(res.statusCode).toBe(200)
    expect((JSON.parse(res.body).data.layout as { id: number }).id).toBe(2)
  })

  it('parses record_conditions and default_values in the response like conditions', async () => {
    const recordLayout = {
      id: 2,
      is_active: 0,
      sort: 0,
      conditions: null,
      record_conditions: JSON.stringify([{ field: 'workflow_type', op: 'eq', value: 2 }]),
      default_values: JSON.stringify({ workflow_type: 2 })
    }

    vi.mocked(db).mockImplementation(
      makeActiveDbMock({
        layouts: [recordLayout],
        records: { w1: { id: 'w1', workflow_type: 2 } }
      }) as unknown as typeof db
    )

    const res = await getActive({ collection: 'workflows', item: 'w1' })
    expect(res.statusCode).toBe(200)
    const layout = JSON.parse(res.body).data.layout as {
      record_conditions: unknown
      default_values: unknown
    }
    expect(layout.record_conditions).toEqual([{ field: 'workflow_type', op: 'eq', value: 2 }])
    expect(layout.default_values).toEqual({ workflow_type: 2 })
  })
})

// ─── PATCH /collection-layouts/:id — validation + round-trip ──────────────

function makePatchDbMock(existing: Record<string, unknown>, updated: Record<string, unknown>) {
  let firstCalls = 0
  const update = vi.fn(() => Promise.resolve(1))
  return vi.fn((table: string) => {
    if (table !== 'nivaro_collection_layouts') throw new Error(`unexpected table: ${table}`)
    return {
      where: vi.fn(() => ({
        first: vi.fn(() => {
          firstCalls++
          return Promise.resolve(firstCalls === 1 ? existing : updated)
        }),
        update
      }))
    }
  })
}

async function patchLayout(id: number, payload: Record<string, unknown>) {
  const app = buildApp()
  await app.ready()
  return app.inject({ method: 'PATCH', url: `/collection-layouts/${id}`, payload })
}

describe('PATCH /collection-layouts/:id — record_conditions validation', () => {
  const existing = {
    id: 1,
    collection: 'workflows',
    conditions: null,
    record_conditions: null,
    default_values: null
  }

  it('400s when record_conditions is not an array', async () => {
    vi.mocked(db).mockImplementation(makePatchDbMock(existing, existing) as unknown as typeof db)
    const res = await patchLayout(1, { record_conditions: { field: 'x' } })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/record_conditions/)
  })

  it('400s naming the index when field is not a valid identifier', async () => {
    vi.mocked(db).mockImplementation(makePatchDbMock(existing, existing) as unknown as typeof db)
    const res = await patchLayout(1, { record_conditions: [{ field: '1bad', op: 'eq', value: 2 }] })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/record_conditions\[0\]\.field/)
  })

  it('400s naming the index when op is invalid', async () => {
    vi.mocked(db).mockImplementation(makePatchDbMock(existing, existing) as unknown as typeof db)
    const res = await patchLayout(1, {
      record_conditions: [{ field: 'workflow_type', op: 'gt', value: 2 }]
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/record_conditions\[0\]\.op/)
  })

  it('400s naming the index when value is missing for eq', async () => {
    vi.mocked(db).mockImplementation(makePatchDbMock(existing, existing) as unknown as typeof db)
    const res = await patchLayout(1, { record_conditions: [{ field: 'workflow_type', op: 'eq' }] })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/record_conditions\[0\]\.value/)
  })

  it('does not require value for nnull', async () => {
    const updated = {
      ...existing,
      record_conditions: JSON.stringify([{ field: 'workflow_type', op: 'nnull' }])
    }
    vi.mocked(db).mockImplementation(makePatchDbMock(existing, updated) as unknown as typeof db)
    const res = await patchLayout(1, {
      record_conditions: [{ field: 'workflow_type', op: 'nnull' }]
    })
    expect(res.statusCode).toBe(200)
  })

  it('round-trips a valid record_conditions array as parsed JSON', async () => {
    const rules = [{ field: 'workflow_type', op: 'eq', value: 2 }]
    const updated = { ...existing, record_conditions: JSON.stringify(rules) }
    vi.mocked(db).mockImplementation(makePatchDbMock(existing, updated) as unknown as typeof db)
    const res = await patchLayout(1, { record_conditions: rules })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.record_conditions).toEqual(rules)
  })

  it('null clears record_conditions', async () => {
    const withRules = {
      ...existing,
      record_conditions: JSON.stringify([{ field: 'x', op: 'nnull' }])
    }
    const updated = { ...existing, record_conditions: null }
    vi.mocked(db).mockImplementation(makePatchDbMock(withRules, updated) as unknown as typeof db)
    const res = await patchLayout(1, { record_conditions: null })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.record_conditions).toBeNull()
  })
})

describe('PATCH /collection-layouts/:id — default_values validation', () => {
  const existing = {
    id: 1,
    collection: 'workflows',
    conditions: null,
    record_conditions: null,
    default_values: null
  }

  it('400s when default_values is not a plain object', async () => {
    vi.mocked(db).mockImplementation(makePatchDbMock(existing, existing) as unknown as typeof db)
    const res = await patchLayout(1, { default_values: [1, 2] })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/default_values/)
  })

  it('400s naming the bad key when a key is not a valid identifier', async () => {
    vi.mocked(db).mockImplementation(makePatchDbMock(existing, existing) as unknown as typeof db)
    const res = await patchLayout(1, { default_values: { '1bad': 2 } })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/default_values.*1bad/)
  })

  it('round-trips a valid default_values object as parsed JSON', async () => {
    const values = { workflow_type: 2 }
    const updated = { ...existing, default_values: JSON.stringify(values) }
    vi.mocked(db).mockImplementation(makePatchDbMock(existing, updated) as unknown as typeof db)
    const res = await patchLayout(1, { default_values: values })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.default_values).toEqual(values)
  })

  it('null clears default_values', async () => {
    const withValues = { ...existing, default_values: JSON.stringify({ x: 1 }) }
    const updated = { ...existing, default_values: null }
    vi.mocked(db).mockImplementation(makePatchDbMock(withValues, updated) as unknown as typeof db)
    const res = await patchLayout(1, { default_values: null })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.default_values).toBeNull()
  })
})
