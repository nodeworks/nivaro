import Fastify, { type FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub (phase 1): environment status and deploy history routes. Real SQLite for apps,
// environments and owners; the status reader and the deploy lister are mocked (their own tests
// cover them). Admins and the app's owners read; anyone else gets 404.

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

const m = vi.hoisted(() => ({ envStatus: vi.fn(), appStatus: vi.fn(), deploys: vi.fn() }))
vi.mock('../../../services/hub/status.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/hub/status.js')>()),
  readEnvironmentStatus: m.envStatus,
  readAppStatus: m.appStatus
}))
vi.mock('../../../services/hub/deploys.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/hub/deploys.js')>()),
  listEnvironmentDeploys: m.deploys
}))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { up } = await import('../../../db/migrations/542_hub_tables.js')
const { hubRoutes } = await import('../../../routes/hub.js')
const { GitlabUnreachableError } = await import('../../../services/hub/deploys.js')
const { DriverMisconfiguredError } = await import('../../../services/hub/drivers.js')
const { HubSecretError } = await import('../../../services/hub/secrets.js')

const OWNER = 'BBBBBBBB-0000-4000-8000-000000000002'
const OTHER = 'CCCCCCCC-0000-4000-8000-000000000003'

const asAdmin = { 'x-user': 'AAAAAAAA-0000-4000-8000-000000000001', 'x-admin': '1' }
const asOwner = { 'x-user': OWNER }
const asOther = { 'x-user': OTHER }

const OK = {
  state: 'ok',
  version: '0.3.208',
  preflight: 'ok',
  checked_at: '2026-11-21T10:00:00.000Z',
  source: 'hub-link'
}

const fakeRedis = { get: vi.fn(), set: vi.fn(), del: vi.fn() }

let app: FastifyInstance
let prevHub: string | undefined
let appId: number
let envId: number

beforeAll(async () => {
  prevHub = process.env.HUB
  process.env.HUB = 'on'
  await up(db)
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
})
beforeEach(async () => {
  vi.resetAllMocks()
  await db('nivaro_hub_environments').del()
  await db('nivaro_hub_app_owners').del()
  await db('nivaro_hub_apps').del()
  ;[appId] = (await db('nivaro_hub_apps')
    .insert({ key: 'efp', name: 'EFP', signin_mode: 'direct', extensions: '[]' })
    .returning('id')
    .then((r) => r.map((x: { id: number } | number) => (typeof x === 'object' ? x.id : x)))) as [
    number
  ]
  ;[envId] = (await db('nivaro_hub_environments')
    .insert({
      app_id: appId,
      key: 'prod',
      base_url: 'https://efp.example.com',
      hostnames: '[]',
      status: 'active',
      position: 0,
      placement_id: 4
    })
    .returning('id')
    .then((r) => r.map((x: { id: number } | number) => (typeof x === 'object' ? x.id : x)))) as [
    number
  ]
  await db('nivaro_hub_app_owners').insert({ app_id: appId, user_id: OWNER })
  m.envStatus.mockResolvedValue(OK)
  m.appStatus.mockImplementation(async (envs: { id: number; key: string }[]) =>
    envs.map((e) => ({ id: e.id, key: e.key, status: OK }))
  )
  m.deploys.mockResolvedValue({ data: [] })
})

const get = (url: string, headers: Record<string, string>) =>
  app.inject({ method: 'GET', url, headers })

describe('environment status', () => {
  it('admin reads it; ?fresh=1 skips the cache; the app Redis is passed in', async () => {
    const r = await get(`/hub/environments/${envId}/status`, asAdmin)
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ data: OK })
    expect(m.envStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: envId, base_url: 'https://efp.example.com' }),
      { fresh: false, redis: fakeRedis }
    )
    await get(`/hub/environments/${envId}/status?fresh=1`, asAdmin)
    expect(m.envStatus).toHaveBeenLastCalledWith(expect.anything(), {
      fresh: true,
      redis: fakeRedis
    })
  })

  it('an owner of the app reads it; anyone else → 404 and nothing is fetched', async () => {
    expect((await get(`/hub/environments/${envId}/status`, asOwner)).statusCode).toBe(200)
    m.envStatus.mockClear()
    const r = await get(`/hub/environments/${envId}/status`, asOther)
    expect(r.statusCode).toBe(404)
    expect(r.json().code).toBe('NOT_FOUND')
    expect(m.envStatus).not.toHaveBeenCalled()
    expect((await get('/hub/environments/999/status', asAdmin)).statusCode).toBe(404)
    expect((await get('/hub/environments/x/status', asAdmin)).statusCode).toBe(404)
  })

  it('app status reads every environment; non-owner → 404', async () => {
    const r = await get(`/hub/apps/${appId}/status`, asOwner)
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toEqual([{ id: envId, key: 'prod', status: OK }])
    expect(m.appStatus).toHaveBeenCalledWith(
      [expect.objectContaining({ id: envId, key: 'prod' })],
      { fresh: false, redis: fakeRedis }
    )
    expect((await get(`/hub/apps/${appId}/status`, asOther)).statusCode).toBe(404)
    expect((await get('/hub/apps/999/status', asAdmin)).statusCode).toBe(404)
  })
})

