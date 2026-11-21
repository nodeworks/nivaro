import Fastify, { type FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub (phase 1): apps, environments and owners. Runs on an in-memory SQLite with the
// real migration 542 tables. Admins manage everything; an app owner (not an admin) reads only
// the apps they own; hub tokens are sealed at rest and masked on every read.

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
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { up } = await import('../../../db/migrations/542_hub_tables.js')
const { logActivity } = await import('../../../services/activity.js')
const { hubRoutes } = await import('../../../routes/hub.js')

const ADMIN = 'AAAAAAAA-0000-4000-8000-000000000001'
const OWNER = 'BBBBBBBB-0000-4000-8000-000000000002'
const OTHER = 'CCCCCCCC-0000-4000-8000-000000000003'
const KEY = 'a'.repeat(64)
const MASK = '••••••'

const asAdmin = { 'x-user': ADMIN, 'x-admin': '1' }
const asOwner = { 'x-user': OWNER }

const fakeRedis = { get: vi.fn(), set: vi.fn(), del: vi.fn(async () => 1) }

let app: FastifyInstance
let prevHub: string | undefined
let prevKey: string | undefined

beforeAll(async () => {
  prevHub = process.env.HUB
  prevKey = process.env.ENCRYPTION_KEY
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = KEY
  await up(db)
  await db.schema.createTable('nivaro_users', (t) => {
    t.uuid('id').primary()
    t.string('first_name')
    t.string('last_name')
    t.string('email')
    t.string('password')
  })
  await db('nivaro_users').insert([
    { id: ADMIN, first_name: 'Ada', last_name: 'Admin', email: 'ada@x', password: 'secret' },
    { id: OWNER, first_name: 'Olly', last_name: 'Owner', email: 'olly@x', password: 'secret' },
    { id: OTHER, first_name: null, last_name: null, email: 'other@x', password: 'secret' }
  ])
  app = Fastify()
  app.decorate('redis', fakeRedis as never)
  await app.register(hubRoutes, { prefix: '/hub' })
  await app.ready()
})
afterAll(async () => {
  await app.close()
  await db.destroy()
  if (prevHub === undefined) delete process.env.HUB
  else process.env.HUB = prevHub
  if (prevKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = prevKey
})
beforeEach(async () => {
  process.env.ENCRYPTION_KEY = KEY
  await db('nivaro_hub_environments').del()
  await db('nivaro_hub_app_owners').del()
  await db('nivaro_hub_apps').del()
  vi.mocked(logActivity).mockClear()
  fakeRedis.del.mockReset()
  fakeRedis.del.mockResolvedValue(1)
})

const req = (
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  headers: Record<string, string>,
  payload?: unknown
) => app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) })

async function createApp(key: string, extra: Record<string, unknown> = {}) {
  const r = await req('POST', '/hub/apps', asAdmin, { key, name: key.toUpperCase(), ...extra })
  expect(r.statusCode).toBe(200)
  return r.json().data as { id: number; key: string }
}

