import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import Fastify, { type FastifyInstance } from 'fastify'
import knexLib, { type Knex } from 'knex'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 3: POST /api/hub-link/first-admin (app side). Real SQLite (a scratch file,
// several connections, as a SQLite install runs) for nivaro_roles + nivaro_users; the activity
// log and the security alert are mocked. node:crypto's timingSafeEqual is wrapped (not
// replaced) so the bearer compare can be seen to be timing-safe.

const h = vi.hoisted(() => ({ dir: '', db: null as unknown }))

vi.mock('node:crypto', async (orig) => {
  const real = await orig<typeof import('node:crypto')>()
  const { vi: v } = await import('vitest')
  return { ...real, default: real, timingSafeEqual: v.fn(real.timingSafeEqual) }
})
vi.mock('../../../db/index.js', async () => {
  // Cached: a second copy of the service module (vi.resetModules) gets the same default pool.
  if (h.db) return { db: h.db }
  const { mkdtempSync: mk } = await import('node:fs')
  const { tmpdir: td } = await import('node:os')
  const { join: j } = await import('node:path')
  const knex = (await import('knex')).default
  const { sqliteAfterCreate, sqliteCompat } = await import('../../../db/sqlite.js')
  sqliteCompat()
  h.dir = mk(j(td(), 'hub-first-admin-'))
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: j(h.dir, 'app.sqlite') },
    useNullAsDefault: true,
    pool: { min: 1, max: 4, afterCreate: sqliteAfterCreate }
  })
  h.db = db
  return { db }
})
vi.mock('../../../config.js', () => ({ config: { NODE_ENV: 'production' } }))
vi.mock('../../../routes/preflight.js', () => ({ runPreflight: vi.fn() }))
vi.mock('../../../services/readiness.js', () => ({ readReadiness: vi.fn() }))
vi.mock('../../../services/pool-attribution.js', () => ({ poolCounters: vi.fn() }))
vi.mock('../../../services/instance-key.js', () => ({ instanceKey: () => 'production' }))
const m = vi.hoisted(() => ({
  logActivity: vi.fn<(...a: any[]) => any>(),
  noteUserRoleChange: vi.fn<(...a: any[]) => any>()
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: m.logActivity }))
vi.mock('../../../services/security-alerts.js', () => ({
  noteUserRoleChange: m.noteUserRoleChange
}))

const crypto = await import('node:crypto')
const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { hubLinkRoutes, _resetHubLinkForTests } = await import('../../../routes/hub-link.js')
const { seedFirstAdmin, oldestAdminRoleQuery, withLockWait } = await import(
  '../../../services/hub-link/first-admin.js'
)
const { sqliteAfterCreate } = await import('../../../db/sqlite.js')

const TOKEN = `${'t'.repeat(20)}S3cr3tHubT0ken-xyz` // 39 chars
const ADMIN_ROLE = '0A000000-0000-4000-8000-000000000001'
const LATER_ADMIN_ROLE = '0B000000-0000-4000-8000-000000000002'
const STAFF_ROLE = '0C000000-0000-4000-8000-000000000003'

let app: FastifyInstance | null = null
let logText = ''
const saved = { HUB_TOKEN: process.env.HUB_TOKEN, CLOUD: process.env.CLOUD_META_DB_URL }

async function build(): Promise<FastifyInstance> {
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logText += chunk.toString()
      cb()
    }
  })
  const a = Fastify({ logger: { level: 'trace', stream } })
  await a.register(hubLinkRoutes, { prefix: '/api/hub-link' })
  await a.ready()
  app = a
  return a
}

function post(a: FastifyInstance, payload: unknown, bearer: string | null = TOKEN) {
  return a.inject({
    method: 'POST',
    url: '/api/hub-link/first-admin',
    headers: bearer == null ? {} : { authorization: `Bearer ${bearer}` },
    payload: payload as Record<string, unknown>
  })
}

async function users() {
  return (await db('nivaro_users').select('*').orderBy('email')) as Array<Record<string, any>>
}

async function addUser(row: Record<string, unknown>) {
  await db('nivaro_users').insert({
    id: crypto.randomUUID(),
    status: 'active',
    created_at: new Date(),
    updated_at: new Date(),
    ...row
  })
}

