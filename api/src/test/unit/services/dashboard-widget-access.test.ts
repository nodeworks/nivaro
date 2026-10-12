import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../db/index.js'
import { dashboardLinkRoutes } from '../../../routes/dashboard-links.js'
import { dashboardsRoutes } from '../../../routes/dashboards.js'
import { computeWidgetData, widgetSourceRefusal } from '../../../services/dashboard-widgets.js'
import type { User } from '../../../types.js'

// Dashboard widgets read AS THE VIEWER. The permission layer and the items service are
// stand-ins: `orders` rows carry a zone; ZONE1's row filter shows zone 1 only, NOREAD cannot
// read the collection, LIMITED's role reads id + title + zone + created_at (not amount).
const ORDERS = [
  { id: 1, title: 'a', zone: 1, amount: 10, created_at: '2026-10-01' },
  { id: 2, title: 'b', zone: 2, amount: 20, created_at: '2026-10-02' },
  { id: 3, title: 'c', zone: 1, amount: 30, created_at: '2026-10-03' }
]
const LIMITED_FIELDS = ['id', 'title', 'zone', 'created_at']

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'NOREAD', role: 'R' }
    req.isAdmin = false
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))

const perms = vi.hoisted(() => ({
  can: vi.fn(async (user: { id: string }) => user.id !== 'NOREAD'),
  getAllowedFields: vi.fn(async (user: { id: string }) =>
    user.id === 'LIMITED'
      ? ['id', 'title', 'zone', 'created_at']
      : user.id === 'NODATE'
        ? ['id', 'title', 'zone']
        : null
  ),
  getRowFilter: vi.fn(async (user: { id: string }) =>
    user.id === 'NODATE' ? [{ field: 'zone', op: 'eq', value: 1 }] : null
  ),
  applyRowFilter: vi.fn()
}))
vi.mock('../../../services/permissions.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/permissions.js')>()),
  ...perms
}))

/** What each viewer's reads return: the row filter and the field list applied. */
function visibleRows(user: { id: string }) {
  if (user.id === 'NOREAD') throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
  const rows = ORDERS.filter((r) => user.id !== 'ZONE1' || r.zone === 1)
  if (user.id !== 'LIMITED') return rows
  return rows.map((r) =>
    Object.fromEntries(Object.entries(r).filter(([k]) => LIMITED_FIELDS.includes(k)))
  )
}
const scopes = vi.hoisted(() => ({ applyUserScopesToQuery: vi.fn(async () => {}) }))
vi.mock('../../../services/user-scopes.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/user-scopes.js')>()),
  ...scopes
}))

const items = vi.hoisted(() => ({
  readItems: vi.fn(),
  aggregateItems: vi.fn()
}))
vi.mock('../../../services/items.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/items.js')>()),
  ...items
}))

const user = (id: string) => ({ id, role: 'R' }) as unknown as User

const tables: Record<string, Record<string, unknown> | null> = {}
function chain(table: string) {
  // A raw read of the data table must never happen on the row/aggregate paths.
  if (table === 'orders') throw new Error('raw read of orders')
  const c: Record<string, unknown> = {}
  for (const m of ['where', 'whereNot', 'orderBy', 'limit']) c[m] = vi.fn(() => c)
  c.first = vi.fn(async () =>
    table === 'nivaro_collections' || table === 'nivaro_fields'
      ? { collection: 'orders' }
      : (tables[table] ?? null)
  )
  c.select = vi.fn(async () =>
    table === 'nivaro_fields'
      ? ['id', 'title', 'zone', 'amount', 'created_at'].map((field) => ({ field }))
      : []
  )
  c.insert = vi.fn(async () => [1])
  return c
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(db).mockImplementation(((t: string) => chain(t)) as never)
  items.readItems.mockImplementation(
    async (u: { id: string }, _c: string, q: { limit?: number }) => {
      const rows = visibleRows(u)
      return { data: rows.slice(0, q.limit ?? 25), total: rows.length }
    }
  )
  items.aggregateItems.mockImplementation(
    async (u: { id: string }, _c: string, q: { aggregate: { sum?: string[] } }) => {
      const rows = visibleRows(u) as Array<Record<string, number>>
      const f = q.aggregate.sum?.[0]
      return {
        data: [
          f
            ? { group: {}, sum: { [f]: rows.reduce((a, r) => a + (r[f] ?? 0), 0) } }
            : { group: {}, countAll: rows.length }
        ]
      }
    }
  )
})

