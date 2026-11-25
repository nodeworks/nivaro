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

beforeAll(async () => {
  await db.schema.createTable('nivaro_roles', (t) => {
    t.string('id').primary()
    t.string('name')
    t.boolean('admin_access')
  })
  await db.schema.createTable('nivaro_users', (t) => {
    t.string('id').primary()
    t.string('email').unique()
    t.string('first_name')
    t.string('status')
    t.string('account_kind')
    t.string('role')
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
  app.post('/api/custom-queries/:slug/execute', async (req) => ({
    data: Array.from({ length: Number((req.body as { params?: { n?: number } }).params?.n ?? 0) })
  }))
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
          { kind: 'query', slug: 'open-orders', params: { n: 3 } }
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
    const u = await db('nivaro_users').where({ email: verify.SMOKE_EMAIL }).first()
    expect(u).toMatchObject({ account_kind: 'service', status: 'active', role: 'R-ADMIN' })
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
