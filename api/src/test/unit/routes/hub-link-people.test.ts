import Fastify, { type FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub people (app side): POST /api/hub-link/people/lookup|suspend. Real SQLite for roles + users;
// the user service, the session store, the activity log and the notice are mocked.

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
const { readPeopleQuery } = await import('../../../services/hub-link/people.js')

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
    t.uuid('role')
    t.string('status', 50).defaultTo('active')
    t.string('account_kind', 30)
    t.string('entra_oid', 64)
    t.string('entra_tid', 64)
    t.dateTime('updated_at')
  })
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

const post = (path: string, payload: unknown, auth = `Bearer ${TOKEN}`) =>
  app.inject({
    method: 'POST',
    url: `/api/hub-link/people/${path}`,
    headers: { authorization: auth },
    payload: payload as never
  })

describe('readPeopleQuery', () => {
  it('needs an email or an Entra id, at most 5 of each, nothing else', () => {
    expect(readPeopleQuery({})).toBeNull()
    expect(readPeopleQuery({ emails: ['not an email'] })).toBeNull()
    expect(
      readPeopleQuery({ emails: Array.from({ length: 6 }, (_, i) => `a${i}@x.io`) })
    ).toBeNull()
    expect(readPeopleQuery({ entra: [{ oid: 'bad id!' }] })).toBeNull()
    expect(readPeopleQuery({ emails: [' A@X.io ', 'a@x.io'] })).toEqual({
      emails: ['a@x.io'],
      entra: [],
      user_ids: []
    })
  })
})

describe('POST /people/lookup', () => {
  it('needs the hub token', async () => {
    expect((await post('lookup', { emails: ['bob@example.com'] }, 'Bearer nope')).statusCode).toBe(
      401
    )
  })

  it('matches people by email (case-insensitive) or Entra id, never a service account', async () => {
    const r = await post('lookup', { emails: ['anna@example.com', 'bob@example.com'] })
    expect(r.statusCode).toBe(200)
    const ids = r
      .json()
      .accounts.map((a: { user_id: string }) => a.user_id)
      .sort()
    expect(ids).toEqual([ANNA, BOB].sort())
    const anna = r.json().accounts.find((a: { user_id: string }) => a.user_id === ANNA)
    expect(anna).toMatchObject({ role: 'Administrator', admin: true, status: 'active' })
    const byOid = await post('lookup', { entra: [{ oid: 'AAAA-1111', tid: 'tttt-0000' }] })
    expect(byOid.json().accounts).toEqual([
      { user_id: BOB, status: 'active', role: 'Staff', admin: false, matched_by: 'entra' }
    ])
    // Another tenant's object id is another person.
    expect(
      (await post('lookup', { entra: [{ oid: 'aaaa-1111', tid: 'other' }] })).json().accounts
    ).toEqual([])
  })

  it('400 for a body with nothing to match on (never matches everyone)', async () => {
    const r = await post('lookup', { emails: [] })
    expect(r.statusCode).toBe(400)
    expect(r.json().code).toBe('BAD_PERSON')
  })
})

describe('POST /people/suspend', () => {
  it('suspends the matching person, ends their sessions, logs it; never deletes', async () => {
    const r = await post('suspend', { emails: ['bob@example.com'] })
    expect(r.statusCode).toBe(200)
    expect(r.json().state).toBe('suspended')
    const bob = await db('nivaro_users').where({ id: BOB }).first()
    expect(bob.status).toBe('suspended')
    // The service account with the same email is untouched.
    expect((await db('nivaro_users').where({ id: BOT }).first()).status).toBe('active')
    expect(m.revoke).toHaveBeenCalledTimes(0) // no Redis on this test app
    expect(m.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'hub-offboard', item: BOB, origin: 'integration' })
    )
    expect(m.notice).toHaveBeenCalledWith([BOB], expect.objectContaining({ reason: 'offboarding' }))
    expect(await db('nivaro_users').count({ n: '*' })).toEqual([{ n: 4 }])
    // Again: already suspended, nothing written.
    m.logActivity.mockClear()
    const again = await post('suspend', { emails: ['bob@example.com'] })
    expect(again.json().state).toBe('already')
    expect(m.logActivity).not.toHaveBeenCalled()
  })

  it('answers none for a person with no account here', async () => {
    const r = await post('suspend', { emails: ['nobody@example.com'] })
    expect(r.json()).toEqual({ state: 'none', accounts: [] })
  })

  it('refuses LAST_ADMIN and writes nothing when no active admin would be left', async () => {
    expect((await post('suspend', { emails: ['anna@example.com'] })).json().state).toBe('suspended')
    const r = await post('suspend', { emails: ['carl@example.com'] })
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('LAST_ADMIN')
    expect((await db('nivaro_users').where({ id: CARL }).first()).status).toBe('active')
  })
})

describe('POST /people/suspend under concurrency (M1)', () => {
  it('the last two admins offboarded at once: one is suspended, the other refused LAST_ADMIN', async () => {
    const [a, b] = await Promise.all([
      post('suspend', { emails: ['anna@example.com'] }),
      post('suspend', { emails: ['carl@example.com'] })
    ])
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409])
    const active = await db('nivaro_users')
      .whereIn('id', [ANNA, CARL])
      .where({ status: 'active' })
      .count({ n: '*' })
    expect(active).toEqual([{ n: 1 }])
  })

  it('a lookup is logged in the app with the matched account only, never the asked email', async () => {
    m.logActivity.mockClear()
    await post('lookup', { emails: ['bob@example.com'] })
    expect(m.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'hub-people-lookup', item: BOB, origin: 'integration' })
    )
    expect(JSON.stringify(m.logActivity.mock.calls)).not.toContain('bob@example.com')
  })
})