const latest = { type: 'latest', collection: 'orders', field: null, filters: null }
const count = { type: 'count', collection: 'orders', field: null, filters: null }

describe('dashboard widget data reads as the viewer', () => {
  it('a viewer without read access to the collection gets nothing', async () => {
    for (const w of [latest, count, { ...count, type: 'sum', field: 'amount' }]) {
      expect(await computeWidgetData(w, [], { user: user('NOREAD') })).toEqual({
        error: 'Forbidden',
        status: 403
      })
    }
    expect(items.readItems).not.toHaveBeenCalled()
    expect(items.aggregateItems).not.toHaveBeenCalled()
  })

  it("a row-filtered viewer's latest and count exclude the rows their filter hides", async () => {
    const rows = await computeWidgetData(latest, [], { user: user('ZONE1') })
    expect(rows).toEqual({ data: { rows: [ORDERS[0], ORDERS[2]] } })
    expect(items.readItems).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ZONE1' }),
      'orders',
      expect.objectContaining({ sort: ['-created_at'], limit: 10 })
    )
    expect(await computeWidgetData(count, [], { user: user('ZONE1') })).toEqual({
      data: { value: 2 }
    })
  })

  it('a field-limited viewer gets no hidden columns and cannot sum or filter on one', async () => {
    const res = (await computeWidgetData(latest, [], { user: user('LIMITED') })) as {
      data: { rows: Array<Record<string, unknown>> }
    }
    expect(res.data.rows).toHaveLength(3)
    for (const r of res.data.rows) expect(r).not.toHaveProperty('amount')
    const sum = { ...count, type: 'sum', field: 'amount' }
    expect(await computeWidgetData(sum, [], { user: user('LIMITED') })).toEqual({
      error: 'Forbidden',
      status: 403
    })
    // A count filtered on a hidden field would be an oracle for its values.
    const oracle = { ...count, filters: [{ field: 'amount', op: 'gt', value: 15 }] }
    expect(await computeWidgetData(oracle, [], { user: user('LIMITED') })).toEqual({
      error: 'Forbidden',
      status: 403
    })
    // A dashboard filter-bar entry on a hidden field just does not bind.
    expect(
      await computeWidgetData(count, [{ field: 'amount', op: 'gt', value: 15 }], {
        user: user('LIMITED')
      })
    ).toEqual({ data: { value: 3 } })
  })

  it('a widget over a system collection is refused (nivaro_users carries tokens)', async () => {
    for (const collection of [
      'nivaro_users',
      'nivaro_settings',
      'NIVARO_api_keys',
      'nivaro_webhooks',
      'directus_users'
    ]) {
      expect(
        await computeWidgetData({ ...latest, collection }, [], { user: user('ZONE1') })
      ).toEqual({ error: 'Unknown collection', status: 400 })
    }
    expect(items.readItems).not.toHaveBeenCalled()
  })

  it('a count chart works for a role whose field list omits created_at, row filter applied', async () => {
    const raw: Record<string, unknown> = {}
    for (const m of ['select', 'count', 'whereRaw', 'groupByRaw', 'orderBy', 'where'])
      raw[m] = vi.fn(() => raw)
    // biome-ignore lint/suspicious/noThenProperty: a knex builder is thenable
    raw.then = (resolve: (v: unknown[]) => void) => resolve([{ date: '2026-10-01', count: 2 }])
    vi.mocked(db).mockImplementation(((t: string) => (t === 'orders' ? raw : chain(t))) as never)
    const chart = { ...count, type: 'bar_chart' }
    expect(await computeWidgetData(chart, [], { user: user('NODATE') })).toEqual({
      data: { rows: [{ date: '2026-10-01', count: 2 }] }
    })
    expect(perms.applyRowFilter).toHaveBeenCalledWith(
      raw,
      [{ field: 'zone', op: 'eq', value: 1 }],
      expect.objectContaining({ id: 'NODATE' })
    )
    expect(scopes.applyUserScopesToQuery).toHaveBeenCalledWith(
      raw,
      'orders',
      expect.objectContaining({ id: 'NODATE' })
    )
  })

  it('no viewer (a public link without a creator) gets nothing', async () => {
    expect(await computeWidgetData(latest)).toEqual({ error: 'Forbidden', status: 403 })
  })
})

