import { join } from 'node:path'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Hub verification routes (routes/hub-verify.ts) on SQLite with the Hub tables, behind the real
// credential gate: owners read their own app only (404 otherwise), every write is admin-only,
// a suite is validated and logged, and an API key needs hub:write to change a suite.

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
  const sign = async (req: FastifyRequest) => {
    const h = req.headers as Record<string, string | undefined>
    const id = h['x-user']
    if (!id) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    req.user = { id, status: 'active' } as never
    req.isAdmin = h['x-admin'] === '1'
    req.authMethod = (h['x-auth'] ?? 'session') as never
    if (h['x-scopes']) req.apiKeyScopes = JSON.parse(h['x-scopes'])
  }
  const admin = async (req: FastifyRequest) => {
    await sign(req)
    if (!req.isAdmin)
      throw Object.assign(new Error('Forbidden'), { statusCode: 403, code: 'ADMIN_ONLY' })
  }
  return { requireAuth: vi.fn(sign), requireAdmin: vi.fn(admin), authenticate: vi.fn(sign) }
})
const logActivity = vi.fn(async () => 1)
vi.mock('../../../services/activity.js', () => ({ logActivity }))

process.env.HUB = 'on'
const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { hubVerifyRoutes } = await import('../../../routes/hub-verify.js')
const { installHubCredentialGate } = await import('../../../services/hub/api/gate.js')

const ADMIN = 'AAAAAAAA-0000-4000-8000-000000000001'
const OWNER = 'BBBBBBBB-0000-4000-8000-000000000002'
const asAdmin = { 'x-user': ADMIN, 'x-admin': '1' }
const asOwner = { 'x-user': OWNER }
let app: FastifyInstance
let mine: number
let theirs: number

beforeAll(async () => {
  const dir = join(import.meta.dirname, '../../../db/migrations')
  for (const m of [
    '542_hub_tables',
    '543_hub_promotions',
    '552_hub_shared_deployments',
    '553_hub_moves',
    '565_hub_release_ops',
    '570_hub_people_owner_policy',
    '574_hub_verify'
  ])
    await (await import(/* @vite-ignore */ join(dir, `${m}.ts`))).up(db)
  const [a] = await db('nivaro_hub_apps').insert({ key: 'mine', name: 'Mine' })
  const [b] = await db('nivaro_hub_apps').insert({ key: 'theirs', name: 'Theirs' })
  await db('nivaro_hub_app_owners').insert({ app_id: Number(a), user_id: OWNER })
  const [e1] = await db('nivaro_hub_environments').insert({
    app_id: Number(a),
    key: 'staging',
    base_url: 'https://mine.example.com'
  })
  const [e2] = await db('nivaro_hub_environments').insert({
    app_id: Number(b),
    key: 'production',
    base_url: 'https://theirs.example.com'
  })
  mine = Number(e1)
  theirs = Number(e2)
  app = Fastify()
  installHubCredentialGate(app)
  await app.register(hubVerifyRoutes, { prefix: '/api/hub' })
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

const suiteBody = { checks: [{ kind: 'http', name: 'Home', path: '/' }], on_fail: 'notify' }

describe('hub verify routes', () => {
  it('owners read their own environments only; others answer 404', async () => {
    const own = await app.inject({
      method: 'GET',
      url: `/api/hub/environments/${mine}/smoke`,
      headers: asOwner
    })
    expect(own.statusCode).toBe(200)
    const other = await app.inject({
      method: 'GET',
      url: `/api/hub/environments/${theirs}/smoke`,
      headers: asOwner
    })
    expect(other.statusCode).toBe(404)
    const list = await app.inject({ method: 'GET', url: '/api/hub/verify/smoke', headers: asOwner })
    expect(list.json().data.environments.map((e: { key: string }) => e.key)).toEqual(['staging'])
  })

  it('only administrators save, run or remove a suite; a save is validated and logged', async () => {
    const owner = await app.inject({
      method: 'PUT',
      url: `/api/hub/environments/${mine}/smoke`,
      headers: asOwner,
      payload: suiteBody
    })
    expect(owner.statusCode).toBe(403)
    const bad = await app.inject({
      method: 'PUT',
      url: `/api/hub/environments/${mine}/smoke`,
      headers: asAdmin,
      payload: { checks: [{ kind: 'http', path: 'https://elsewhere' }] }
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('BAD_SUITE')
    const ok = await app.inject({
      method: 'PUT',
      url: `/api/hub/environments/${mine}/smoke`,
      headers: asAdmin,
      payload: suiteBody
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().data.checks).toHaveLength(1)
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'hub-smoke-suite-save', user: ADMIN })
    )
    for (const [method, url] of [
      ['POST', `/api/hub/environments/${mine}/smoke/run`],
      ['DELETE', `/api/hub/environments/${mine}/smoke`],
      ['POST', '/api/hub/verify/extensions/refresh'],
      ['POST', `/api/hub/environments/${mine}/extensions/efp-ops/promote`]
    ] as const) {
      const r = await app.inject({ method, url, headers: asOwner, payload: {} })
      expect([method, url, r.statusCode]).toEqual([method, url, 403])
    }
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/hub/environments/${mine}/smoke`,
      headers: asAdmin
    })
    expect(del.statusCode).toBe(200)
  })

  it('an API key needs hub:write to change a suite and hub:read to read', async () => {
    const readKey = {
      ...asAdmin,
      'x-auth': 'api_key',
      'x-scopes': JSON.stringify([{ collection: '$hub', actions: ['read'] }])
    }
    const read = await app.inject({
      method: 'GET',
      url: '/api/hub/verify/extensions',
      headers: readKey
    })
    expect(read.statusCode).toBe(200)
    const write = await app.inject({
      method: 'PUT',
      url: `/api/hub/environments/${mine}/smoke`,
      headers: readKey,
      payload: suiteBody
    })
    expect(write.statusCode).toBe(403)
  })

  it('Run now refuses an environment without a suite', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/hub/environments/${mine}/smoke/run`,
      headers: asAdmin
    })
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('NO_SUITE')
  })
})