describe('hub apps', () => {
  it('admin creates an app → 200, the app shape and an activity row', async () => {
    const r = await req('POST', '/hub/apps', asAdmin, { key: 'efp', name: 'EFP', adopted: true })
    expect(r.statusCode).toBe(200)
    const data = r.json().data
    expect(data).toMatchObject({
      key: 'efp',
      name: 'EFP',
      signin_mode: 'direct',
      adopted: true,
      extensions: []
    })
    expect(typeof data.id).toBe('number')
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'create',
        user: ADMIN,
        collection: 'nivaro_hub_apps',
        item: String(data.id)
      })
    )
  })

  it('duplicate key → 409 KEY_TAKEN', async () => {
    await createApp('efp')
    const r = await req('POST', '/hub/apps', asAdmin, { key: 'efp', name: 'Again' })
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('KEY_TAKEN')
  })

  it('bad key, missing name or unknown sign-in mode → 400', async () => {
    for (const key of ['', 'A', 'Efp', '1efp', 'e', 'ef_p', 'a'.repeat(64), 7])
      expect((await req('POST', '/hub/apps', asAdmin, { key, name: 'X' })).statusCode).toBe(400)
    expect((await req('POST', '/hub/apps', asAdmin, { key: 'ok' })).statusCode).toBe(400)
    const mode = await req('POST', '/hub/apps', asAdmin, {
      key: 'ok',
      name: 'Ok',
      signin_mode: 'sso'
    })
    expect(mode.statusCode).toBe(400)
    expect(await db('nivaro_hub_apps').count({ n: '*' })).toEqual([{ n: 0 }])
  })

  it('non-admin writes → 403', async () => {
    const created = await createApp('efp')
    expect((await req('POST', '/hub/apps', asOwner, { key: 'x1', name: 'X' })).statusCode).toBe(403)
    expect((await req('PATCH', `/hub/apps/${created.id}`, asOwner, { name: 'Y' })).statusCode).toBe(
      403
    )
    expect((await req('DELETE', `/hub/apps/${created.id}`, asOwner)).statusCode).toBe(403)
    expect(
      (await req('PUT', `/hub/apps/${created.id}/owners`, asOwner, { user_ids: [OWNER] }))
        .statusCode
    ).toBe(403)
    expect(
      (
        await req('POST', `/hub/apps/${created.id}/environments`, asOwner, {
          key: 'prod',
          base_url: 'https://a.example.com'
        })
      ).statusCode
    ).toBe(403)
  })

  it('an owner lists only their own apps; another app answers 404', async () => {
    const mine = await createApp('mine')
    const theirs = await createApp('theirs')
    const put = await req('PUT', `/hub/apps/${mine.id}/owners`, asAdmin, { user_ids: [OWNER] })
    expect(put.statusCode).toBe(200)

    const list = await req('GET', '/hub/apps', asOwner)
    expect(list.statusCode).toBe(200)
    expect((list.json().data as Array<{ key: string }>).map((a) => a.key)).toEqual(['mine'])

    const all = await req('GET', '/hub/apps', asAdmin)
    expect((all.json().data as Array<{ key: string }>).map((a) => a.key).sort()).toEqual([
      'mine',
      'theirs'
    ])

    const own = await req('GET', `/hub/apps/${mine.id}`, asOwner)
    expect(own.statusCode).toBe(200)
    expect(own.json().data.owners).toEqual([{ user_id: OWNER, name: 'Olly Owner' }])

    const other = await req('GET', `/hub/apps/${theirs.id}`, asOwner)
    expect(other.statusCode).toBe(404)
    expect(other.json().code).toBe('NOT_FOUND')
    for (const id of ['999', 'abc', '1.5'])
      expect((await req('GET', `/hub/apps/${id}`, asAdmin)).statusCode).toBe(404)
  })

  it('owners: replaces the list, names fall back to email, unknown user → 400', async () => {
    const a = await createApp('efp')
    await req('PUT', `/hub/apps/${a.id}/owners`, asAdmin, { user_ids: [OWNER, ADMIN] })
    const r = await req('PUT', `/hub/apps/${a.id}/owners`, asAdmin, {
      user_ids: [OTHER, OTHER]
    })
    expect(r.statusCode).toBe(200)
    const got = await req('GET', `/hub/apps/${a.id}`, asAdmin)
    expect(got.json().data.owners).toEqual([{ user_id: OTHER, name: 'other@x' }])
    expect(JSON.stringify(got.json())).not.toContain('secret')
    const bad = await req('PUT', `/hub/apps/${a.id}/owners`, asAdmin, {
      user_ids: ['DDDDDDDD-0000-4000-8000-000000000009']
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('UNKNOWN_USER')
    expect((await req('PUT', `/hub/apps/${a.id}/owners`, asAdmin, {})).statusCode).toBe(400)
  })

  it('owners: an id that is not a user id → 400 UNKNOWN_USER before any user lookup', async () => {
    const a = await createApp('efp')
    // A uuid column refuses 'bob' on SQL Server / Postgres (conversion error → 500): the route
    // must answer before nivaro_users is ever queried.
    const seen: string[] = []
    const onQuery = (q: { sql: string }) => seen.push(q.sql)
    db.on('query', onQuery)
    try {
      const r = await req('PUT', `/hub/apps/${a.id}/owners`, asAdmin, {
        user_ids: [OWNER, 'bob', '12345']
      })
      expect(r.statusCode).toBe(400)
      expect(r.json().code).toBe('UNKNOWN_USER')
      expect(r.json().error).toContain('bob')
      expect(r.json().error).toContain('12345')
      expect(r.json().error).not.toContain(OWNER)
    } finally {
      db.off('query', onQuery)
    }
    expect(seen.filter((sql) => sql.includes('nivaro_users'))).toEqual([])
    expect(await db('nivaro_hub_app_owners').count({ n: '*' })).toEqual([{ n: 0 }])
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'nivaro_hub_apps', item: String(a.id) })
    )
  })

  it('PATCH changes name, sign-in mode and extensions', async () => {
    const a = await createApp('efp')
    const r = await req('PATCH', `/hub/apps/${a.id}`, asAdmin, {
      name: 'EFP Prod',
      signin_mode: 'hub',
      extensions: ['efp-ops']
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toMatchObject({
      name: 'EFP Prod',
      signin_mode: 'hub',
      extensions: ['efp-ops']
    })
    expect(
      (await req('PATCH', `/hub/apps/${a.id}`, asAdmin, { signin_mode: 'x' })).statusCode
    ).toBe(400)
    expect((await req('PATCH', '/hub/apps/999', asAdmin, { name: 'Z' })).statusCode).toBe(404)
  })

  it('DELETE refuses an app with environments (409 HAS_ENVIRONMENTS), then deletes', async () => {
    const a = await createApp('efp')
    await req('PUT', `/hub/apps/${a.id}/owners`, asAdmin, { user_ids: [OWNER] })
    const env = await req('POST', `/hub/apps/${a.id}/environments`, asAdmin, {
      key: 'prod',
      base_url: 'https://efp.example.com'
    })
    const refused = await req('DELETE', `/hub/apps/${a.id}`, asAdmin)
    expect(refused.statusCode).toBe(409)
    expect(refused.json().code).toBe('HAS_ENVIRONMENTS')
    const envId = env.json().data.id
    expect((await req('DELETE', `/hub/environments/${envId}`, asAdmin)).statusCode).toBe(200)
    expect((await req('DELETE', `/hub/apps/${a.id}`, asAdmin)).statusCode).toBe(200)
    expect(await db('nivaro_hub_apps').count({ n: '*' })).toEqual([{ n: 0 }])
    expect(await db('nivaro_hub_app_owners').count({ n: '*' })).toEqual([{ n: 0 }])
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'delete', collection: 'nivaro_hub_environments' })
    )
  })
})

