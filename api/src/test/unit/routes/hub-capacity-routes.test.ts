import Fastify, { type FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub capacity routes (/api/hub/capacity*): admin only, limits checked and logged, refused
// while a move holds the environment, listed with the app in the tenants answer; the deployment
// is asked to re-read its list. Real SQLite with the hub tables; the deployment link is mocked.

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
    if (!req.isAdmin)
      throw Object.assign(new Error('Forbidden'), { statusCode: 403, code: 'ADMIN_ONLY' })
  }
  return { requireAuth: vi.fn(sign), requireAdmin: vi.fn(admin), authenticate: vi.fn(sign) }
})
const m = vi.hoisted(() => ({
  logActivity: vi.fn(async () => null),
  refresh: vi.fn(async () => undefined)
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: m.logActivity }))
vi.mock('../../../services/hub/shared/deployment-client.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/hub/shared/deployment-client.js')>()),
  deploymentClient: vi.fn(() => ({ refresh: m.refresh, status: vi.fn(), appStatus: vi.fn() }))
}))

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
  await import('../../../db/migrations/553_hub_moves.js'),
  await import('../../../db/migrations/567_hub_capacity.js')
]
const { hubRoutes } = await import('../../../routes/hub.js')
const { sealStoredConnection } = await import('../../../services/hub/db/stored-connection.js')
const { tenantsBody } = await import('../../../services/hub/shared/tenants.js')
const { getShared } = await import('../../../services/hub/shared/store.js')

const admin = { 'x-user': 'aaaaaaaa-0000-4000-8000-000000000001', 'x-admin': '1' }
const saved = { HUB: process.env.HUB, KEY: process.env.ENCRYPTION_KEY }
let app: FastifyInstance

beforeAll(async () => {
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  for (const mig of migrations) await mig.up(db)
  await db.schema.createTable('nivaro_extension_settings', (t) => {
    t.increments('id')
    t.string('extension_id')
    t.string('key')
    t.text('value')
    t.dateTime('updated_at')
    t.string('updated_by')
  })
  app = Fastify()
  await app.register(hubRoutes, { prefix: '/api/hub' })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await db.destroy()
  process.env.HUB = saved.HUB
  process.env.ENCRYPTION_KEY = saved.KEY
})

beforeEach(async () => {
  vi.clearAllMocks()
  for (const t of [
    'nivaro_hub_apps',
    'nivaro_hub_environments',
    'nivaro_hub_placements',
    'nivaro_hub_shared_deployments',
    'nivaro_hub_moves',
    'nivaro_hub_databases',
    'nivaro_hub_app_limits'
  ])
    await db(t).del()
  await db('nivaro_hub_apps').insert({ id: 1, key: 'acme', name: 'Acme', extensions: '[]' })
  await db('nivaro_hub_shared_deployments').insert({
    id: 4,
    key: 'pool',
    name: 'Pool',
    mode: 'registered',
    link_url: 'https://pool.example.com',
    status: 'active'
  })
  await db('nivaro_hub_placements').insert({
    id: 31,
    kind: 'shared',
    shared_deployment_id: 4,
    target: '{}'
  })
  await db('nivaro_hub_databases').insert({
    id: 7,
    server_id: 1,
    engine: 'pg',
    host: 'pg.example.com',
    database_name: 'acme',
    login_name: 'acme_app',
    status: 'ready',
    adopted: true,
    connection: sealStoredConnection({
      engine: 'pg',
      host: 'pg.example.com',
      port: 5432,
      database: 'acme',
      user: 'acme_app',
      password: 'pw-1234',
      ssl_mode: 'require',
      trust_server_cert: false
    })
  })
  await db('nivaro_hub_environments').insert({
    id: 21,
    app_id: 1,
    key: 'prod',
    position: 0,
    status: 'active',
    base_url: 'https://acme.example.com',
    hostnames: '[]',
    placement_id: 31,
    db_ref: 'hub-db:7'
  })
})

const put = (payload: unknown, headers = admin) =>
  app.inject({
    method: 'PUT',
    url: '/api/hub/capacity/limits/21',
    headers,
    payload: payload as object
  })

describe('limits', () => {
  it('admin only', async () => {
    expect(
      (await put({ jobs: 2 }, { 'x-user': 'bbbbbbbb-0000-4000-8000-000000000002', 'x-admin': '0' }))
        .statusCode
    ).toBe(403)
  })

  it('refuses a bad value by name', async () => {
    const r = await put({ jobs: 99 })
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ code: 'BAD_LIMIT', field: 'jobs' })
  })

  it('stores, logs, asks the deployment to re-read, and lists the limits with the app', async () => {
    const r = await put({ requests_per_minute: 600, jobs: 2, storage_mb: null })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ data: { requests_per_minute: 600, jobs: 2 }, changed: true })
    expect(m.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'nivaro_hub_app_limits', item: '21' })
    )
    await vi.waitFor(() => expect(m.refresh).toHaveBeenCalled())
    const { body } = await tenantsBody((await getShared(4))!)
    expect(body.data.tenants[0].limits).toEqual({ requests_per_minute: 600, jobs: 2 })
    // The same again changes nothing and logs nothing.
    m.logActivity.mockClear()
    expect((await put({ requests_per_minute: 600, jobs: 2 })).json().changed).toBe(false)
    expect(m.logActivity).not.toHaveBeenCalled()
  })

  it('409 MOVE_OPEN while a move holds the environment', async () => {
    await db('nivaro_hub_moves').insert({
      id: 3,
      app_id: 1,
      environment_id: 21,
      from_placement_id: 31,
      to_placement_id: 31,
      kind: 'between_shared',
      routing: 'automatic',
      status: 'interrupted',
      steps: '{}'
    })
    const r = await put({ jobs: 2 })
    expect(r.statusCode).toBe(409)
    expect(r.json()).toMatchObject({ code: 'MOVE_OPEN', move_id: 3 })
  })
})

describe('reads', () => {
  it('overview, advice and rebalances answer for an admin', async () => {
    await db('nivaro_hub_capacity_samples').insert({
      sampled_at: new Date(),
      scope: 'shared',
      shared_deployment_id: 4,
      requests_per_min: 12
    })
    const o = await app.inject({ url: '/api/hub/capacity', headers: admin })
    expect(o.statusCode).toBe(200)
    expect(o.json().data.shared[0]).toMatchObject({ key: 'pool', latest: { requests_per_min: 12 } })
    expect((await app.inject({ url: '/api/hub/capacity/advice', headers: admin })).json()).toEqual({
      data: []
    })
    expect(
      (await app.inject({ url: '/api/hub/capacity/rebalances', headers: admin })).json()
    ).toEqual({ data: [] })
  })

  it('a rebalance plan needs two deployments', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/hub/capacity/rebalance/plan',
      headers: admin,
      payload: { shared_ids: [4] }
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().code).toBe('BAD_SHARED')
  })
})
