import Fastify from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub enhancement 24 (app side): POST /api/hub-link/template starts the install in the
// background (202 + install id) under a one-at-a-time lock, GET /template/:id reads it. Only a
// fresh app takes it. The blueprint installer is faked; the gate, digest, lock, status and the
// answers are what is tested. No Redis here: the in-process fallback of the same lock is used.

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
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/io-holder.js', () => ({ getApp: () => null }))
vi.mock('../../../services/blueprints.js', async (orig) => ({
  ...(await orig<object>()),
  installBlueprint: vi.fn()
}))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { installBlueprint } = await import('../../../services/blueprints.js')
const { logActivity } = await import('../../../services/activity.js')
const svc = await import('../../../services/hub-link/template-install.js')
const { hubLinkTemplateRoute } = await import('../../../routes/hub-link-template.js')

const REPORT = {
  collections: { created: 2, skipped: 0 },
  columns: { created: 4 },
  fields: { created: 4, skipped: 0 },
  relations: { created: 0, skipped: 0 },
  workflows: { created: 1, skipped: 0 },
  layouts: { created: 0, skipped: 0 },
  queues: { created: 0, skipped: 0 },
  rules: { created: 0, skipped: 0 },
  payload_templates: { created: 0, drafted: 0, skipped: 0 },
  errors: [] as string[]
}

const bundle = {
  type: 'nivaro-blueprint',
  version: 1,
  name: 'Assets',
  exported_at: '2026-11-20T00:00:00.000Z',
  collections: [
    { meta: { collection: 'assets', virtual_sql: 'DROP TABLE x', is_virtual: true }, fields: [] },
    { meta: { collection: 'asset_moves' }, fields: [] }
  ],
  relations: [],
  workflows: [],
  layouts: [],
  queues: [],
  rules: []
}
const body = () => ({
  bundle,
  digest: svc.bundleDigest(bundle),
  template: { name: 'Assets', version: '1' }
})

const app = Fastify()
const ADMIN_OLD = 'b0000000-0000-4000-8000-000000000002'

beforeAll(async () => {
  await db.schema.createTable('nivaro_collections', (t) => {
    t.string('collection').primary()
  })
  await db.schema.createTable('nivaro_roles', (t) => {
    t.uuid('id').primary()
    t.boolean('admin_access')
  })
  await db.schema.createTable('nivaro_users', (t) => {
    t.uuid('id').primary()
    t.uuid('role')
    t.string('status')
    t.string('account_kind')
    t.dateTime('created_at')
  })
  await db('nivaro_roles').insert({
    id: 'r0000000-0000-4000-8000-000000000001',
    admin_access: true
  })
  // The id that sorts first is the NEWER person: the owner is chosen by created_at (review L2).
  await db('nivaro_users').insert([
    {
      id: 'a0000000-0000-4000-8000-000000000001',
      role: 'r0000000-0000-4000-8000-000000000001',
      status: 'active',
      account_kind: null,
      created_at: new Date('2026-11-20T00:00:00Z')
    },
    {
      id: ADMIN_OLD,
      role: 'r0000000-0000-4000-8000-000000000001',
      status: 'active',
      account_kind: null,
      created_at: new Date('2026-01-01T00:00:00Z')
    }
  ])
  hubLinkTemplateRoute(app)
  await app.ready()
})
afterAll(async () => {
  await app.close()
  await db.destroy()
})
beforeEach(async () => {
  vi.clearAllMocks()
  svc._resetTemplateInstallForTests()
  vi.mocked(installBlueprint).mockResolvedValue(REPORT as never)
  await db('nivaro_collections').del()
  await db('nivaro_collections').insert([
    { collection: 'nivaro_users' },
    { collection: 'directus_files' }
  ])
  for (const t of ['assets', 'asset_moves', 'orders']) await db.schema.dropTableIfExists(t)
})

const post = (payload: unknown) =>
  app.inject({ method: 'POST', url: '/template', payload: payload as object })
const read = (id: string) => app.inject({ method: 'GET', url: `/template/${id}` })

async function settled(id: string) {
  for (let i = 0; i < 100; i++) {
    const r = (await read(id)).json()
    if (r.status !== 'running') return r
    await new Promise((res) => setTimeout(res, 5))
  }
  throw new Error('still running')
}