describe('hub environments', () => {
  it('hub token: sealed at rest, masked on GET, mask keeps it, empty clears it', async () => {
    const a = await createApp('efp')
    const post = await req('POST', `/hub/apps/${a.id}/environments`, asAdmin, {
      key: 'prod',
      base_url: 'https://efp.example.com',
      hostnames: ['efp.example.com'],
      hub_token: 'plain-token-value'
    })
    expect(post.statusCode).toBe(200)
    const env = post.json().data
    expect(env).toMatchObject({
      app_id: a.id,
      key: 'prod',
      status: 'active',
      base_url: 'https://efp.example.com',
      hostnames: ['efp.example.com'],
      hub_token: MASK
    })
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'create',
        collection: 'nivaro_hub_environments',
        item: String(env.id)
      })
    )
    const stored = await db('nivaro_hub_environments').where({ id: env.id }).first()
    expect(stored.hub_token).toMatch(/^enc:v1:/)
    expect(stored.hub_token).not.toContain('plain-token-value')

    const got = await req('GET', `/hub/apps/${a.id}`, asAdmin)
    expect(got.json().data.environments[0].hub_token).toBe(MASK)
    expect(got.body).not.toContain('plain-token-value')

    const keep = await req('PATCH', `/hub/environments/${env.id}`, asAdmin, {
      hub_token: MASK,
      position: 2
    })
    expect(keep.statusCode).toBe(200)
    expect(keep.json().data.hub_token).toBe(MASK)
    const after = await db('nivaro_hub_environments').where({ id: env.id }).first()
    expect(after.hub_token).toBe(stored.hub_token)
    expect(after.position).toBe(2)

    const clear = await req('PATCH', `/hub/environments/${env.id}`, asAdmin, { hub_token: '' })
    expect(clear.statusCode).toBe(200)
    expect(clear.json().data.hub_token).toBeNull()
    expect((await db('nivaro_hub_environments').where({ id: env.id }).first()).hub_token).toBe(null)
  })

  it('no encryption key → 400 HUB_NEEDS_ENCRYPTION_KEY and nothing stored', async () => {
    const a = await createApp('efp')
    delete process.env.ENCRYPTION_KEY
    const r = await req('POST', `/hub/apps/${a.id}/environments`, asAdmin, {
      key: 'prod',
      base_url: 'https://efp.example.com',
      hub_token: 'plain-token-value'
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().code).toBe('HUB_NEEDS_ENCRYPTION_KEY')
    expect(await db('nivaro_hub_environments').count({ n: '*' })).toEqual([{ n: 0 }])
  })

  it('base_url must be http(s)://host[:port] with no path; env key unique per app', async () => {
    const a = await createApp('efp')
    for (const base_url of [
      '',
      'efp.example.com',
      'ftp://efp.example.com',
      'https://efp.example.com/admin',
      'https://efp.example.com?x=1',
      'https://efp.example.com#top',
      'https://efp.example.com?',
      'https://user:pw@efp.example.com'
    ])
      expect(
        [
          base_url,
          (await req('POST', `/hub/apps/${a.id}/environments`, asAdmin, { key: 'prod', base_url }))
            .statusCode
        ],
        base_url
      ).toEqual([base_url, 400])
    const ok = await req('POST', `/hub/apps/${a.id}/environments`, asAdmin, {
      key: 'prod',
      base_url: 'http://10.0.0.5:3055/'
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().data.base_url).toBe('http://10.0.0.5:3055')
    const dup = await req('POST', `/hub/apps/${a.id}/environments`, asAdmin, {
      key: 'prod',
      base_url: 'https://b.example.com'
    })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().code).toBe('KEY_TAKEN')
    const patchBad = await req('PATCH', `/hub/environments/${ok.json().data.id}`, asAdmin, {
      base_url: 'https://b.example.com/x'
    })
    expect(patchBad.statusCode).toBe(400)
    expect(
      (
        await req('POST', '/hub/apps/999/environments', asAdmin, {
          key: 'prod',
          base_url: 'https://b.example.com'
        })
      ).statusCode
    ).toBe(404)
    expect((await req('PATCH', '/hub/environments/999', asAdmin, { position: 1 })).statusCode).toBe(
      404
    )
  })

  it('PATCH without hub_token keeps the stored token', async () => {
    const a = await createApp('efp')
    const env = (
      await req('POST', `/hub/apps/${a.id}/environments`, asAdmin, {
        key: 'prod',
        base_url: 'https://efp.example.com',
        hub_token: 'plain-token-value'
      })
    ).json().data
    const before = (await db('nivaro_hub_environments').where({ id: env.id }).first()).hub_token
    const r = await req('PATCH', `/hub/environments/${env.id}`, asAdmin, { key: 'production' })
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toMatchObject({ key: 'production', hub_token: MASK })
    expect((await db('nivaro_hub_environments').where({ id: env.id }).first()).hub_token).toBe(
      before
    )
  })

  it('hub token never follows a changed address: mask/absent → 400 SECRET_REQUIRED', async () => {
    const a = await createApp('efp')
    const env = (
      await req('POST', `/hub/apps/${a.id}/environments`, asAdmin, {
        key: 'prod',
        base_url: 'https://efp.example.com',
        hub_token: 'plain-token-value'
      })
    ).json().data
    const stored = (await db('nivaro_hub_environments').where({ id: env.id }).first()).hub_token
    for (const extra of [{ hub_token: MASK }, {}, { hub_token: 42 }]) {
      const r = await req('PATCH', `/hub/environments/${env.id}`, asAdmin, {
        base_url: 'https://evil.example.net',
        ...extra
      })
      expect(r.statusCode).toBe(400)
      expect(r.json().code).toBe('SECRET_REQUIRED')
    }
    // A port change is a different origin too.
    const port = await req('PATCH', `/hub/environments/${env.id}`, asAdmin, {
      base_url: 'https://efp.example.com:8443'
    })
    expect(port.statusCode).toBe(400)
    const row = await db('nivaro_hub_environments').where({ id: env.id }).first()
    expect(row.base_url).toBe('https://efp.example.com')
    expect(row.hub_token).toBe(stored)

    // Same origin (case, trailing slash) with the mask is fine.
    const same = await req('PATCH', `/hub/environments/${env.id}`, asAdmin, {
      base_url: 'https://EFP.example.com/',
      hub_token: MASK
    })
    expect(same.statusCode).toBe(200)
    expect((await db('nivaro_hub_environments').where({ id: env.id }).first()).hub_token).toBe(
      stored
    )

    // A new token with the new address is fine.
    const moved = await req('PATCH', `/hub/environments/${env.id}`, asAdmin, {
      base_url: 'https://efp2.example.com',
      hub_token: 'another-token'
    })
    expect(moved.statusCode).toBe(200)
    expect(moved.json().data).toMatchObject({
      base_url: 'https://efp2.example.com',
      hub_token: MASK
    })
    const sealed = (await db('nivaro_hub_environments').where({ id: env.id }).first()).hub_token
    expect(sealed).not.toBe(stored)

    // Clearing the token with the new address is fine.
    const cleared = await req('PATCH', `/hub/environments/${env.id}`, asAdmin, {
      base_url: 'https://efp3.example.com',
      hub_token: null
    })
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json().data.hub_token).toBeNull()

    // No stored token: the address may change freely.
    const free = await req('PATCH', `/hub/environments/${env.id}`, asAdmin, {
      base_url: 'https://efp4.example.com'
    })
    expect(free.statusCode).toBe(200)
  })

  it('every PATCH forgets the cached status; a Redis failure never fails the write', async () => {
    const a = await createApp('efp')
    const env = (
      await req('POST', `/hub/apps/${a.id}/environments`, asAdmin, {
        key: 'prod',
        base_url: 'https://efp.example.com'
      })
    ).json().data
    const r = await req('PATCH', `/hub/environments/${env.id}`, asAdmin, { position: 3 })
    expect(r.statusCode).toBe(200)
    expect(fakeRedis.del).toHaveBeenCalledWith(`nvr:hub:status:${env.id}`)

    fakeRedis.del.mockRejectedValue(new Error('redis down'))
    const r2 = await req('PATCH', `/hub/environments/${env.id}`, asAdmin, { position: 4 })
    expect(r2.statusCode).toBe(200)
    expect(r2.json().data.position).toBe(4)

    fakeRedis.del.mockImplementation(() => new Promise(() => {}))
    const started = Date.now()
    const r3 = await req('PATCH', `/hub/environments/${env.id}`, asAdmin, { position: 5 })
    expect(r3.statusCode).toBe(200)
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('hub mode off', () => {
  it('every route answers 404', async () => {
    const saved = process.env.HUB
    delete process.env.HUB
    const off = Fastify()
    await off.register(hubRoutes, { prefix: '/hub' })
    await off.ready()
    process.env.HUB = saved
    const calls: Array<['GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', string]> = [
      ['GET', '/hub/apps'],
      ['GET', '/hub/apps/1'],
      ['POST', '/hub/apps'],
      ['PATCH', '/hub/apps/1'],
      ['DELETE', '/hub/apps/1'],
      ['PUT', '/hub/apps/1/owners'],
      ['POST', '/hub/apps/1/environments'],
      ['PATCH', '/hub/environments/1'],
      ['DELETE', '/hub/environments/1']
    ]
    for (const [method, url] of calls)
      expect([
        method,
        url,
        (await off.inject({ method, url, headers: asAdmin })).statusCode
      ]).toEqual([method, url, 404])
    await off.close()
  })
})
