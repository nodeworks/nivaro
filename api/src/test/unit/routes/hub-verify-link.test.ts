import Fastify, { type FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Hub verification, APP side (routes/hub-verify-link.ts + services/hub-link/verify.ts) on an
// in-memory SQLite: the bearer, the read list the Hub may send, smoke reads run in-process as the
// app's service identity with a temporary read-only key (gone afterwards), facts-only answers,
// and the extension inventory.

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

const TOKEN = 'h'.repeat(40)
process.env.HUB_TOKEN = TOKEN
const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { hubVerifyLinkRoutes } = await import('../../../routes/hub-verify-link.js')
const verify = await import('../../../services/hub-link/verify.js')
const { extensionRegistry } = await import('../../../extensions/loader.js')

let app: FastifyInstance
const seenAuth: string[] = []
const keysDuringRead: number[] = []
let maxInFlight = 0

beforeAll(async () => {
  await db.schema.createTable('nivaro_roles', (t) => {
    t.string('id').primary()
    t.string('name').unique()
    t.text('description')
    t.boolean('admin_access')
    t.boolean('app_access').defaultTo(true)
  })
  await db.schema.createTable('nivaro_policies', (t) => {
    t.increments('id')
    t.string('role')
    t.string('collection')
    t.string('action')
    t.text('fields')
  })
  await db.schema.createTable('nivaro_extension_settings', (t) => {
    t.increments('id')
    t.string('extension_id')
    t.string('key')
    t.text('value')
    t.dateTime('updated_at')
    t.unique(['extension_id', 'key'])
  })
  await db.schema.createTable('nivaro_users', (t) => {
    t.string('id').primary()
    t.string('email').unique()
    t.string('first_name')
    t.string('status')
    t.string('account_kind')
    t.string('role')
    t.string('password_hash')
    t.string('entra_oid')
    t.string('external_id')
    t.string('static_token')
  })
  await db.schema.createTable('nivaro_api_keys', (t) => {
    t.increments('id')
    t.string('name')
    t.string('key_hash')
    t.string('prefix')
    t.string('user')
    t.text('scopes')
    t.dateTime('expires_at')
    t.integer('rate_limit_per_minute')
    t.text('ip_allowlist')
    t.text('scope_restrictions')
    t.boolean('is_active')
    t.boolean('sandbox')
    t.dateTime('created_at')
  })
  await db('nivaro_roles').insert([
    { id: 'R-USER', name: 'User', admin_access: false },
    { id: 'R-ADMIN', name: 'Administrator', admin_access: true }
  ])
  // A PERSON who holds the address the smoke identity used to have: never touched.
  await db('nivaro_users').insert({
    id: 'HUMAN-1',
    email: 'hub-smoke@nivaro.local',
    status: 'active',
    role: 'R-USER'
  })

  app = Fastify()
  // Stand-ins for the app's own routes the reads reach in-process.
  app.get('/api/items/projects', async (req) => {
    seenAuth.push(String(req.headers.authorization))
    keysDuringRead.push(Number((await db('nivaro_api_keys').count({ n: '*' }))[0].n))
    return { data: [{ id: 1, name: 'secret project' }, { id: 2 }] }
  })
  app.get('/api/items/broken', async (_req, reply) =>
    reply.code(403).send({ error: 'no', code: 'FORBIDDEN_COLLECTION' })
  )
  let inFlight = 0
  app.get('/api/items/slow', async () => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((r) => setTimeout(r, 30))
    inFlight--
    return { data: [{ id: 1 }] }
  })
  // The smoke queries run HERE (never through the execute route): stand-in custom queries.
  await db.schema.createTable('nivaro_custom_queries', (t) => {
    t.increments('id')
    t.string('slug').unique()
    t.text('sql_text')
    t.text('params')
    t.string('access')
    t.boolean('enabled')
    t.text('scope_params')
  })
  await db.schema.createTable('nivaro_user_scopes', (t) => {
    t.increments('id')
    t.string('user')
    t.string('dimension')
  })
  await db.schema.createTable('smoke_marks', (t) => {
    t.increments('id')
  })
  await db('nivaro_custom_queries').insert([
    {
      slug: 'open-orders',
      sql_text: 'SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3',
      access: 'authenticated',
      enabled: true
    },
    { slug: 'writes', sql_text: 'DELETE FROM smoke_marks', access: 'authenticated', enabled: true },
    { slug: 'admin-only', sql_text: 'SELECT 1', access: 'admin', enabled: true }
  ])
  await app.register(hubVerifyLinkRoutes, { prefix: '/api/hub-link' })
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

const auth = { authorization: `Bearer ${TOKEN}` }

describe('hub link: verify', () => {
  it('refuses a missing or wrong bearer', async () => {
    for (const headers of [{}, { authorization: 'Bearer nope' }]) {
      const r = await app.inject({ method: 'GET', url: '/api/hub-link/verify/extensions', headers })
      expect(r.statusCode).toBe(401)
      expect(r.json().code).toBe('HUB_LINK_REFUSED')
    }
  })

  it('runs the reads as the service identity and answers facts only; the key is gone after', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/hub-link/verify/run',
      headers: auth,
      payload: {
        reads: [
          { kind: 'read', path: '/api/items/projects?limit=2' },
          { kind: 'read', path: '/api/items/broken' },
          { kind: 'query', slug: 'open-orders' }
        ]
      }
    })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.results.map((x: Record<string, unknown>) => [x.status, x.rows, x.code])).toEqual([
      [200, 2, null],
      [403, null, 'FORBIDDEN_COLLECTION'],
      [200, 3, null]
    ])
    // Never a body: the project name the read returned is not in the answer.
    expect(r.body).not.toContain('secret project')
    // A temporary nvk_ key, never the Hub's token, and one key existed during the read.
    expect(seenAuth[0]).toMatch(/^Bearer nvk_[0-9a-f]{32}$/)
    expect(seenAuth[0]).not.toContain(TOKEN)
    expect(keysDuringRead[0]).toBe(1)
    expect(Number((await db('nivaro_api_keys').count({ n: '*' }))[0].n)).toBe(0)
    const stored = JSON.parse(
      (await db('nivaro_extension_settings').where(verify.SMOKE_STORE).first()).value
    )
    const u = await db('nivaro_users').where({ id: stored.user_id }).first()
    expect(u).toMatchObject({ account_kind: 'hub_smoke', status: 'active', role: stored.role_id })
    expect(u.role).not.toBe('R-ADMIN')
    expect(u.email).toMatch(/^hub-smoke-[0-9a-f]{8}@nivaro\.local$/)
    // Its own role: no administration, no sign-in, one read policy.
    const role = await db('nivaro_roles').where({ id: stored.role_id }).first()
    expect([!!role.admin_access, !!role.app_access]).toEqual([false, false])
    const policies = await db('nivaro_policies').where({ role: stored.role_id })
    expect(policies.map((p) => [p.collection, p.action])).toEqual([['*', 'read']])
    // The person with the old address is exactly as they were.
    expect(await db('nivaro_users').where({ id: 'HUMAN-1' }).first()).toMatchObject({
      role: 'R-USER',
      account_kind: null
    })
  })

  it('the identity is found by its stored id; a store naming a person is refused, never promoted', async () => {
    const saved = (await db('nivaro_extension_settings').where(verify.SMOKE_STORE).first()).value
    const roleId = JSON.parse(saved).role_id
    await db('nivaro_extension_settings')
      .where(verify.SMOKE_STORE)
      .update({ value: JSON.stringify({ user_id: 'HUMAN-1', role_id: roleId }) })
    const r = await app.inject({
      method: 'POST',
      url: '/api/hub-link/verify/run',
      headers: auth,
      payload: { reads: [{ kind: 'read', path: '/api/items/projects' }] }
    })
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('SMOKE_IDENTITY_NOT_SERVICE')
    expect(await db('nivaro_users').where({ id: 'HUMAN-1' }).first()).toMatchObject({
      role: 'R-USER',
      account_kind: null
    })
    expect(Number((await db('nivaro_api_keys').count({ n: '*' }))[0].n)).toBe(0)
    await db('nivaro_extension_settings').where(verify.SMOKE_STORE).update({ value: saved })
  })

  it.each([
    ['a password', { password_hash: 'salt:hash' }, 'SMOKE_IDENTITY_HAS_CREDENTIAL'],
    ['an Entra id', { entra_oid: 'oid-1' }, 'SMOKE_IDENTITY_HAS_CREDENTIAL'],
    ['an identity-provider id', { external_id: 'sub-1' }, 'SMOKE_IDENTITY_HAS_CREDENTIAL'],
    ['a static token', { static_token: 'tok' }, 'SMOKE_IDENTITY_HAS_CREDENTIAL'],
    ['another role', { role: 'R-ADMIN' }, 'SMOKE_IDENTITY_CHANGED'],
    ['a person kind', { account_kind: null }, 'SMOKE_IDENTITY_NOT_SERVICE'],
    ['a plain service kind', { account_kind: 'service' }, 'SMOKE_IDENTITY_NOT_SERVICE'],
    ['a suspension', { status: 'suspended' }, 'SMOKE_IDENTITY_SUSPENDED']
  ])('refuses a smoke account that was given %s', async (_what, patch, code) => {
    const { user_id } = JSON.parse(
      (await db('nivaro_extension_settings').where(verify.SMOKE_STORE).first()).value
    )
    const before = await db('nivaro_users').where({ id: user_id }).first()
    await db('nivaro_users').where({ id: user_id }).update(patch)
    await expect(verify.smokeIdentity()).rejects.toMatchObject({ code })
    // Never repaired or promoted: the row stays as it was changed.
    expect(await db('nivaro_users').where({ id: user_id }).first()).toMatchObject(patch)
    await db('nivaro_users').where({ id: user_id }).update(before)
  })

  it('the role cannot write; a write policy or admin access on it refuses every run', async () => {
    const { user_id, role_id } = JSON.parse(
      (await db('nivaro_extension_settings').where(verify.SMOKE_STORE).first()).value
    )
    const { can } = await import('../../../services/permissions.js')
    const user = await db('nivaro_users').where({ id: user_id }).first()
    for (const action of ['create', 'update', 'delete'] as const)
      expect(await can(user, action, 'projects')).toBe(false)
    expect(await can(user, 'read', 'projects')).toBe(true)
    const [pid] = await db('nivaro_policies').insert({
      role: role_id,
      collection: 'projects',
      action: 'update',
      fields: '*'
    })
    await expect(verify.smokeIdentity()).rejects.toMatchObject({ code: 'SMOKE_ROLE_CHANGED' })
    await db('nivaro_policies').where({ id: pid }).delete()
    await db('nivaro_roles').where({ id: role_id }).update({ admin_access: true })
    await expect(verify.smokeIdentity()).rejects.toMatchObject({ code: 'SMOKE_ROLE_CHANGED' })
    await db('nivaro_roles').where({ id: role_id }).update({ admin_access: false })
    expect(await verify.smokeIdentity()).toBe(user_id)
  })

  it('a smoke query must be one read of tables the smoke role may read; refused otherwise', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/hub-link/verify/run',
      headers: auth,
      payload: {
        reads: [
          { kind: 'query', slug: 'writes' },
          { kind: 'query', slug: 'admin-only' },
          { kind: 'query', slug: 'missing' }
        ]
      }
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().results.map((x: Record<string, unknown>) => x.code)).toEqual([
      'SMOKE_QUERY_NOT_READ_ONLY',
      'SMOKE_QUERY_ACCESS',
      'SMOKE_QUERY_MISSING'
    ])
    // The write never ran.
    await db('smoke_marks').insert({})
    const before = Number((await db('smoke_marks').count({ n: '*' }))[0].n)
    expect(before).toBe(1)
    // The Hub asks the same before it saves a suite.
    const check = await app.inject({
      method: 'POST',
      url: '/api/hub-link/verify/queries',
      headers: auth,
      payload: { slugs: ['open-orders', 'writes'] }
    })
    expect(check.statusCode).toBe(200)
    expect(check.json().results.map((x: Record<string, unknown>) => [x.slug, x.code])).toEqual([
      ['open-orders', null],
      ['writes', 'SMOKE_QUERY_NOT_READ_ONLY']
    ])
  })

  it('runs ten reads, at most three at a time', async () => {
    maxInFlight = 0
    const r = await app.inject({
      method: 'POST',
      url: '/api/hub-link/verify/run',
      headers: auth,
      payload: {
        reads: Array.from({ length: 10 }, () => ({ kind: 'read', path: '/api/items/slow' }))
      }
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().results).toHaveLength(10)
    expect(r.json().results.every((x: Record<string, unknown>) => x.status === 200)).toBe(true)
    expect(maxInFlight).toBe(3)
    const eleven = await app.inject({
      method: 'POST',
      url: '/api/hub-link/verify/run',
      headers: auth,
      payload: {
        reads: Array.from({ length: 11 }, () => ({ kind: 'read', path: '/api/items/slow' }))
      }
    })
    expect(eleven.statusCode).toBe(400)
  })

  it('the minted key is read-only and short-lived', async () => {
    const before = Date.now()
    let row: Record<string, unknown> | undefined
    await verify.runVerifyReads([{ kind: 'read', path: '/api/items/projects' }], {
      inject: (async (o: Record<string, unknown>) => {
        row = await db('nivaro_api_keys').first()
        return app.inject(o as never)
      }) as never
    })
    expect(JSON.parse(String(row?.scopes))).toEqual([{ collection: '*', actions: ['read'] }])
    const exp = new Date(row?.expires_at as string).getTime()
    expect(exp).toBeGreaterThan(before)
    expect(exp).toBeLessThanOrEqual(before + 3 * 60_000 + 1000)
  })

  it.each([
    { reads: [] },
    { reads: [{ kind: 'read', path: '/api/hub-link/status' }] },
    { reads: [{ kind: 'read', path: '/api/auth/me' }] },
    { reads: [{ kind: 'read', path: '/api/files/1' }] },
    { reads: [{ kind: 'read', path: '/api/items/../auth' }] },
    { reads: [{ kind: 'read', path: '/api/realtime/stream' }] },
    { reads: [{ kind: 'read', path: '/settings' }] },
    { reads: [{ kind: 'query', slug: 'a b' }] },
    { reads: [{ kind: 'write', path: '/api/items/projects' }] }
  ])('refuses reads it may not run: %j', async (payload) => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/hub-link/verify/run',
      headers: auth,
      payload
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().code).toBe('BAD_READS')
  })

  it('lists the loaded extensions: ids, versions and builds only', async () => {
    extensionRegistry.set('efp-ops', {
      id: 'efp-ops',
      status: 'loaded',
      enabled: true,
      path: '/srv/secret/path',
      manifest: { version: '2.1.0' },
      build: 'abc123'
    })
    extensionRegistry.set('cloud-billing', {
      id: 'cloud-billing',
      status: 'loaded',
      enabled: true,
      path: '/x',
      cloud: true
    })
    const r = await app.inject({
      method: 'GET',
      url: '/api/hub-link/verify/extensions',
      headers: auth
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().extensions).toEqual([
      { id: 'efp-ops', status: 'loaded', enabled: true, version: '2.1.0', build: 'abc123' }
    ])
    expect(r.body).not.toContain('/srv/secret/path')
    extensionRegistry.delete('efp-ops')
    extensionRegistry.delete('cloud-billing')
  })
})