describe('hub link template install', () => {
  it('pure rules: system tables never count; the blueprint’s own are allowed', () => {
    expect(svc.isBusinessCollection('nivaro_users')).toBe(false)
    expect(svc.isBusinessCollection('Directus_files')).toBe(false)
    expect(svc.foreignCollections(['assets', 'orders', 'nivaro_x'], ['Assets'])).toEqual(['orders'])
  })

  it('a fresh app: 202 + id, then done with the report; sanitized; as the oldest admin', async () => {
    const r = await post(body())
    expect(r.statusCode).toBe(202)
    const { install_id } = r.json()
    const done = await settled(install_id)
    expect(done).toMatchObject({ status: 'done', report: { workflows: { created: 1 } } })
    expect(done).not.toHaveProperty('digest')
    const [bp, owner, opts] = vi.mocked(installBlueprint).mock.calls[0]
    expect(owner).toBe(ADMIN_OLD)
    expect(opts).toMatchObject({ atomic: true })
    // Review M3: the virtual SQL never reaches the installer.
    expect(JSON.stringify(bp)).not.toContain('DROP TABLE')
    expect(done.review.virtual_removed).toEqual(['assets'])
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'hub-template-install' })
    )
  })

  it('a second start while one runs joins it (one install); another template answers TEMPLATE_INSTALLING', async () => {
    let release: () => void = () => {}
    vi.mocked(installBlueprint).mockImplementation(
      () => new Promise((res) => (release = () => res(REPORT as never)))
    )
    const a = (await post(body())).json()
    const b = await post(body())
    expect(b.statusCode).toBe(202)
    expect(b.json()).toMatchObject({ install_id: a.install_id, joined: true })
    const other = { ...bundle, name: 'Other' }
    const c = await post({ bundle: other, digest: svc.bundleDigest(other) })
    expect(c.statusCode).toBe(409)
    expect(c.json().code).toBe('TEMPLATE_INSTALLING')
    await new Promise((r) => setTimeout(r, 10))
    release()
    expect((await settled(a.install_id)).status).toBe('done')
    expect(installBlueprint).toHaveBeenCalledTimes(1)
    // The lock is free again.
    expect((await post({ bundle: other, digest: svc.bundleDigest(other) })).statusCode).toBe(202)
  })

  it('failed parts make the run partial; part names only, never the driver text (L3)', async () => {
    vi.mocked(installBlueprint).mockImplementation(async (_bp, _o, opts) => {
      opts?.onPart?.('workflow:w1', false)
      opts?.onPart?.('collection:assets', true)
      return { ...REPORT, errors: ['workflow: SQLITE_CONSTRAINT secret host db1'] } as never
    })
    const { install_id } = (await post(body())).json()
    const run = await settled(install_id)
    expect(run.status).toBe('partial')
    expect(run.parts).toEqual({ ok: 1, failed: ['workflow:w1'] })
    expect(run.report.errors).toEqual(['workflow: INSTALL_FAILED'])
    expect(JSON.stringify(run)).not.toContain('secret host')
  })

  it('a retry finds only the template’s own collections: installs again', async () => {
    await db('nivaro_collections').insert([{ collection: 'assets' }])
    expect((await post(body())).statusCode).toBe(202)
  })

  it('an app with its own collections refuses 409 APP_NOT_EMPTY and writes nothing', async () => {
    await db('nivaro_collections').insert([{ collection: 'orders' }])
    const r = await post(body())
    expect(r.statusCode).toBe(409)
    expect(r.json()).toMatchObject({ code: 'APP_NOT_EMPTY', collections: ['orders'] })
    expect(installBlueprint).not.toHaveBeenCalled()
  })

  it('a physical table of the template that is not registered refuses (L1), unless this template started here', async () => {
    await db.schema.createTable('assets', (t) => t.increments('id'))
    const r = await post(body())
    expect(r.statusCode).toBe(409)
    expect(r.json().collections).toEqual(['assets'])
    expect(await svc.notFreshReason(['assets'], 'sha256:other')).toEqual(['assets'])
  })

  it('a bundle that does not match its digest refuses 400 BAD_DIGEST; not a blueprint → BAD_BUNDLE', async () => {
    expect((await post({ ...body(), digest: 'sha256:00' })).json().code).toBe('BAD_DIGEST')
    expect((await post({ bundle: { type: 'x' }, digest: 'sha256:1' })).json().code).toBe(
      'BAD_BUNDLE'
    )
  })

  it('a bad shape or too many parts is refused before anything runs (M3/L4)', async () => {
    const bad = { ...bundle, relations: 'nope' }
    const r = await post({ bundle: bad, digest: svc.bundleDigest(bad) })
    expect(r.statusCode).toBe(400)
    expect(r.json().code).toBe('BAD_SHAPE')
  })

  it('an installer crash ends the run failed with a code, no driver text', async () => {
    vi.mocked(installBlueprint).mockRejectedValue(new Error('driver said: secret host x'))
    const { install_id } = (await post(body())).json()
    const run = await settled(install_id)
    expect(run).toMatchObject({ status: 'failed', code: 'TEMPLATE_FAILED' })
    expect(JSON.stringify(run)).not.toContain('secret host')
  })

  it('an unknown id answers 404 UNKNOWN_INSTALL', async () => {
    const r = await read('nosuchinstall1')
    expect(r.statusCode).toBe(404)
    expect(r.json().code).toBe('UNKNOWN_INSTALL')
  })
})
