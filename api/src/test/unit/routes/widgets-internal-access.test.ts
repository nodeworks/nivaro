import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Record-slot widgets (POST /widgets-internal/:id/render) read AS THE CALLER: a sign-in is
// required, stat / list / toggle / item_field bindings go through the items service, and a
// widget naming a field the caller cannot read refuses.
const auth = vi.hoisted(() => ({ signedIn: true }))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    if (auth.signedIn) req.user = { id: 'caller', role: 'R' }
    req.isAdmin = false
  }),
  requireAdmin: vi.fn(async () => {})
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))

const access = vi.hoisted(() => ({
  assertHostReadable: vi.fn(async () => {}),
  assertWidgetFieldsReadable: vi.fn(async () => {}),
  assertLookupReadable: vi.fn(async () => {}),
  readableIds: vi.fn(async (_u: unknown, _c: string, ids: unknown[]) => ids),
  readOneAs: vi.fn(async () => null as Record<string, unknown> | null)
}))
vi.mock('../../../services/widget-access.js', () => access)

const items = vi.hoisted(() => ({
  readItems: vi.fn(async () => ({ data: [{ id: 1, title: 'mine' }], total: 1 })),
  aggregateItems: vi.fn(async () => ({ data: [{ group: {}, sum: { amount: 42 } }] }))
}))
vi.mock('../../../services/items.js', () => items)

const widgets = vi.hoisted(() => new Map<number, Record<string, unknown>>())
const fixture = vi.hoisted(() => ({ relatedCollection: 'projects' }))
const scope = vi.hoisted(() => ({ applyScopeParams: vi.fn(async () => {}) }))
vi.mock('../../../services/custom-query-scope.js', () => scope)
vi.mock('../../../db/index.js', () => ({
  db: vi.fn((table: string) => {
    const c: Record<string, unknown> = {}
    let id = 0
    c.where = vi.fn((w: { id?: number; many_collection?: string }) => {
      id = Number(w?.id ?? 0)
      return c
    })
    c.whereNull = vi.fn(() => c)
    c.whereNotNull = vi.fn(() => c)
    c.first = vi.fn(async () =>
      table === 'nivaro_widgets'
        ? widgets.get(id)
        : table === 'nivaro_relations'
          ? { one_collection: fixture.relatedCollection }
          : table === 'nivaro_custom_queries'
            ? {
                id: 9,
                slug: 'spend',
                access: 'authenticated',
                sql_text: 'SELECT 1',
                scope_params: '{"zone":{"dimension":"zone"}}',
                cache_ttl: 0
              }
            : undefined
    )
    c.pluck = vi.fn(async () => ['name'])
    return c
  })
}))

import { widgetsInternalRoutes } from '../../../routes/widgets-internal.js'

let nextId = 100
function widget(type: string, config: Record<string, unknown>): number {
  const id = nextId++
  widgets.set(id, { id, widget_type: type, config: JSON.stringify(config) })
  return id
}

async function render(id: number, body: Record<string, unknown> = {}) {
  const app = Fastify({ logger: false })
  app.register(widgetsInternalRoutes, { prefix: '/widgets-internal' })
  await app.ready()
  return app.inject({ method: 'POST', url: `/widgets-internal/${id}/render`, payload: body })
}

afterEach(() => {
  vi.clearAllMocks()
  auth.signedIn = true
  fixture.relatedCollection = 'projects'
})

