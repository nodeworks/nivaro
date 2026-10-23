import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

// GET /data-model/resolve-cascade — InlineTableField asks it how a line-item
// grid's child picker relates to the parent form's value. It sat inside the
// admin-gated data-model plugin, so every non-admin got 403 ADMIN_ONLY and the
// child pickers were never filtered (staging demo 2026-10-23). It now lives in
// dataModelReadRoutes: any signed-in person, relation shape only.

vi.mock('../../../middleware/authenticate.js', () => {
  const unauthorized = () =>
    Object.assign(new Error('Unauthorized'), { statusCode: 401, code: 'NOT_SIGNED_IN' })
  const authenticate = vi.fn(
    async (
      req: {
        headers: Record<string, string | undefined>
        user?: unknown
        isAdmin?: boolean
      },
      _reply?: unknown
    ) => {
      const who = req.headers['x-test-user']
      if (!who) throw unauthorized()
      req.user = { id: who, role: who === 'admin' ? 'ADMIN' : 'EDITOR' }
      req.isAdmin = who === 'admin'
    }
  )
  return {
    authenticate,
    requireAdmin: vi.fn(async (req: { isAdmin?: boolean }, reply: unknown) => {
      await authenticate(req as never, reply as never)
      if (!req.isAdmin)
        throw Object.assign(new Error('Forbidden'), { statusCode: 403, code: 'ADMIN_ONLY' })
    })
  }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/collections.js', () => ({
  clearMetadataCache: vi.fn(),
  getCollection: vi.fn(async (name: string) =>
    ['purchase_orders', 'po_lines', 'nivaro_users'].includes(name)
      ? { collection: name }
      : undefined
  )
}))

interface Rel {
  id: number
  many_collection: string
  many_field: string
  one_collection: string | null
  junction_field: string | null
}
// purchase_orders.project → projects; po_lines.zone → zones; zones.project → projects.
const RELATIONS: Rel[] = [
  {
    id: 1,
    many_collection: 'purchase_orders',
    many_field: 'project',
    one_collection: 'projects',
    junction_field: null
  },
  {
    id: 2,
    many_collection: 'po_lines',
    many_field: 'zone',
    one_collection: 'zones',
    junction_field: null
  },
  {
    id: 3,
    many_collection: 'zones',
    many_field: 'project',
    one_collection: 'projects',
    junction_field: null
  }
]

const tablesRead: string[] = []
vi.mock('../../../db/index.js', () => {
  const db = (table: string) => {
    tablesRead.push(table)
    const preds: Array<(r: Rel) => boolean> = []
    const rows = () =>
      table === 'nivaro_relations' ? RELATIONS.filter((r) => preds.every((p) => p(r))) : []
    const b: Record<string, unknown> = {
      where: (w: Record<string, unknown>) => {
        preds.push((r) => Object.entries(w).every(([k, v]) => (r as never)[k] === v))
        return b
      },
      whereNull: (k: keyof Rel) => {
        preds.push((r) => r[k] == null)
        return b
      },
      whereNotNull: (k: keyof Rel) => {
        preds.push((r) => r[k] != null)
        return b
      },
      first: async () => rows()[0],
      // biome-ignore lint/suspicious/noThenProperty: a knex builder is thenable
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(rows()).then(resolve, reject)
    }
    return b
  }
  return { db }
})

import { cascadeParams, dataModelReadRoutes, dataModelRoutes } from '../../../routes/data-model.js'

/** Registered the way routes/index.ts registers them: both plugins on one prefix. */
async function buildApp() {
  const app = Fastify()
  await app.register(dataModelRoutes, { prefix: '/data-model' })
  await app.register(dataModelReadRoutes, { prefix: '/data-model' })
  await app.ready()
  return app
}

const QS =
  'parent_collection=purchase_orders&parent_field=project&child_collection=po_lines&child_field=zone'

describe('GET /data-model/resolve-cascade', () => {
  it('answers a signed-in non-admin with the join strategy', async () => {
    const app = await buildApp()
    const res = await app.inject({
      url: `/data-model/resolve-cascade?${QS}`,
      headers: { 'x-test-user': 'editor' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      data: {
        type: 'direct_fk',
        filter_column: 'project',
        child_target_collection: 'zones',
        parent_target_collection: 'projects'
      }
    })
    // Relation shape only: nothing but the relations registry is read.
    expect(new Set(tablesRead)).toEqual(new Set(['nivaro_relations']))
    await app.close()
  })

  it('refuses a caller who is not signed in with 401', async () => {
    const app = await buildApp()
    const res = await app.inject({ url: `/data-model/resolve-cascade?${QS}` })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('answers admins too', async () => {
    const app = await buildApp()
    const res = await app.inject({
      url: `/data-model/resolve-cascade?${QS}`,
      headers: { 'x-test-user': 'admin' }
    })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('refuses system tables, unknown collections and malformed queries', async () => {
    const app = await buildApp()
    const headers = { 'x-test-user': 'editor' }
    const sys = await app.inject({
      url: '/data-model/resolve-cascade?parent_collection=nivaro_users&parent_field=role&child_collection=po_lines&child_field=zone',
      headers
    })
    expect(sys.statusCode).toBe(403)
    const unknown = await app.inject({
      url: '/data-model/resolve-cascade?parent_collection=nope&parent_field=x&child_collection=po_lines&child_field=zone',
      headers
    })
    expect(unknown.statusCode).toBe(404)
    const missing = await app.inject({
      url: '/data-model/resolve-cascade?parent_collection=purchase_orders',
      headers
    })
    expect(missing.statusCode).toBe(400)
    const repeated = await app.inject({
      url: `/data-model/resolve-cascade?${QS}&child_field=other`,
      headers
    })
    expect(repeated.statusCode).toBe(400)
    await app.close()
  })

  it('still gates the admin data-model routes', async () => {
    const app = await buildApp()
    const res = await app.inject({
      url: '/data-model/tables',
      headers: { 'x-test-user': 'editor' }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
})

describe('cascadeParams', () => {
  it('takes four plain names and nothing else', () => {
    const ok = {
      parent_collection: 'a',
      parent_field: 'b',
      child_collection: 'c',
      child_field: 'd'
    }
    expect(cascadeParams(ok)).toEqual(ok)
    expect(cascadeParams({ ...ok, child_field: '' })).toBeNull()
    expect(cascadeParams({ ...ok, child_field: ['d', 'e'] })).toBeNull()
    expect(cascadeParams({ ...ok, parent_field: 'x\u0000y' })).toBeNull()
    expect(cascadeParams({ ...ok, parent_field: 'x'.repeat(129) })).toBeNull()
  })
})