beforeAll(async () => {
  await db.schema.createTable('nivaro_roles', (t) => {
    t.uuid('id').primary()
    t.string('name', 100)
    t.boolean('admin_access').defaultTo(false)
    t.boolean('app_access').defaultTo(true)
    t.timestamp('created_at').nullable()
    t.timestamp('updated_at').nullable()
  })
  await db.schema.createTable('nivaro_users', (t) => {
    t.uuid('id').primary()
    t.string('first_name', 255)
    t.string('last_name', 255)
    // Not unique here: Postgres' case-sensitive unique index lets case twins exist.
    t.string('email', 255).notNullable()
    t.string('external_id', 500)
    t.uuid('role')
    t.string('status', 50).notNullable().defaultTo('active')
    t.string('account_kind', 30)
    t.boolean('is_redacted').defaultTo(false)
    t.timestamp('created_at').nullable()
    t.timestamp('updated_at').nullable()
  })
})

afterAll(async () => {
  await db.destroy()
  if (h.dir) rmSync(h.dir, { recursive: true, force: true })
})

beforeEach(async () => {
  _resetHubLinkForTests()
  logText = ''
  process.env.HUB_TOKEN = TOKEN
  delete process.env.CLOUD_META_DB_URL
  m.logActivity.mockReset().mockResolvedValue(1)
  m.noteUserRoleChange.mockReset()
  vi.mocked(crypto.timingSafeEqual).mockClear()
  await db('nivaro_users').delete()
  await db('nivaro_roles').delete()
  await db('nivaro_roles').insert([
    // The later admin role is inserted first: "oldest" is by created_at, not insert order.
    {
      id: LATER_ADMIN_ROLE,
      name: 'Admins 2',
      admin_access: true,
      created_at: new Date('2026-05-01T00:00:00Z')
    },
    {
      id: ADMIN_ROLE,
      name: 'Administrator',
      admin_access: true,
      created_at: new Date('2026-01-01T00:00:00Z')
    },
    { id: STAFF_ROLE, name: 'Staff', admin_access: false, created_at: new Date('2025-01-01') }
  ])
})

afterEach(async () => {
  await app?.close()
  app = null
  if (saved.HUB_TOKEN === undefined) delete process.env.HUB_TOKEN
  else process.env.HUB_TOKEN = saved.HUB_TOKEN
  if (saved.CLOUD === undefined) delete process.env.CLOUD_META_DB_URL
  else process.env.CLOUD_META_DB_URL = saved.CLOUD
})