describe('building a widget', () => {
  it('refuses a collection, field or filter the author cannot read', async () => {
    expect(await widgetSourceRefusal(user('NOREAD'), count)).toMatch(/No read access/)
    expect(
      await widgetSourceRefusal(user('LIMITED'), { ...count, type: 'sum', field: 'amount' })
    ).toMatch(/"amount"/)
    expect(
      await widgetSourceRefusal(user('LIMITED'), {
        ...count,
        filters: [{ field: 'amount', value: 1 }]
      })
    ).toMatch(/"amount"/)
    expect(await widgetSourceRefusal(user('ZONE1'), count)).toBeNull()
    // System tables never, whatever a role's `*` policy grants.
    expect(
      await widgetSourceRefusal(user('ZONE1'), { ...latest, collection: 'nivaro_settings' })
    ).toBe('Unknown collection')
  })

  it('POST /:id/widgets on a system collection is 400', async () => {
    tables.nivaro_dashboards = { id: 'd1', user: 'NOREAD', is_shared: false }
    const app = Fastify({ logger: false })
    app.register(dashboardsRoutes, { prefix: '/dashboards' })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/dashboards/d1/widgets',
      payload: { type: 'latest', title: 'Users', collection: 'nivaro_users' }
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('Unknown collection')
  })

  it('POST /:id/widgets on an unreadable collection is 403', async () => {
    tables.nivaro_dashboards = { id: 'd1', user: 'NOREAD', is_shared: false }
    const app = Fastify({ logger: false })
    app.register(dashboardsRoutes, { prefix: '/dashboards' })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/dashboards/d1/widgets',
      payload: { type: 'latest', title: 'Orders', collection: 'orders' }
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toMatch(/No read access/)
  })
})

describe('public dashboard links', () => {
  /** Owner ZONE1 (row-filtered to zone 1) owns dashboard d1; `creator` minted the link. */
  function linkDb(opts: { creator: string; creatorAdmin: boolean; ownerActive?: boolean }) {
    const people: Record<string, Record<string, unknown> | undefined> = {
      ZONE1: opts.ownerActive === false ? undefined : { id: 'ZONE1', role: 'R-USER' },
      ADMIN: { id: 'ADMIN', role: 'R-ADMIN' }
    }
    return (t: string) => {
      const c = chain(t === 'orders' ? 'x' : t)
      if (t === 'nivaro_dashboard_links')
        c.first = vi.fn(async () => ({
          id: 1,
          dashboard: 'd1',
          token: 'a'.repeat(48),
          is_active: true,
          expires_at: null,
          created_by: opts.creator
        }))
      if (t === 'nivaro_dashboards')
        c.first = vi.fn(async () => ({ id: 'd1', name: 'D', user: 'ZONE1' }))
      if (t === 'nivaro_users') {
        let id = ''
        c.where = vi.fn((w: { id?: string }) => {
          id = String(w?.id ?? '')
          return c
        })
        c.first = vi.fn(async () => people[id])
      }
      if (t === 'nivaro_roles') c.first = vi.fn(async () => ({ admin_access: opts.creatorAdmin }))
      if (t === 'nivaro_dashboard_widgets') {
        // biome-ignore lint/suspicious/noThenProperty: a knex builder is thenable
        c.then = (resolve: (v: unknown[]) => void) => resolve([{ id: 'w', ...latest }])
      }
      c.increment = vi.fn(() => ({ catch: () => {} }))
      return c
    }
  }

  async function render() {
    const app = Fastify({ logger: false })
    app.register(dashboardLinkRoutes, { prefix: '/dashboard-links' })
    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: `/dashboard-links/public/${'a'.repeat(48)}`
    })
    return JSON.parse(res.body).data.widgets[0].data
  }

  it("an admin-minted link on a user's dashboard renders with the OWNER's narrowed rows", async () => {
    vi.mocked(db).mockImplementation(linkDb({ creator: 'ADMIN', creatorAdmin: true }) as never)
    expect(await render()).toEqual({ rows: [ORDERS[0], ORDERS[2]] })
    expect(items.readItems).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ZONE1' }),
      'orders',
      expect.anything()
    )
  })

  it('an inactive owner shows nothing', async () => {
    vi.mocked(db).mockImplementation(
      linkDb({ creator: 'ADMIN', creatorAdmin: true, ownerActive: false }) as never
    )
    expect(await render()).toBeNull()
    expect(items.readItems).not.toHaveBeenCalled()
  })

  it('shows nothing once the creator neither owns the dashboard nor administers', async () => {
    vi.mocked(db).mockImplementation(linkDb({ creator: 'ADMIN', creatorAdmin: false }) as never)
    expect(await render()).toBeNull()
    expect(items.readItems).not.toHaveBeenCalled()
  })
})
