import Fastify, { type FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 6, Task 17: the shared deployment detail names the ETag of the tenants list
// the Hub serves now (`list_etag`), so the admin page can say which replica holds the latest
// list. It is Task 2's own tag (tenantsBody); a list that cannot be built reads as null, never
// as a tag no replica holds.

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
  const admin = async (req: { headers: Record<string, string | undefined>; user?: unknown }) => {
    if (req.headers['x-admin'] !== '1')
      throw Object.assign(new Error('Forbidden'), { statusCode: 403, code: 'ADMIN_ONLY' })
    req.user = { id: 'AAAAAAAA-0000-4000-8000-000000000001', status: 'active' }
  }
  return { requireAuth: vi.fn(admin), requireAdmin: vi.fn(admin), authenticate: vi.fn(admin) }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))

const m = vi.hoisted(() => ({ bodyFails: false }))
vi.mock('../../../services/hub/shared/tenants.js', async (orig) => {
  const real = await orig<typeof import('../../../services/hub/shared/tenants.js')>()
  return {
    ...real,
    tenantsBody: (...a: Parameters<typeof real.tenantsBody>) => {
      if (m.bodyFails) return Promise.reject(new Error('cannot build'))
      return real.tenantsBody(...a)
    }
  }
})

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const migrations = [
  await import('../../../db/migrations/542_hub_tables.js'),
  await import('../../../db/migrations/543_hub_promotions.js'),
  await import('../../../db/migrations/544_hub_databases.js'),
  await import('../../../db/migrations/545_hub_creations.js'),
  await import('../../../db/migrations/546_hub_stack_settings.js'),
  await import('../../../db/migrations/550_hub_oidc.js'),
  await import('../../../db/migrations/551_hub_signins.js'),
  await import('../../../db/migrations/552_hub_shared_deployments.js'),
  await import('../../../db/migrations/553_hub_moves.js')
]
const { hubRoutes } = await import('../../../routes/hub.js')
const { getShared } = await import('../../../services/hub/shared/store.js')
const { tenantsBody } = await import('../../../services/hub/shared/tenants.js')
const { _setSightingsDepsForTests, memorySightingsRedis } = await import(
  '../../../services/hub/shared/sightings.js'
)

const asAdmin = { 'x-admin': '1' }
let app: FastifyInstance
const prev: Record<string, string | undefined> = {}

beforeAll(async () => {
  for (const k of ['HUB', 'ENCRYPTION_KEY', 'HUB_URL']) prev[k] = process.env[k]
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  process.env.HUB_URL = 'https://hub.example.com'
  for (const mig of migrations) await mig.up(db)
  app = Fastify()
  await app.register(hubRoutes, { prefix: '/api/hub' })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await db.destroy()
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

beforeEach(async () => {
  m.bodyFails = false
  _setSightingsDepsForTests({ redis: memorySightingsRedis() })
  await db('nivaro_hub_shared_deployments').del()
})

async function create(): Promise<number> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/hub/shared',
    headers: asAdmin,
    payload: { key: 'shared-one', name: 'Shared one', link_url: 'https://s.example.com' }
  })
  expect(res.statusCode).toBe(201)
  return res.json().data.row.id as number
}

describe('GET /api/hub/shared/:id list_etag', () => {
  it("is the ETag of the tenants list the Hub serves now (Task 2's tag)", async () => {
    const id = await create()
    const got = await app.inject({ method: 'GET', url: `/api/hub/shared/${id}`, headers: asAdmin })
    expect(got.statusCode).toBe(200)
    const row = await getShared(id)
    if (!row) throw new Error('no row')
    const { etag } = await tenantsBody(row)
    expect(got.json().data.list_etag).toBe(etag)
  })

  it('a list that cannot be built reads as null', async () => {
    const id = await create()
    m.bodyFails = true
    const got = await app.inject({ method: 'GET', url: `/api/hub/shared/${id}`, headers: asAdmin })
    expect(got.statusCode).toBe(200)
    expect(got.json().data.list_etag).toBeNull()
  })
})
