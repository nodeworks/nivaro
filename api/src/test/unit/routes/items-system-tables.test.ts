import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The routes beside the items service that read or write raw: clone wrote a
// copy of any row of any table with no permission check at all, and a
// relation path could end on a credential (`created_by.static_token`).

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'U-1', role: 'WORKFLOW-CREATOR' }
    req.isAdmin = false
  }
}))
vi.mock('../../../middleware/workspace.js', () => ({ resolveWorkspace: async () => {} }))
vi.mock('../../../services/idempotency.js', () => ({
  idempotencyPreHandler: () => async () => {}
}))
const raw = vi.hoisted(() => ({ tables: [] as string[] }))
vi.mock('../../../db/index.js', () => {
  const chain = (): unknown =>
    new Proxy(() => undefined, {
      get(_t, prop) {
        if (prop === 'then') return (res: (v: unknown) => unknown) => Promise.resolve([]).then(res)
        if (prop === 'first') return () => Promise.resolve({ id: 1, title: 'x' })
        return () => chain()
      },
      apply: () => chain()
    })
  const db = (table: string) => {
    raw.tables.push(table)
    return chain()
  }
  return { db, dbRead: db }
})
const perms = vi.hoisted(() => ({ create: true }))
vi.mock('../../../services/permissions.js', async (orig) => ({
  ...(await orig<object>()),
  can: vi.fn(async (_u: unknown, action: string) => action !== 'create' || perms.create),
  getAllowedFields: vi.fn(async () => ['id', 'first_name', 'last_name', 'email'])
}))
vi.mock('../../../services/collections.js', async (orig) => ({
  ...(await orig<object>()),
  getCollection: vi.fn(async (c: string) => (c === 'workflows' ? { collection: c } : undefined)),
  getRelations: vi.fn(async (c: string) =>
    c === 'workflows'
      ? [
          {
            many_collection: 'workflows',
            many_field: 'created_by',
            one_collection: 'nivaro_users',
            junction_field: null
          }
        ]
      : []
  )
}))
const paths = vi.hoisted(() => ({ asked: [] as string[][] }))
vi.mock('../../../services/queues.js', async (orig) => ({
  ...(await orig<object>()),
  resolvePathValues: vi.fn(async (_c: string, ids: string[], segs: string[]) => {
    paths.asked.push(segs)
    return new Map(ids.map((id) => [id, { value: 'v', ids: [] }]))
  })
}))
vi.mock('../../../services/items.js', async (orig) => ({
  ...(await orig<object>()),
  readOne: vi.fn(async () => ({ id: '1' }))
}))

import { itemsRoutes } from '../../../routes/items.js'

async function app() {
  const a = Fastify()
  await a.register(itemsRoutes, { prefix: '/api/items' })
  return a
}

beforeEach(() => {
  raw.tables = []
  paths.asked = []
  perms.create = true
})

describe('clone', () => {
  it('never copies a system row, and touches no table doing so', async () => {
    const a = await app()
    for (const c of ['nivaro_users', 'nivaro_settings', 'directus_users']) {
      const res = await a.inject({ method: 'POST', url: `/api/items/${c}/1/clone`, payload: {} })
      expect(res.statusCode, c).toBe(403)
    }
    expect(raw.tables).not.toContain('nivaro_users')
    expect(raw.tables).not.toContain('nivaro_settings')
  })

  it('an unregistered table answers as unknown; a caller who cannot create is refused', async () => {
    const a = await app()
    expect(
      (await a.inject({ method: 'POST', url: '/api/items/sysdiagrams/1/clone', payload: {} }))
        .statusCode
    ).toBe(404)
    perms.create = false
    expect(
      (await a.inject({ method: 'POST', url: '/api/items/workflows/1/clone', payload: {} }))
        .statusCode
    ).toBe(403)
    expect(raw.tables).not.toContain('sysdiagrams')
    expect(raw.tables).not.toContain('workflows')
  })
})

describe('resolve-paths', () => {
  it('a path never ends on a credential or a column outside the person fields', async () => {
    const a = await app()
    const res = await a.inject({
      method: 'GET',
      url: '/api/items/workflows/1/resolve-paths?paths=created_by.static_token,created_by.phone,created_by.email'
    })
    expect(res.statusCode).toBe(200)
    expect(Object.keys(res.json().data)).toEqual(['created_by.email'])
    expect(paths.asked).toEqual([['created_by', 'email']])
  })
})
