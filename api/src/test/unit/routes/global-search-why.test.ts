import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Search item 25 — GET /global-search/why: admin only; counts the search as the
// admin and as the named person, explains hidden samples through the person's
// access gates, and names field-only matches.

vi.mock('../../../middleware/authenticate.js', () => {
  const authenticate = vi.fn(
    async (req: {
      headers: Record<string, string | undefined>
      user?: unknown
      isAdmin?: boolean
    }) => {
      const who = req.headers['x-test-user']
      if (!who) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
      req.user = { id: who, role: who === 'admin' ? 'r-admin' : 'r-staff' }
      req.isAdmin = who === 'admin'
    }
  )
  return {
    authenticate,
    requireAdmin: vi.fn(async (req: { isAdmin?: boolean }) => {
      await authenticate(req as never)
      if (!req.isAdmin)
        throw Object.assign(new Error('Forbidden'), { statusCode: 403, code: 'ADMIN_ONLY' })
    })
  }
})

vi.mock('../../../db/index.js', () => ({
  db: (table: string) => {
    const b = {
      select: async () =>
        table === 'nivaro_collections'
          ? [
              { collection: 'workflows' },
              { collection: 'units' },
              { collection: 'vendors' },
              { collection: 'nivaro_users' }
            ]
          : [],
      where: () => b,
      first: async () => (table === 'nivaro_roles' ? { name: 'Staff' } : undefined)
    }
    return b
  }
}))

vi.mock('../../../services/read-gate.js', () => ({
  withReadGate: async (_who: unknown, fn: () => Promise<unknown>) => fn()
}))

const TARGET = { id: '11111111-2222-3333-4444-555555555555', first_name: 'Beth', last_name: 'Ng' }
vi.mock('../../../services/users.js', () => ({
  getUser: vi.fn(async (id: string) =>
    id === TARGET.id
      ? { ...TARGET, email: 'beth@x.test', status: 'active', role: 'r-staff' }
      : undefined
  )
}))

const targetIsAdmin = { v: false }
const canRead = new Map<string, boolean>()
vi.mock('../../../services/permissions.js', () => ({
  isAdminRole: vi.fn(async () => targetIsAdmin.v),
  can: vi.fn(async (_u: unknown, _a: string, c: string) => canRead.get(c) ?? true)
}))

type Counts = Array<{ collection: string; display_name: string | null; count: number }>
const counts = { admin: [] as Counts, user: [] as Counts }
type Page = { data: Array<{ id: unknown; label: string }>; total: number | null }
const pages = { admin: new Map<string, Page>(), user: new Map<string, Page>() }
const countCalls: Array<{ who: string; readable: string[]; collections: string[] }> = []
vi.mock('../../../routes/global-search.js', () => ({
  countMatches: vi.fn(
    async (u: { id: string }, readable: string[], _q: string, collections: string[]) => {
      const who = u.id === 'admin' ? 'admin' : 'user'
      countCalls.push({ who, readable, collections })
      return counts[who].filter((c) => collections.includes(c.collection))
    }
  ),
  searchCollectionPage: vi.fn(
    async (u: { id: string }, _r: string[], _q: string, collection: string) =>
      (u.id === 'admin' ? pages.admin : pages.user).get(collection) ?? { data: [], total: 0 }
  )
}))

const hiddenByGate = new Set<string>()
vi.mock('../../../services/record-access.js', () => ({
  compileAccessGates: vi.fn(async (_u: unknown, collection: string) => ({ collection })),
  visibleIds: vi.fn(
    async (_g: unknown, ids: string[]) => new Set(ids.filter((id) => !hiddenByGate.has(id)))
  ),
  explainIds: vi.fn(async (_g: unknown, ids: string[]) => {
    const out = new Map()
    for (const id of ids)
      out.set(id, [
        {
          type: 'scope',
          dimension: 'zone',
          dimension_label: 'Zone',
          allowed_values: ['Zone 1'],
          record_values: ['Zone 4'],
          message: `The Zone access filter excludes this record (${id}).`
        }
      ])
    return out
  })
}))

import { globalSearchWhyRoutes, summarizeReasons } from '../../../routes/global-search-why.js'

async function buildApp() {
  const app = Fastify()
  await app.register(globalSearchWhyRoutes, { prefix: '/global-search' })
  await app.ready()
  return app
}

