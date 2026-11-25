import Fastify from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub enhancement 24 (app side): POST /api/hub-link/template installs a template only into a
// fresh app — no business collections, or only those the template itself brings (a retry). The
// blueprint installer is faked; the gate, the digest and the route answers are what is tested.

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
  errors: []
}

const bundle = {
  type: 'nivaro-blueprint',
  version: 1,
  name: 'Assets',
  exported_at: '2026-11-20T00:00:00.000Z',
  collections: [
    { meta: { collection: 'assets' }, fields: [] },
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
  })
  await db('nivaro_roles').insert({
    id: 'r0000000-0000-4000-8000-000000000001',
    admin_access: true
  })
  await db('nivaro_users').insert({
    id: 'u0000000-0000-4000-8000-000000000001',
    role: 'r0000000-0000-4000-8000-000000000001',
    status: 'active',
    account_kind: null
  })
  hubLinkTemplateRoute(app)
  await app.ready()
})
afterAll(async () => {
  await app.close()
  await db.destroy()
})
beforeEach(async () => {
  vi.clearAllMocks()
  vi.mocked(installBlueprint).mockResolvedValue(REPORT as never)
  await db('nivaro_collections').del()
  await db('nivaro_collections').insert([
    { collection: 'nivaro_users' },
    { collection: 'directus_files' }
  ])
})

const post = (payload: unknown) =>
  app.inject({ method: 'POST', url: '/template', payload: payload as object })

describe('hub link template install', () => {
  it('pure rules: system tables never count; the blueprint’s own are allowed', () => {
    expect(svc.isBusinessCollection('nivaro_users')).toBe(false)
    expect(svc.isBusinessCollection('Directus_files')).toBe(false)
    expect(svc.foreignCollections(['assets', 'orders', 'nivaro_x'], ['Assets'])).toEqual(['orders'])
  })

  it('a fresh app (only system collections) takes it: 200 with the report, as the oldest admin', async () => {
    const r = await post(body())
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ installed: true, report: { workflows: { created: 1 } } })
    expect(installBlueprint).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Assets' }),
      'u0000000-0000-4000-8000-000000000001'
    )
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'hub-template-install' })
    )
  })

  it('a retry finds only the template’s own collections: installs again (idempotent)', async () => {
    await db('nivaro_collections').insert([{ collection: 'assets' }])
    expect((await post(body())).statusCode).toBe(200)
  })

  it('an app with its own collections refuses 409 APP_NOT_EMPTY and writes nothing', async () => {
    await db('nivaro_collections').insert([{ collection: 'orders' }])
    const r = await post(body())
    expect(r.statusCode).toBe(409)
    expect(r.json()).toMatchObject({ code: 'APP_NOT_EMPTY', collections: ['orders'] })
    expect(installBlueprint).not.toHaveBeenCalled()
  })

  it('a bundle that does not match its digest refuses 400 BAD_DIGEST', async () => {
    const r = await post({ ...body(), digest: 'sha256:00' })
    expect(r.statusCode).toBe(400)
    expect(r.json().code).toBe('BAD_DIGEST')
  })

  it('not a blueprint → 400 BAD_BUNDLE', async () => {
    const r = await post({ bundle: { type: 'x' }, digest: 'sha256:1' })
    expect(r.json().code).toBe('BAD_BUNDLE')
  })

  it('two calls at once share one install', async () => {
    let release: () => void = () => {}
    vi.mocked(installBlueprint).mockImplementation(
      () => new Promise((res) => (release = () => res(REPORT as never)))
    )
    const a = post(body())
    const b = post(body())
    await new Promise((r) => setTimeout(r, 20))
    release()
    const [ra, rb] = await Promise.all([a, b])
    expect(ra.statusCode).toBe(200)
    expect(rb.statusCode).toBe(200)
    expect(installBlueprint).toHaveBeenCalledTimes(1)
  })

  it('an installer crash answers a generic 500 TEMPLATE_FAILED', async () => {
    vi.mocked(installBlueprint).mockRejectedValue(new Error('driver said: secret host x'))
    const r = await post(body())
    expect(r.statusCode).toBe(500)
    expect(r.json().code).toBe('TEMPLATE_FAILED')
    expect(r.body).not.toContain('secret host')
  })
})