describe('POST /api/hub-link/first-admin', () => {
  it('creates the first admin with the oldest admin role, active, no external id', async () => {
    const a = await build()
    const res = await post(a, {
      email: '  Pat.Admin@Example.com ',
      first_name: ' Pat ',
      last_name: 'Admin'
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.created).toBe(true)
    expect(typeof body.user_id).toBe('string')
    expect(Object.keys(body).sort()).toEqual(['created', 'user_id'])
    const [u] = await users()
    expect(u.id).toBe(body.user_id)
    expect(u.email).toBe('Pat.Admin@Example.com')
    expect(u.first_name).toBe('Pat')
    expect(u.last_name).toBe('Admin')
    expect(String(u.role).toUpperCase()).toBe(ADMIN_ROLE)
    expect(u.status).toBe('active')
    expect(u.external_id).toBeNull()
    expect(m.logActivity).toHaveBeenCalledTimes(1)
    expect(m.logActivity.mock.calls[0][0]).toMatchObject({
      action: 'hub-first-admin',
      user: null,
      collection: 'nivaro_users',
      item: body.user_id
    })
    expect(m.noteUserRoleChange).toHaveBeenCalledWith(
      expect.objectContaining({ actor: null, userId: body.user_id, created: true })
    )
  })

  it('moves an existing active non-admin with that email (any case) to the admin role', async () => {
    await addUser({ email: 'sam@example.com', role: STAFF_ROLE })
    const a = await build()
    const res = await post(a, { email: 'SAM@example.com' })
    expect(res.statusCode).toBe(201)
    expect(res.json().created).toBe(false)
    const all = await users()
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe(res.json().user_id)
    expect(String(all[0].role).toUpperCase()).toBe(ADMIN_ROLE)
    expect(all[0].status).toBe('active')
    expect(m.noteUserRoleChange).toHaveBeenCalledTimes(1)
    const alert = m.noteUserRoleChange.mock.calls[0][0]
    expect(alert).toMatchObject({ actor: null, source: 'hub', created: false })
    expect(String(alert.fromRole).toUpperCase()).toBe(STAFF_ROLE)
    expect(String(alert.toRole).toUpperCase()).toBe(ADMIN_ROLE)
  })

  it('never re-enables a disabled person: 409 PERSON_DISABLED, nothing written', async () => {
    await addUser({ email: 'boss@example.com', role: ADMIN_ROLE, status: 'suspended' })
    await addUser({ email: 'staff@example.com', role: STAFF_ROLE, status: 'suspended' })
    await addUser({ email: 'old@example.com', role: STAFF_ROLE, status: 'archived' })
    await addUser({ email: 'idle@example.com', role: STAFF_ROLE, status: 'inactive' })
    await addUser({ email: 'gone@example.com', role: STAFF_ROLE, is_redacted: true })
    const before = await users()
    const a = await build()
    for (const email of [
      'boss@example.com', // a suspended admin, already in the oldest admin role
      'staff@example.com', // a suspended staff member
      'old@example.com',
      'idle@example.com',
      'gone@example.com' // redacted, even if active
    ]) {
      const res = await post(a, { email })
      expect(res.statusCode, email).toBe(409)
      expect(res.json().code).toBe('PERSON_DISABLED')
    }
    expect(await users()).toEqual(before)
    expect(m.logActivity).not.toHaveBeenCalled()
    expect(m.noteUserRoleChange).not.toHaveBeenCalled()
  })

  it('activates and moves a person not yet started (pending), and raises the alert', async () => {
    await addUser({ email: 'new@example.com', role: STAFF_ROLE, status: 'pending' })
    const a = await build()
    const res = await post(a, { email: 'new@example.com' })
    expect(res.statusCode).toBe(201)
    expect(res.json().created).toBe(false)
    const [u] = await users()
    expect(u.status).toBe('active')
    expect(String(u.role).toUpperCase()).toBe(ADMIN_ROLE)
    expect(m.noteUserRoleChange).toHaveBeenCalledTimes(1)
    expect(m.noteUserRoleChange.mock.calls[0][0]).toMatchObject({
      actor: null,
      source: 'hub',
      created: false,
      fromRole: null
    })
  })

  it('a pending person already in the admin role is activated, and the alert still fires', async () => {
    await addUser({ email: 'draft@example.com', role: ADMIN_ROLE, status: 'invited' })
    const a = await build()
    const res = await post(a, { email: 'draft@example.com' })
    expect(res.statusCode).toBe(201)
    const [u] = await users()
    expect(u.status).toBe('active')
    const alert = m.noteUserRoleChange.mock.calls[0][0]
    // "From no role": the role did not change, but the person gained admin access.
    expect(alert.fromRole).toBeNull()
    expect(String(alert.toRole).toUpperCase()).toBe(ADMIN_ROLE)
    expect(alert.source).toBe('hub')
  })

  it('case twins: the exact spelling wins; no exact one is 409 AMBIGUOUS_EMAIL', async () => {
    await addUser({ email: 'Twin@Example.com', role: STAFF_ROLE })
    await addUser({ email: 'twin@example.com', role: STAFF_ROLE })
    const a = await build()
    const vague = await post(a, { email: 'TWIN@example.com' })
    expect(vague.statusCode).toBe(409)
    expect(vague.json().code).toBe('AMBIGUOUS_EMAIL')
    expect((await users()).every((u) => String(u.role).toUpperCase() === STAFF_ROLE)).toBe(true)

    const exact = await post(a, { email: 'twin@example.com' })
    expect(exact.statusCode).toBe(201)
    const promoted = (await users()).find((u) => u.id === exact.json().user_id)
    expect(promoted?.email).toBe('twin@example.com')
    expect(String(promoted?.role).toUpperCase()).toBe(ADMIN_ROLE)
  })

  it('a second call once an admin exists answers 409 HAS_ADMIN and writes nothing', async () => {
    const a = await build()
    expect((await post(a, { email: 'first@example.com' })).statusCode).toBe(201)
    const before = await users()
    m.logActivity.mockClear()
    m.noteUserRoleChange.mockClear()

    const again = await post(a, { email: 'second@example.com' })
    expect(again.statusCode).toBe(409)
    expect(again.json().code).toBe('HAS_ADMIN')
    // Same email again: still refused (the runner reads it as done), nothing moved.
    const same = await post(a, { email: 'first@example.com', first_name: 'Changed' })
    expect(same.statusCode).toBe(409)
    expect(same.json().code).toBe('HAS_ADMIN')

    expect(await users()).toEqual(before)
    expect(m.logActivity).not.toHaveBeenCalled()
    expect(m.noteUserRoleChange).not.toHaveBeenCalled()
  })

  it('an existing admin (created any other way) refuses, even for an existing non-admin email', async () => {
    await addUser({ email: 'boss@example.com', role: LATER_ADMIN_ROLE })
    await addUser({ email: 'staff@example.com', role: STAFF_ROLE })
    const a = await build()
    const res = await post(a, { email: 'staff@example.com' })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('HAS_ADMIN')
    const staff = (await users()).find((u) => u.email === 'staff@example.com')
    expect(String(staff?.role).toUpperCase()).toBe(STAFF_ROLE)
  })

  it('a suspended admin or an admin-role service account does not count as an admin', async () => {
    await addUser({ email: 'gone@example.com', role: ADMIN_ROLE, status: 'suspended' })
    await addUser({ email: 'bot@example.com', role: ADMIN_ROLE, account_kind: 'machine' })
    const a = await build()
    const res = await post(a, { email: 'new@example.com' })
    expect(res.statusCode).toBe(201)
    expect(res.json().created).toBe(true)
  })

  it('a fresh install (no roles at all) gets the Administrator role with its first admin (P3-33)', async () => {
    await db('nivaro_roles').delete()
    const a = await build()
    const res = await post(a, { email: 'pat@example.com', first_name: 'Pat' })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().created).toBe(true)
    const roles = (await db('nivaro_roles').select('*')) as Array<Record<string, any>>
    expect(roles).toHaveLength(1)
    expect(roles[0]).toMatchObject({ name: 'Administrator' })
    expect(Boolean(roles[0].admin_access)).toBe(true)
    expect(Boolean(roles[0].app_access)).toBe(true)
    const [u] = await users()
    expect(u).toMatchObject({ email: 'pat@example.com', role: roles[0].id, status: 'active' })
    // Once that admin exists: HAS_ADMIN, nothing more written (no second role, no second person).
    const again = await post(a, { email: 'sam@example.com' })
    expect(again.statusCode).toBe(409)
    expect(again.json().code).toBe('HAS_ADMIN')
    expect(await db('nivaro_roles').count({ n: '*' }).first()).toMatchObject({ n: 1 })
    expect(await users()).toHaveLength(1)
  })

  it('no admin role but "Administrator" taken by another role: the new one is "Administrator (Hub)"', async () => {
    await db('nivaro_roles').where('admin_access', true).delete()
    await db('nivaro_roles').where({ id: STAFF_ROLE }).update({ name: 'Administrator' })
    const a = await build()
    const res = await post(a, { email: 'pat@example.com' })
    expect(res.statusCode, res.body).toBe(201)
    const made = await db('nivaro_roles').where('admin_access', true).first()
    expect(made?.name).toBe('Administrator (Hub)')
    expect((await users())[0].role).toBe(made?.id)
  })

  it('a role made for the first admin is rolled back with a refused person (nothing written)', async () => {
    await db('nivaro_roles').where('admin_access', true).delete()
    await addUser({ email: 'pat@example.com', role: STAFF_ROLE, status: 'suspended' })
    const a = await build()
    const res = await post(a, { email: 'pat@example.com' })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('PERSON_DISABLED')
    expect(await db('nivaro_roles').where('admin_access', true)).toEqual([])
  })

  it('refuses a missing, malformed or too long email with 400 BAD_EMAIL', async () => {
    const a = await build()
    for (const payload of [
      {},
      { email: 42 },
      { email: '   ' },
      { email: 'not-an-address' },
      { email: 'a b@example.com' },
      { email: 'x@nodot' },
      { email: `${'a'.repeat(250)}@example.com` }
    ]) {
      const res = await post(a, payload)
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
      expect(res.json().code).toBe('BAD_EMAIL')
    }
    expect(await users()).toEqual([])
  })

  it('an address held only by a service account is refused, not promoted', async () => {
    await addUser({ email: 'svc@example.com', role: STAFF_ROLE, account_kind: 'machine' })
    const a = await build()
    const res = await post(a, { email: 'svc@example.com' })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('BAD_EMAIL')
    const [svc] = await users()
    expect(String(svc.role).toUpperCase()).toBe(STAFF_ROLE)
  })

  it('concurrent calls: exactly one wins, the rest answer HAS_ADMIN', async () => {
    const a = await build()
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => post(a, { email: `racer${i}@example.com` }))
    )
    const won = results.filter((r) => r.statusCode === 201)
    const lost = results.filter((r) => r.statusCode === 409)
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(7)
    for (const r of lost) expect(r.json().code).toBe('HAS_ADMIN')
    const all = await users()
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe(won[0].json().user_id)
    expect(m.logActivity).toHaveBeenCalledTimes(1)
  })

  it('two module copies (two processes: own queue, own pool) on one database: one admin', async () => {
    // A second copy of the service has its own in-process queue, so only the database
    // transaction keeps the two apart; it gets its own pool on the same SQLite file.
    const k2 = knexLib({
      client: 'better-sqlite3',
      connection: { filename: join(h.dir, 'app.sqlite') },
      useNullAsDefault: true,
      pool: { min: 1, max: 4, afterCreate: sqliteAfterCreate }
    })
    try {
      vi.resetModules()
      const copyB = await import('../../../services/hub-link/first-admin.js')
      expect(copyB.seedFirstAdmin).not.toBe(seedFirstAdmin)
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          i % 2 === 0
            ? seedFirstAdmin({ email: `a${i}@example.com` }, db)
            : copyB.seedFirstAdmin({ email: `b${i}@example.com` }, k2)
        )
      )
      expect(results.filter((r) => r.ok)).toHaveLength(1)
      expect(results.filter((r) => !r.ok && r.code === 'HAS_ADMIN')).toHaveLength(7)
      const admins = (await users()).filter((u) => String(u.role).toUpperCase() === ADMIN_ROLE)
      expect(admins).toHaveLength(1)
    } finally {
      await k2.destroy()
    }
  })

  describe('the bearer', () => {
    it('no bearer → 401 HUB_LINK_REFUSED, nothing written', async () => {
      const a = await build()
      const res = await post(a, { email: 'pat@example.com' }, null)
      expect(res.statusCode).toBe(401)
      expect(res.json().code).toBe('HUB_LINK_REFUSED')
      expect(await users()).toEqual([])
    })

    it('a wrong bearer (other text, a prefix, a longer one) → 401, nothing written', async () => {
      const a = await build()
      for (const bad of ['x'.repeat(39), TOKEN.slice(0, 32), `${TOKEN}x`, TOKEN.toUpperCase()]) {
        const res = await post(a, { email: 'pat@example.com' }, bad)
        expect(res.statusCode).toBe(401)
        expect(res.json().code).toBe('HUB_LINK_REFUSED')
      }
      expect(await users()).toEqual([])
    })

    it('is compared timing-safe: equal-length digests, whatever length was sent', async () => {
      const a = await build()
      const safeEqual = vi.mocked(crypto.timingSafeEqual)
      await post(a, { email: 'pat@example.com' }, 'short')
      await post(a, { email: 'pat@example.com' }, 'y'.repeat(500))
      expect(safeEqual).toHaveBeenCalledTimes(2)
      for (const [x, y] of safeEqual.mock.calls) {
        expect((x as Buffer).length).toBe(32)
        expect((y as Buffer).length).toBe(32)
      }
      safeEqual.mockClear()
      expect((await post(a, { email: 'pat@example.com' })).statusCode).toBe(201)
      expect(safeEqual).toHaveBeenCalledTimes(1)
    })

    it('a HUB_TOKEN shorter than 32 characters mounts nothing (404, even with that bearer)', async () => {
      process.env.HUB_TOKEN = 'short-hub-token'
      const a = await build()
      const res = await post(a, { email: 'pat@example.com' }, 'short-hub-token')
      expect(res.statusCode).toBe(404)
      expect(await users()).toEqual([])
    })

    it('no HUB_TOKEN: the route is absent', async () => {
      delete process.env.HUB_TOKEN
      const a = await build()
      const res = await post(a, { email: 'pat@example.com' })
      expect(res.statusCode).toBe(404)
    })

    it('cloud mode: the route is absent', async () => {
      process.env.CLOUD_META_DB_URL = 'postgres://meta'
      const a = await build()
      const res = await post(a, { email: 'pat@example.com' })
      expect(res.statusCode).toBe(404)
      expect(await users()).toEqual([])
    })
  })

  it('never puts the token in a response, a log line or the activity row', async () => {
    const wrong = `${'w'.repeat(30)}WrongTokenValue`
    const a = await build()
    const bodies: string[] = []
    bodies.push((await post(a, { email: 'pat@example.com' }, wrong)).body)
    bodies.push((await post(a, { email: 'bad' })).body)
    bodies.push((await post(a, { email: 'pat@example.com' })).body)
    bodies.push((await post(a, { email: 'two@example.com' })).body)
    // A database failure answers a generic 500 and logs without the request's headers.
    const spy = vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('disk I/O error'))
    await db('nivaro_users').delete()
    const failed = await post(a, { email: 'three@example.com' })
    spy.mockRestore()
    expect(failed.statusCode).toBe(500)
    expect(failed.json().code).toBe('FIRST_ADMIN_FAILED')
    expect(failed.body).not.toContain('disk I/O')
    bodies.push(failed.body)

    const everything = [
      ...bodies,
      logText,
      JSON.stringify(m.logActivity.mock.calls),
      JSON.stringify(m.noteUserRoleChange.mock.calls)
    ].join('\n')
    expect(logText.length).toBeGreaterThan(0)
    expect(everything).not.toContain(TOKEN)
    expect(everything).not.toContain('S3cr3tHubT0ken')
    expect(everything).not.toContain(wrong)
    expect(everything).not.toContain('WrongTokenValue')
  })
})

