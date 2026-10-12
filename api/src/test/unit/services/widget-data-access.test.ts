import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../db/index.js'
import { resolveWidgetData } from '../../../services/report-studio.js'
import type { User } from '../../../types.js'

// Report widget data reads as the viewer (#1675 security pass; dashboard widgets:
// dashboard-widget-access.test.ts). The permission layer and the items
// service are stand-ins: `orders` rows carry a zone; the ZONE1 viewer's row filter shows zone 1
// only, NOREAD cannot read the collection, LIMITED's role reads id + title only.
const ORDERS = [
  { id: 1, title: 'a', zone: 1, amount: 10 },
  { id: 2, title: 'b', zone: 2, amount: 20 },
  { id: 3, title: 'c', zone: 1, amount: 30 }
]

const perms = vi.hoisted(() => ({
  can: vi.fn(async (user: { id: string }) => user.id !== 'NOREAD'),
  getAllowedFields: vi.fn(async (user: { id: string }) =>
    user.id === 'LIMITED' ? ['id', 'title'] : null
  ),
  getRowFilter: vi.fn(async () => null),
  applyRowFilter: vi.fn()
}))
vi.mock('../../../services/permissions.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/permissions.js')>()),
  ...perms
}))
vi.mock('../../../services/user-scopes.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/user-scopes.js')>()),
  getUserScopeEnforcement: async () => ({ filters: [], deny: false })
}))

const items = vi.hoisted(() => ({
  readItems: vi.fn(async (user: { id: string }, _c: string, query: { limit?: number }) => {
    if (user.id === 'NOREAD') throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
    const rows = ORDERS.filter((r) => user.id !== 'ZONE1' || r.zone === 1)
    return { data: rows.slice(0, query.limit ?? 25), total: rows.length }
  }),
  aggregateItems: vi.fn()
}))
vi.mock('../../../services/items.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/items.js')>()),
  ...items
}))

const user = (id: string) => ({ id, role: 'R' }) as unknown as User

/** The registry / schema reads the resolvers make, answered for one `orders` collection. */
function chain(table: string) {
  const c: Record<string, unknown> = {}
  for (const m of ['where', 'whereNull', 'whereNotNull', 'whereIn', 'orderBy', 'limit'])
    c[m] = vi.fn(() => c)
  c.first = vi.fn(async () =>
    table === 'nivaro_collections'
      ? { collection: 'orders' }
      : table === 'nivaro_roles'
        ? null
        : null
  )
  c.select = vi.fn(async () =>
    table === 'nivaro_fields' ? ['id', 'title', 'zone', 'amount'].map((field) => ({ field })) : []
  )
  // Awaited lists (relations) are empty. A raw read of the data table must never happen.
  // biome-ignore lint/suspicious/noThenProperty: a knex builder is thenable
  c.then = (resolve: (v: unknown[]) => void) => resolve([])
  if (table === 'orders') throw new Error('raw read of orders')
  return c
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(db).mockImplementation(((t: string) => chain(t)) as never)
  ;(db as unknown as { raw: ReturnType<typeof vi.fn> }).raw = vi.fn(async () =>
    ['id', 'title', 'zone', 'amount', 'created_at'].map((name) => ({ name }))
  )
})

describe('report widgets read as the viewer', () => {
  it('table rows come from the items service, row filter applied', async () => {
    const data = await resolveWidgetData(
      user('ZONE1'),
      { type: 'table', collection: 'orders', config: { columns: ['title'] } },
      null
    )
    expect(data.rows).toEqual([ORDERS[0], ORDERS[2]])
  })

  it('a widget naming a field the role cannot read is refused', async () => {
    await expect(
      resolveWidgetData(
        user('LIMITED'),
        {
          type: 'kpi',
          collection: 'orders',
          config: { metric: { aggregate: 'sum', field: 'amount' } }
        },
        null
      )
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('no read access to the collection is refused', async () => {
    await expect(
      resolveWidgetData(user('NOREAD'), { type: 'kpi', collection: 'orders', config: {} }, null)
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})
