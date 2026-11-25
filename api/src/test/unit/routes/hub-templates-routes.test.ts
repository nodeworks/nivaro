import Fastify, { type FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub enhancement 24: /api/hub/templates — administrators only, Hub mode only, every write logged.

vi.mock('../../../db/index.js', async () => {
  const knex = (await import('knex')).default
  const { sqliteAfterCreate, sqliteCompat } = await import('../../../db/sqlite.js')
  sqliteCompat()
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate }
  })
  return { db }
})
vi.mock('../../../middleware/authenticate.js', () => {
  const sign = async (req: {
    headers: Record<string, string | undefined>
    user?: unknown
    isAdmin?: boolean
  }) => {
    const id = req.headers['x-user']
    if (!id) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    req.user = { id, status: 'active' }
    req.isAdmin = req.headers['x-admin'] === '1'
  }
  const admin = async (req: Parameters<typeof sign>[0]) => {
    await sign(req)
    if (!req.isAdmin) throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
  }
  return { requireAuth: vi.fn(sign), requireAdmin: vi.fn(admin), authenticate: vi.fn(sign) }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { up } = await import('../../../db/migrations/571_hub_app_templates.js')
const { logActivity } = await import('../../../services/activity.js')
const { hubTemplateRoutes } = await import('../../../routes/hub-templates.js')

const asAdmin = { 'x-user': 'a', 'x-admin': '1' }
const asOwner = { 'x-user': 'o' }
const bundle = {
  type: 'nivaro-blueprint',
  version: 1,
  name: 'Assets',
  exported_at: '2026-11-20T00:00:00.000Z',
  collections: [{ meta: { collection: 'assets' }, fields: [] }],
  relations: [],
  workflows: [],
  layouts: [],
  queues: [],
  rules: []
}

let app: FastifyInstance
let prevHub: string | undefined

beforeAll(async () => {
  prevHub = process.env.HUB
  process.env.HUB = 'on'
  await up(db)
  app = Fastify()
  await app.register(hubTemplateRoutes, { prefix: '/hub' })
  await app.ready()
})
afterAll(async () => {
  await app.close()
  await db.destroy()
  if (prevHub === undefined) delete process.env.HUB
  else process.env.HUB = prevHub
})
beforeEach(async () => {
  vi.mocked(logActivity).mockClear()
  await db('nivaro_hub_app_templates').del()
})

describe('hub template routes', () => {
  it('admin uploads (201), lists, edits, downloads and deletes; each write is logged', async () => {
    const up = await app.inject({
      method: 'POST',
      url: '/hub/templates',
      headers: asAdmin,
      payload: { bundle, version: '1.0.0', description: 'Asset tracking' }
    })
    expect(up.statusCode).toBe(201)
    const id = up.json().data.id
    const list = await app.inject({ method: 'GET', url: '/hub/templates', headers: asAdmin })
    expect(list.json().data).toHaveLength(1)
    expect(list.body).not.toContain('"bundle"')
    const patch = await app.inject({
      method: 'PATCH',
      url: `/hub/templates/${id}`,
      headers: asAdmin,
      payload: { archived: true }
    })
    expect(patch.json().data.archived).toBe(true)
    const file = await app.inject({
      method: 'GET',
      url: `/hub/templates/${id}/bundle`,
      headers: asAdmin
    })
    expect(file.headers['content-disposition']).toMatch(/Assets-1\.0\.0\.blueprint\.json/)
    expect(JSON.parse(file.body).blueprint.name).toBe('Assets')
    const del = await app.inject({
      method: 'DELETE',
      url: `/hub/templates/${id}`,
      headers: asAdmin
    })
    expect(del.statusCode).toBe(204)
    expect(vi.mocked(logActivity).mock.calls.map((c) => c[0].action)).toEqual([
      'hub-template-upload',
      'hub-template-update',
      'hub-template-delete'
    ])
  })

  it('a refusal answers its code (not a blueprint → 400 BAD_BUNDLE)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/hub/templates',
      headers: asAdmin,
      payload: { bundle: { nope: 1 } }
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().code).toBe('BAD_BUNDLE')
  })

  it('anyone but an administrator is refused, reads included', async () => {
    for (const [method, url] of [
      ['GET', '/hub/templates'],
      ['POST', '/hub/templates'],
      ['DELETE', '/hub/templates/1']
    ] as const) {
      const r = await app.inject({
        method,
        url,
        headers: asOwner,
        payload: method === 'GET' ? undefined : {}
      })
      expect(r.statusCode, `${method} ${url}`).toBe(403)
    }
  })

  it('without HUB=on nothing is mounted', async () => {
    const prev = process.env.HUB
    delete process.env.HUB
    const off = Fastify()
    await off.register(hubTemplateRoutes, { prefix: '/hub' })
    await off.ready()
    const r = await off.inject({ method: 'GET', url: '/hub/templates', headers: asAdmin })
    expect(r.statusCode).toBe(404)
    await off.close()
    process.env.HUB = prev
  })
})