describe('POST /widgets-internal/:id/render reads as the caller', () => {
  it('needs a sign-in', async () => {
    auth.signedIn = false
    const res = await render(widget('list', { collection: 'orders', fields: ['title'] }))
    expect(res.statusCode).toBe(401)
    expect(items.readItems).not.toHaveBeenCalled()
  })

  it('list rows come from readItems as the caller', async () => {
    const id = widget('list', {
      collection: 'orders',
      fields: ['title'],
      filters: { zone: { _eq: '{{zone}}' } },
      order_field: 'title',
      order_dir: 'desc'
    })
    const res = await render(id, { inputs: { zone: '1' } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.rows).toEqual([{ id: 1, title: 'mine' }])
    expect(items.readItems).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'caller' }),
      'orders',
      expect.objectContaining({
        fields: ['title'],
        filter: { _and: [{ zone: { _eq: '1' } }] },
        sort: ['-title']
      })
    )
  })

  it('a stat aggregate goes through aggregateItems as the caller', async () => {
    const id = widget('stat', { collection: 'orders', field: 'amount', aggregation: 'sum' })
    const res = await render(id)
    expect(JSON.parse(res.body).data.value).toBe(42)
    expect(items.aggregateItems).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'caller' }),
      'orders',
      expect.objectContaining({ aggregate: { sum: ['amount'] } })
    )
  })

  it('a single-record stat reads the record as the caller (none visible → null)', async () => {
    const id = widget('stat', {
      collection: 'orders',
      field: 'amount',
      aggregation: 'none',
      id_input: 'id'
    })
    const res = await render(id, { inputs: { id: 7 } })
    expect(JSON.parse(res.body).data.value).toBeNull()
    expect(access.readOneAs).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'caller' }),
      'orders',
      7,
      ['amount']
    )
  })

  it('a widget naming a field the caller cannot read refuses', async () => {
    access.assertWidgetFieldsReadable.mockRejectedValueOnce(
      Object.assign(new Error('You do not have access to "amount"'), { statusCode: 403 })
    )
    const res = await render(widget('stat', { collection: 'orders', field: 'amount' }))
    expect(res.statusCode).toBe(403)
    expect(items.aggregateItems).not.toHaveBeenCalled()
  })

  it('item_field bindings read the related record as the caller', async () => {
    access.readOneAs.mockResolvedValueOnce({ id: 5, name: 'Visible project' })
    const id = widget('stat', { collection: 'orders', field: 'amount', aggregation: 'sum' })
    await render(id, {
      item_collection: 'orders',
      draft: { project: 5 },
      bindings: [{ key: 'project_name', binding_type: 'item_field', binding_value: 'project.name' }]
    })
    expect(access.readOneAs).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'caller' }),
      'projects',
      5,
      ['name']
    )
  })
})

describe('system tables and raw SQL scope (F1, F2)', () => {
  it('a widget over a system table is refused', async () => {
    for (const [type, config] of [
      ['stat', { collection: 'nivaro_settings', field: 'smtp_pass' }],
      ['list', { collection: 'nivaro_users', fields: ['static_token'] }],
      [
        'review_list',
        { collection: 'nivaro_api_keys', host_collection: 'orders', path: [], group_by: 'id' }
      ],
      ['rollup', { collection: 'orders', host_collection: 'directus_users', path: [] }]
    ] as const) {
      const res = await render(widget(type, config), { inputs: { record_id: '1' } })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).error).toBe('Unknown collection')
    }
    expect(items.readItems).not.toHaveBeenCalled()
    expect(items.aggregateItems).not.toHaveBeenCalled()
  })

  it('item_field bindings refuse a system item collection and never bind a system record', async () => {
    const id = widget('stat', { collection: 'orders', field: 'amount', aggregation: 'sum' })
    const bad = await render(id, {
      item_collection: 'nivaro_users',
      draft: { owner: 'u1' },
      bindings: [{ key: 'x', binding_type: 'item_field', binding_value: 'owner.static_token' }]
    })
    expect(bad.statusCode).toBe(400)
    fixture.relatedCollection = 'nivaro_users'
    await render(id, {
      item_collection: 'orders',
      draft: { owner: 'u1' },
      bindings: [{ key: 'x', binding_type: 'item_field', binding_value: 'owner.static_token' }]
    })
    expect(access.readOneAs).not.toHaveBeenCalled()
  })

  it('a toggle over a system table reports no state', async () => {
    const id = widget('button-group', {
      buttons: [
        {
          id: 'b',
          action: 'toggle',
          action_config: { collection: 'nivaro_users', field: 'is_active', id_input: 'id' }
        }
      ]
    })
    const res = await render(id, { inputs: { id: 'u1' } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.buttons[0].is_on).toBeUndefined()
    expect(access.readOneAs).not.toHaveBeenCalled()
  })

  it('a custom-query widget applies the query scope params for the caller before running', async () => {
    scope.applyScopeParams.mockRejectedValueOnce(new Error('stop before SQL'))
    const id = widget('custom-query', {
      query_id: 9,
      param_bindings: [{ param: 'year', input_key: 'year' }]
    })
    await render(id, { inputs: { year: 2026 } })
    expect(scope.applyScopeParams).toHaveBeenCalledWith(
      '{"zone":{"dimension":"zone"}}',
      { year: 2026 },
      'caller',
      false
    )
  })
})