describe('withLockWait', () => {
  function fakeTrx(client: string, read: unknown) {
    const sql: string[] = []
    const trx = {
      client: { config: { client } },
      raw: async (q: string) => {
        sql.push(q)
        return /^SELECT/.test(q) ? read : []
      }
    }
    return { trx: trx as unknown as Knex.Transaction, sql }
  }

  it('SQL Server: bounds the wait and puts the previous value back, also on a failure', async () => {
    const ok = fakeTrx('mssql', [{ t: -1 }])
    expect(await withLockWait(ok.trx, async () => 'done')).toBe('done')
    expect(ok.sql).toEqual([
      'SELECT @@LOCK_TIMEOUT AS t',
      'SET LOCK_TIMEOUT 10000',
      'SET LOCK_TIMEOUT -1'
    ])
    const bad = fakeTrx('mssql', [{ t: 5000 }])
    await expect(
      withLockWait(bad.trx, async () => {
        throw new Error('Lock request time out period exceeded')
      })
    ).rejects.toThrow(/time out/)
    expect(bad.sql.at(-1)).toBe('SET LOCK_TIMEOUT 5000')
  })

  it('MySQL / MariaDB: innodb_lock_wait_timeout for the session, restored', async () => {
    const t = fakeTrx('mysql2', [[{ t: 50 }], []])
    await withLockWait(t.trx, async () => null)
    expect(t.sql).toEqual([
      'SELECT @@SESSION.innodb_lock_wait_timeout AS t',
      'SET SESSION innodb_lock_wait_timeout = 10',
      'SET SESSION innodb_lock_wait_timeout = 50'
    ])
  })

  it('Postgres: SET LOCAL (ends with the transaction); SQLite: nothing', async () => {
    const pg = fakeTrx('pg', { rows: [] })
    await withLockWait(pg.trx, async () => null)
    expect(pg.sql).toEqual(["SET LOCAL lock_timeout = '10s'"])
    const lite = fakeTrx('better-sqlite3', [])
    await withLockWait(lite.trx, async () => null)
    expect(lite.sql).toEqual([])
  })
})

describe('oldestAdminRoleQuery', () => {
  it('locks the oldest admin role row on every engine', () => {
    const sql = (client: string) =>
      oldestAdminRoleQuery(knexLib({ client })).toString().replace(/\s+/g, ' ')
    expect(sql('mssql')).toMatch(/with \(UPDLOCK\)/i)
    expect(sql('mssql')).toMatch(/order by \[created_at\] asc, \[id\] asc/i)
    expect(sql('pg')).toMatch(/for update/i)
    expect(sql('pg')).toMatch(/"created_at" asc NULLS FIRST, "id" asc/)
    expect(sql('mysql2')).toMatch(/for update/i)
  })
})