const hits = (prefix: string, n: number, total = n): Page => ({
  data: Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i + 1}`,
    label: `${prefix} ${i + 1}`
  })),
  total
})

beforeEach(() => {
  targetIsAdmin.v = false
  canRead.clear()
  hiddenByGate.clear()
  counts.admin = []
  counts.user = []
  pages.admin.clear()
  pages.user.clear()
  countCalls.length = 0
})

const url = (q: string, user = TARGET.id) =>
  `/global-search/why?q=${encodeURIComponent(q)}&user_id=${user}`

describe('GET /global-search/why', () => {
  it('refuses non-admins (403) and anonymous callers (401)', async () => {
    const app = await buildApp()
    const staff = await app.inject({ url: url('pump'), headers: { 'x-test-user': 'staff' } })
    expect(staff.statusCode).toBe(403)
    const anon = await app.inject({ url: url('pump') })
    expect(anon.statusCode).toBe(401)
  })

  it('validates the query and the person', async () => {
    const app = await buildApp()
    const h = { 'x-test-user': 'admin' }
    expect((await app.inject({ url: url('p'), headers: h })).statusCode).toBe(400)
    expect(
      (await app.inject({ url: url('pump', '99999999-0000-0000-0000-000000000000'), headers: h }))
        .statusCode
    ).toBe(404)
  })

  it('counts as both people and explains hidden samples through the gates', async () => {
    counts.admin = [
      { collection: 'workflows', display_name: 'Workflows', count: 10 },
      { collection: 'units', display_name: 'Units', count: 4 }
    ]
    counts.user = [
      { collection: 'workflows', display_name: 'Workflows', count: 6 },
      { collection: 'units', display_name: 'Units', count: 4 }
    ]
    pages.admin.set('workflows', hits('wf', 10))
    for (const id of ['wf1', 'wf2', 'wf3', 'wf4']) hiddenByGate.add(id)
    pages.user.set('workflows', {
      data: hits('wf', 10).data.filter((h) => !hiddenByGate.has(String(h.id))),
      total: 6
    })
    const app = await buildApp()
    const res = await app.inject({ url: url('pump'), headers: { 'x-test-user': 'admin' } })
    expect(res.statusCode).toBe(200)
    const data = res.json().data
    expect(data.user).toMatchObject({ name: 'Beth Ng', role_name: 'Staff', is_admin: false })
    expect(data.totals).toEqual({ admin: 14, user: 10, hidden: 4 })
    const [wf, units] = data.collections
    expect(wf).toMatchObject({ collection: 'workflows', admin_count: 10, user_count: 6, hidden: 4 })
    // Up to three samples, each with the person's own gate reasons.
    expect(wf.samples.map((s: { id: string }) => s.id)).toEqual(['wf1', 'wf2', 'wf3'])
    expect(wf.samples[0].label).toBe('wf 1')
    expect(wf.reasons).toEqual([
      expect.objectContaining({ type: 'scope', dimension_label: 'Zone', samples: 3 })
    ])
    expect(wf.reasons[0].message).toMatch(/limited to Zone 1/)
    expect(units).toMatchObject({ hidden: 0, reasons: [], samples: [] })
    // The admin searches every registered non-system collection; the person only
    // the collections the admin found something in.
    expect(countCalls[0].readable).toEqual(['workflows', 'units', 'vendors'])
    expect(countCalls[1]).toMatchObject({ who: 'user', collections: ['workflows', 'units'] })
  })

  it('names a collection their role cannot read', async () => {
    counts.admin = [{ collection: 'vendors', display_name: 'Vendors', count: 3 }]
    canRead.set('vendors', false)
    const app = await buildApp()
    const data = (
      await app.inject({ url: url('acme'), headers: { 'x-test-user': 'admin' } })
    ).json().data
    expect(data.collections[0]).toMatchObject({ user_count: 0, hidden: 3, samples: [] })
    expect(data.collections[0].reasons[0]).toMatchObject({ type: 'permission' })
  })

  it('says when a match is only in a field they cannot read', async () => {
    counts.admin = [{ collection: 'units', display_name: 'Units', count: 3 }]
    counts.user = [{ collection: 'units', display_name: 'Units', count: 1 }]
    pages.admin.set('units', hits('u', 3))
    pages.user.set('units', { data: [{ id: 'u1', label: 'u 1' }], total: 1 })
    const app = await buildApp()
    const data = (
      await app.inject({ url: url('serial'), headers: { 'x-test-user': 'admin' } })
    ).json().data
    expect(data.collections[0].samples).toEqual([])
    expect(data.collections[0].reasons).toEqual([expect.objectContaining({ type: 'fields' })])
  })

  it('an admin target sees what the admin sees', async () => {
    targetIsAdmin.v = true
    counts.admin = [{ collection: 'units', display_name: 'Units', count: 2 }]
    const app = await buildApp()
    const data = (
      await app.inject({ url: url('pump'), headers: { 'x-test-user': 'admin' } })
    ).json().data
    expect(data.user.is_admin).toBe(true)
    expect(data.totals).toEqual({ admin: 2, user: 2, hidden: 0 })
    expect(countCalls).toHaveLength(1)
  })
})

describe('summarizeReasons', () => {
  it('one line per distinct reason, most common first, counted once per sample', () => {
    const scope = {
      type: 'scope' as const,
      dimension: 'zone',
      dimension_label: 'Zone',
      message: 'x'
    }
    const row = { type: 'row_filter' as const, message: 'y' }
    const out = summarizeReasons([
      { id: '1', label: 'a', reasons: [row] },
      { id: '2', label: 'b', reasons: [scope, scope] },
      { id: '3', label: 'c', reasons: [scope, row] }
    ])
    expect(out.map((r) => [r.type, r.samples])).toEqual([
      ['row_filter', 2],
      ['scope', 2]
    ])
  })
})