describe('environment deploys', () => {
  it('admin and owner read them; limit is clamped to 1..50', async () => {
    m.deploys.mockResolvedValue({ data: [], reason: 'NO_DRIVER' })
    const r = await get(`/hub/environments/${envId}/deploys`, asAdmin)
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ data: [], reason: 'NO_DRIVER' })
    expect(m.deploys).toHaveBeenLastCalledWith(expect.objectContaining({ placement_id: 4 }), {
      limit: 20
    })
    await get(`/hub/environments/${envId}/deploys?limit=500`, asOwner)
    expect(m.deploys).toHaveBeenLastCalledWith(expect.anything(), { limit: 50 })
    await get(`/hub/environments/${envId}/deploys?limit=0`, asOwner)
    expect(m.deploys).toHaveBeenLastCalledWith(expect.anything(), { limit: 1 })
    await get(`/hub/environments/${envId}/deploys?limit=abc`, asOwner)
    expect(m.deploys).toHaveBeenLastCalledWith(expect.anything(), { limit: 20 })
  })

  it('a non-owner → 404 and GitLab is never asked', async () => {
    const r = await get(`/hub/environments/${envId}/deploys`, asOther)
    expect(r.statusCode).toBe(404)
    expect(m.deploys).not.toHaveBeenCalled()
  })

  it('GitLab unreachable → 502 GITLAB_UNREACHABLE', async () => {
    m.deploys.mockRejectedValue(new GitlabUnreachableError('connect ECONNREFUSED 10.0.0.1:443'))
    const r = await get(`/hub/environments/${envId}/deploys`, asAdmin)
    expect(r.statusCode).toBe(502)
    expect(r.json().code).toBe('GITLAB_UNREACHABLE')
    expect(r.body).not.toContain('10.0.0.1')
  })

  it('a misconfigured driver or an unreadable token → 409 with that code', async () => {
    m.deploys.mockRejectedValueOnce(new DriverMisconfiguredError('no address'))
    const a = await get(`/hub/environments/${envId}/deploys`, asAdmin)
    expect(a.statusCode).toBe(409)
    expect(a.json().code).toBe('DRIVER_MISCONFIGURED')
    m.deploys.mockRejectedValueOnce(new HubSecretError('HUB_SECRET_UNREADABLE', 'bad key'))
    const b = await get(`/hub/environments/${envId}/deploys`, asAdmin)
    expect(b.statusCode).toBe(409)
    expect(b.json().code).toBe('HUB_SECRET_UNREADABLE')
    m.deploys.mockRejectedValueOnce(new HubSecretError('HUB_SECRET_NOT_SEALED', 'plain'))
    const c = await get(`/hub/environments/${envId}/deploys`, asAdmin)
    expect(c.statusCode).toBe(409)
    expect(c.json().code).toBe('HUB_SECRET_NOT_SEALED')
  })
})

describe('deploy history cache', () => {
  const ONE = {
    data: [
      {
        pipeline_id: 77,
        ref: 'production',
        sha: 'abc1234',
        status: 'success',
        started_at: null,
        finished_at: null,
        web_url: 'https://gitlab.example.com/p/77',
        deploy_job: null,
        version: '0.3.208'
      }
    ]
  }
  const key = (limit = 20) => `nvr:hub:deploys:${envId}:${limit}`

  it('a miss asks GitLab and keeps the answer 60 s under the env + limit key', async () => {
    m.deploys.mockResolvedValue(ONE)
    const r = await get(`/hub/environments/${envId}/deploys`, asAdmin)
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual(ONE)
    expect(fakeRedis.get).toHaveBeenCalledWith(key())
    expect(m.deploys).toHaveBeenCalledTimes(1)
    await vi.waitFor(() =>
      expect(fakeRedis.set).toHaveBeenCalledWith(key(), JSON.stringify(ONE), 'EX', 60)
    )
    await get(`/hub/environments/${envId}/deploys?limit=5`, asAdmin)
    expect(fakeRedis.get).toHaveBeenLastCalledWith(key(5))
  })

  it('a hit answers from the cache and GitLab is not asked', async () => {
    fakeRedis.get.mockResolvedValue(JSON.stringify(ONE))
    const r = await get(`/hub/environments/${envId}/deploys`, asOwner)
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual(ONE)
    expect(m.deploys).not.toHaveBeenCalled()
  })

  it('?fresh=1 skips the cached answer and stores the new one', async () => {
    fakeRedis.get.mockResolvedValue(JSON.stringify({ data: [] }))
    m.deploys.mockResolvedValue(ONE)
    const r = await get(`/hub/environments/${envId}/deploys?fresh=1`, asAdmin)
    expect(r.json()).toEqual(ONE)
    expect(fakeRedis.get).not.toHaveBeenCalled()
    await vi.waitFor(() =>
      expect(fakeRedis.set).toHaveBeenCalledWith(key(), JSON.stringify(ONE), 'EX', 60)
    )
  })

  it('a Redis that fails or hangs never fails or holds the read', async () => {
    m.deploys.mockResolvedValue(ONE)
    fakeRedis.get.mockRejectedValue(new Error('redis down'))
    fakeRedis.set.mockRejectedValue(new Error('redis down'))
    const a = await get(`/hub/environments/${envId}/deploys`, asAdmin)
    expect(a.statusCode).toBe(200)
    expect(a.json()).toEqual(ONE)
    fakeRedis.get.mockImplementation(() => new Promise(() => {}))
    fakeRedis.set.mockImplementation(() => new Promise(() => {}))
    const started = Date.now()
    const b = await get(`/hub/environments/${envId}/deploys`, asAdmin)
    expect(b.statusCode).toBe(200)
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it('a refusal is never cached', async () => {
    m.deploys.mockRejectedValue(new GitlabUnreachableError('down'))
    const r = await get(`/hub/environments/${envId}/deploys`, asAdmin)
    expect(r.statusCode).toBe(502)
    expect(fakeRedis.set).not.toHaveBeenCalled()
  })
})
