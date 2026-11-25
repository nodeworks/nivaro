import Fastify, { type FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub security (app side): /api/hub-link/security/* mounted inside the hub link, so every route
// is behind its bearer; grant + revoke end to end on real SQLite (roles + users + migration 578).

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
vi.mock('../../../config.js', () => ({ config: { NODE_ENV: 'production' } }))
vi.mock('../../../routes/preflight.js', () => ({ runPreflight: vi.fn() }))
vi.mock('../../../services/readiness.js', () => ({ readReadiness: vi.fn() }))
vi.mock('../../../services/pool-attribution.js', () => ({ poolCounters: vi.fn() }))
vi.mock('../../../services/instance-key.js', () => ({ instanceKey: () => 'production' }))
const m = vi.hoisted(() => ({
  logActivity: vi.fn(async (..._a: unknown[]) => null),
  revoke: vi.fn(async (..._a: unknown[]) => 2),
  notice: vi.fn((..._a: unknown[]) => undefined)
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: m.logActivity }))
vi.mock('../../../auth/session.js', () => ({ revokeUserSessions: m.revoke }))
vi.mock('../../../services/inactive-people-notice.js', () => ({ noteUsersDeactivated: m.notice }))
vi.mock('../../../services/users.js', async () => {
  const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
  return {
    updateUser: vi.fn(async (id: string, data: Record<string, unknown>) => {
      await db('nivaro_users').where({ id }).update(data)
      return db('nivaro_users').where({ id }).first()
    })
  }
})

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { hubLinkRoutes } = await import('../../../routes/hub-link.js')
const m578 = await import('../../../db/migrations/578_hub_security.js')
const { setAppRef } = await import('../../../services/io-holder.js')
// The open-grants marker needs a Redis (a grant is refused without it).
const marker = new Map<string, string>()
setAppRef({
  redis: {
    get: async (k: string) => marker.get(k) ?? null,
    set: async (k: string, v: string) => marker.set(k, v),
    eval: async (_s: string, _n: number, k: string, v: string) =>
      marker.get(k) === v ? marker.delete(k) : 0
  }
})

const TOKEN = `${'t'.repeat(20)}People-Hub-Token-xyz-123`
const ADMIN_ROLE = '0A000000-0000-4000-8000-000000000001'
const STAFF_ROLE = '0C000000-0000-4000-8000-000000000003'
const ANNA = '1A000000-0000-4000-8000-000000000001' // admin
const BOB = '1B000000-0000-4000-8000-000000000002' // staff, Entra
const CARL = '1C000000-0000-4000-8000-000000000003' // admin
const BOT = '1D000000-0000-4000-8000-000000000004' // service account with Bob's email

let app: FastifyInstance
const saved = process.env.HUB_TOKEN

beforeAll(async () => {
  process.env.HUB_TOKEN = TOKEN
  await db.schema.createTable('nivaro_roles', (t) => {
    t.uuid('id').primary()
    t.string('name', 100)
    t.boolean('admin_access').defaultTo(false)
    t.dateTime('created_at')
  })
  await db.schema.createTable('nivaro_users', (t) => {
    t.uuid('id').primary()
    t.string('email', 255)
    t.string('first_name', 100)
    t.string('last_name', 100)
    t.dateTime('last_access')
    t.dateTime('created_at')
    t.uuid('role')
    t.string('status', 50).defaultTo('active')
    t.string('account_kind', 30)
    t.string('entra_oid', 64)
    t.string('entra_tid', 64)
    t.dateTime('updated_at')
  })
  await m578.up(db)
  app = Fastify()
  await app.register(hubLinkRoutes, { prefix: '/api/hub-link' })
  await app.ready()
})
afterAll(async () => {
  await app.close()
  await db.destroy()
  if (saved === undefined) delete process.env.HUB_TOKEN
  else process.env.HUB_TOKEN = saved
})
beforeEach(async () => {
  vi.clearAllMocks()
  await db('nivaro_users').del()
  await db('nivaro_roles').del()
  await db('nivaro_roles').insert([
    { id: ADMIN_ROLE, name: 'Administrator', admin_access: true },
    { id: STAFF_ROLE, name: 'Staff', admin_access: false }
  ])
  await db('nivaro_users').insert([
    { id: ANNA, email: 'Anna@Example.com', role: ADMIN_ROLE, status: 'active' },
    {
      id: BOB,
      email: 'bob@example.com',
      role: STAFF_ROLE,
      status: 'active',
      entra_oid: 'aaaa-1111',
      entra_tid: 'tttt-0000'
    },
    { id: CARL, email: 'carl@example.com', role: ADMIN_ROLE, status: 'active' },
    {
      id: BOT,
      email: 'bob@example.com',
      role: ADMIN_ROLE,
      status: 'active',
      account_kind: 'service'
    }
  ])
})

const call = (method: 'GET' | 'POST', path: string, payload?: unknown, auth = `Bearer ${TOKEN}`) =>
  app.inject({
    method,
    url: `/api/hub-link/security/${path}`,
    headers: auth ? { authorization: auth } : {},
    ...(payload === undefined ? {} : { payload: payload as never })
  })

describe('/api/hub-link/security/*', () => {
  it('every route needs the hub token', async () => {
    for (const [method, path] of [
      ['GET', 'role-holders'],
      ['POST', 'break-glass'],
      ['POST', 'break-glass/revoke'],
      ['GET', 'role-holders/../role-holders'],
      ['GET', 'role-holders?x=/api/hub-link/status']
    ] as const) {
      expect((await call(method, path, method === 'POST' ? {} : undefined, '')).statusCode).toBe(
        401
      )
      expect(
        (await call(method, path, method === 'POST' ? {} : undefined, 'Bearer nope')).statusCode
      ).toBe(401)
    }
  })

  it('reads role holders and grants + revokes break-glass', async () => {
    const holders = await call('GET', 'role-holders')
    expect(holders.statusCode).toBe(200)
    expect(holders.json().accounts.map((a: { user_id: string }) => a.user_id)).toEqual(
      expect.arrayContaining([ANNA, BOB, CARL, BOT])
    )
    const until = new Date(Date.now() + 2 * 3_600_000).toISOString()
    const g = await call('POST', 'break-glass', {
      ref: 'bg-41',
      emails: ['bob@example.com'],
      entra: [{ oid: 'aaaa-1111', tid: 'tttt-0000' }],
      hours: 2,
      until,
      reason: 'Release the stuck import'
    })
    expect(g.json()).toMatchObject({ state: 'granted', user_id: BOB })
    expect((await db('nivaro_users').where({ id: BOB }).first()).role).toBe(ADMIN_ROLE)
    const r = await call('POST', 'break-glass/revoke', { ref: 'bg-41', user_id: BOB })
    expect(r.json()).toEqual({ state: 'revoked' })
    expect((await db('nivaro_users').where({ id: BOB }).first()).role).toBe(STAFF_ROLE)
    expect(m.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'hub-break-glass-grant', item: BOB })
    )
  })
})
