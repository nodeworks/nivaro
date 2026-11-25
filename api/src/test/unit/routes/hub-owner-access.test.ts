import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub: app owner self-service (services/hub/owner-access.ts). Owners deploy, restart and
// apply on NON-production environments only, unless an admin turns on the app's switch. Real
// SQLite for apps/environments/owners/deploys; the promotion runner and the stack apply are
// mocked. The guard test pins every non-admin Hub write to OWNER_GUARDED or OWNER_UNGUARDED.

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

const m = vi.hoisted(() => ({
  start: vi.fn(),
  cancel: vi.fn(),
  apply: vi.fn(),
  gather: vi.fn(),
  getDatabase: vi.fn()
}))
vi.mock('../../../services/hub/db/databases.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/hub/db/databases.js')>()),
  getDatabase: m.getDatabase
}))
vi.mock('../../../services/hub/promote-run.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/hub/promote-run.js')>()),
  startPromotion: m.start,
  cancelPromotion: m.cancel,
  startStackApply: m.apply,
  recoverOnceAtBoot: vi.fn()
}))
vi.mock('../../../services/hub/promote-gather.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/hub/promote-gather.js')>()),
  gatherPlanInput: m.gather
}))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { up } = await import('../../../db/migrations/542_hub_tables.js')
const { up: up543 } = await import('../../../db/migrations/543_hub_promotions.js')
const { up: up570 } = await import('../../../db/migrations/570_hub_people_owner_policy.js')
const { hubRoutes } = await import('../../../routes/hub.js')
const { hubSigninAdminRoutes } = await import('../../../routes/hub-signin-admin.js')
const { hubInsightRoutes } = await import('../../../routes/hub-insight.js')
const auth = await import('../../../middleware/authenticate.js')
const { OWNER_GUARDED, OWNER_UNGUARDED, isProductionEnv } = await import(
  '../../../services/hub/owner-access.js'
)
const { setAppRef } = await import('../../../services/io-holder.js')
const { hubStatusKey } = await import('../../../services/hub/status.js')

const OWNER = 'BBBBBBBB-0000-4000-8000-000000000002'
const asAdmin = { 'x-user': 'AAAAAAAA-0000-4000-8000-000000000001', 'x-admin': '1' }
const asOwner = { 'x-user': OWNER }
const asOther = { 'x-user': 'CCCCCCCC-0000-4000-8000-000000000003' }

let app: FastifyInstance
const routes: RouteOptions[] = []
let prevHub: string | undefined
let appId: number
let stagingId: number
let prodId: number
let prodDeploy: number
let stagingDeploy: number

const idOf = (r: unknown) => {
  const x = (r as Array<number | { id: number }>)[0]
  return typeof x === 'object' ? x.id : x
}

beforeAll(async () => {
  prevHub = process.env.HUB
  process.env.HUB = 'on'
  await up(db)
  await up543(db)
  await up570(db)
  await db.schema.createTable('nivaro_users', (t) => {
    t.string('id').primary()
    t.string('first_name')
    t.string('last_name')
    t.string('email')
  })
  app = Fastify()
  app.addHook('onRoute', (r) => {
    routes.push(r)
  })
  await app.register(hubRoutes, { prefix: '/api/hub' })
  // The sign-in plugin is its own mount: the owner rule and the guard test cover it too (M2).
  await app.register(hubSigninAdminRoutes, { prefix: '/api/hub/signin' })
  // Hub insight is its own mount too: its non-admin writes are listed in OWNER_UNGUARDED.
  await app.register(hubInsightRoutes, { prefix: '/api/hub' })
  await app.ready()
})
afterAll(async () => {
  await app.close()
  await db.destroy()
  if (prevHub === undefined) delete process.env.HUB
  else process.env.HUB = prevHub
})
beforeEach(async () => {
  vi.clearAllMocks()
  for (const t of [
    'nivaro_hub_deploys',
    'nivaro_hub_environments',
    'nivaro_hub_app_owners',
    'nivaro_hub_apps'
  ])
    await db(t).del()
  appId = idOf(
    await db('nivaro_hub_apps')
      .insert({ key: 'efp', name: 'EFP', signin_mode: 'direct', extensions: '[]' })
      .returning('id')
  )
  const env = async (key: string, position: number) =>
    idOf(
      await db('nivaro_hub_environments')
        .insert({
          app_id: appId,
          key,
          base_url: `https://${key}.example.com`,
          hostnames: '[]',
          status: 'active',
          position
        })
        .returning('id')
    )
  stagingId = await env('staging', 0)
  // Named neither production nor prod: production because it ends the chain.
  prodId = await env('main', 1)
  await db('nivaro_hub_app_owners').insert({ app_id: appId, user_id: OWNER })
  const deploy = async (envId: number) =>
    idOf(
      await db('nivaro_hub_deploys')
        .insert({
          app_id: appId,
          environment_id: envId,
          kind: 'promote',
          version: '0.3.215',
          status: 'running',
          started_at: new Date()
        })
        .returning('id')
    )
  prodDeploy = await deploy(prodId)
  stagingDeploy = await deploy(stagingId)
  m.start.mockResolvedValue({ deployId: 9, jobRunId: 10 })
  m.apply.mockResolvedValue({ deployId: 9, jobRunId: 10 })
  m.cancel.mockResolvedValue({ ok: true })
  m.gather.mockRejectedValue(Object.assign(new Error('stop'), { code: 'X' }))
})

const call = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  p: string,
  headers: Record<string, string>,
  payload?: unknown
) => app.inject({ method, url: `/api/hub${p}`, headers, payload: payload as never })

const promote = (envId: number, h: Record<string, string>) =>
  call('POST', `/environments/${envId}/promote`, h, {
    kind: 'promote',
    version: '0.3.215',
    confirm: 'x',
    plan_hash: 'c'.repeat(64)
  })

describe('production rule', () => {
  it('production = a production-like key, or the end of the chain (one environment = prod)', () => {
    const chain = [
      { id: 1, key: 'development', position: 0 },
      { id: 2, key: 'staging', position: 1 },
      { id: 3, key: 'production', position: 2 }
    ]
    expect(chain.map((e) => isProductionEnv(e, chain))).toEqual([false, false, true])
    const odd = [
      { id: 1, key: 'prod', position: 0 },
      { id: 2, key: 'qa', position: 1 }
    ]
    expect(odd.map((e) => isProductionEnv(e, odd))).toEqual([true, true])
    expect(isProductionEnv({ id: 7, key: 'dev', position: 0 }, [])).toBe(true)
    // Same position: the higher id ends the chain.
    const tie = [
      { id: 4, key: 'a', position: 0 },
      { id: 5, key: 'b', position: 0 }
    ]
    expect(tie.map((e) => isProductionEnv(e, tie))).toEqual([false, true])
  })
})

describe('production signals (any one is enough; fail closed)', () => {
  const env = (id: number, key: string, position: number, more: Record<string, unknown> = {}) => ({
    id,
    key,
    position,
    ...more
  })

  it('a production word in the key: prod-eu, production2, prd_eu, eu-live — not prodigy', () => {
    const other = env(99, 'zz-last', 9)
    for (const key of ['prod-eu', 'production2', 'prd_eu', 'eu-live', 'PROD', 'live'])
      expect([key, isProductionEnv(env(1, key, 0), [env(1, key, 0), other])]).toEqual([key, true])
    for (const key of ['prodigy', 'reproduce', 'staging', 'delivery', 'olive'])
      expect([key, isProductionEnv(env(1, key, 0), [env(1, key, 0), other])]).toEqual([key, false])
  })

  it('archived environments leave the chain: archiving the last one never opens the one before', () => {
    const chain = [env(1, 'staging', 0), env(2, 'main', 1, { status: 'archived' })]
    expect(isProductionEnv(chain[0], chain)).toBe(true)
    // The archived one itself counts as production too.
    expect(isProductionEnv(chain[1], chain)).toBe(true)
  })

  it('the admin flag: true makes production, false opens a last environment, never a named one', () => {
    const chain = [env(1, 'staging', 0, { production: true }), env(2, 'main', 1)]
    expect(isProductionEnv(chain[0], chain)).toBe(true)
    const opened = [env(1, 'staging', 0), env(2, 'main', 1, { production: false })]
    expect(isProductionEnv(opened[1], opened)).toBe(false)
    const named = [env(1, 'staging', 0), env(2, 'production', 1, { production: false })]
    expect(isProductionEnv(named[1], named)).toBe(true)
  })

  it('the environment’s own report: NIVARO_ENVIRONMENT=production makes it production', () => {
    const chain = [env(1, 'qa', 0, { reported: 'production' }), env(2, 'main', 1)]
    expect(isProductionEnv(chain[0], chain)).toBe(true)
    expect(isProductionEnv(env(1, 'qa', 0, { reported: 'staging' }), chain)).toBe(false)
    // The report beats an admin's false.
    expect(
      isProductionEnv(env(1, 'qa', 0, { reported: 'production', production: false }), chain)
    ).toBe(true)
  })

  it('everything from the first production onward: two regions, a trailing qa, a trailing archived', () => {
    const regions = [env(1, 'staging', 0), env(2, 'prod-eu', 1), env(3, 'prod-us', 2)]
    expect(regions.map((e) => isProductionEnv(e, regions))).toEqual([false, true, true])
    // A qa (or dr) appended after production never opens production, nor itself.
    const trailing = [
      env(1, 'staging', 0),
      env(2, 'main', 1, { production: true }),
      env(3, 'qa', 2)
    ]
    expect(trailing.map((e) => isProductionEnv(e, trailing))).toEqual([false, true, true])
    // A trailing archived environment does not move "last" off production.
    const archived = [
      env(1, 'staging', 0),
      env(2, 'main', 1),
      env(3, 'legacy', 2, { status: 'archived' })
    ]
    expect(archived.map((e) => isProductionEnv(e, archived))).toEqual([false, true, true])
    expect(isProductionEnv(env(1, 'eu.prod', 0), [env(1, 'eu.prod', 0), env(2, 'z', 5)])).toBe(true)
  })

  it('route: archiving production makes staging production for owners', async () => {
    await db('nivaro_hub_environments').where({ id: prodId }).update({ status: 'archived' })
    const r = await promote(stagingId, asOwner)
    expect(r.statusCode).toBe(403)
    expect(r.json().code).toBe('PRODUCTION_ADMIN_ONLY')
    const access = (await call('GET', `/apps/${appId}/access`, asOwner)).json().data
    expect(access.environments.find((e: { id: number }) => e.id === stagingId)).toMatchObject({
      production: true,
      deploy: false
    })
  })

  it('route: only an admin sets the flag; false opens the last environment, true closes staging', async () => {
    const set = (envId: number, h: Record<string, string>, production: unknown) =>
      call('PUT', `/environments/${envId}/production`, h, { production })
    expect((await set(prodId, asOwner, false)).statusCode).toBe(403)
    expect((await set(prodId, asAdmin, 'no')).statusCode).toBe(400)
    expect((await set(prodId, asAdmin, false)).json()).toEqual({
      data: { id: prodId, production: false }
    })
    expect((await promote(prodId, asOwner)).statusCode).toBe(202)
    await set(stagingId, asAdmin, true)
    expect((await promote(stagingId, asOwner)).json().code).toBe('PRODUCTION_ADMIN_ONLY')
    await set(stagingId, asAdmin, null)
    expect((await promote(stagingId, asOwner)).statusCode).toBe(202)
  })

  it('route: the cached hub-link report NIVARO_ENVIRONMENT=production closes staging', async () => {
    setAppRef({
      redis: {
        get: async (k: string) =>
          k === hubStatusKey(stagingId)
            ? JSON.stringify({ state: 'ok', app_environment: 'production' })
            : null
      }
    })
    try {
      expect((await promote(stagingId, asOwner)).json().code).toBe('PRODUCTION_ADMIN_ONLY')
    } finally {
      setAppRef(null)
    }
    expect((await promote(stagingId, asOwner)).statusCode).toBe(202)
  })
})

describe('owners on non-production', () => {
  it('promote, plan, cancel, restart, apply and settings reach the route', async () => {
    expect((await promote(stagingId, asOwner)).statusCode).toBe(202)
    expect(m.start).toHaveBeenCalledTimes(1)
    const plan = await call('POST', `/environments/${stagingId}/promote/plan`, asOwner, {
      kind: 'promote',
      version: '0.3.215'
    })
    expect(plan.json().code).not.toBe('PRODUCTION_ADMIN_ONLY')
    expect(m.gather).toHaveBeenCalled()
    expect((await call('POST', `/promotions/${stagingDeploy}/cancel`, asOwner)).statusCode).toBe(
      202
    )
    for (const p of ['stack/restart', 'stack/apply'])
      expect(
        (
          await call('POST', `/environments/${stagingId}/${p}`, asOwner, { confirm: 'staging' })
        ).json().code
      ).not.toBe('PRODUCTION_ADMIN_ONLY')
    expect(
      (await call('GET', `/environments/${stagingId}/stack/settings`, asOwner)).json().code
    ).not.toBe('PRODUCTION_ADMIN_ONLY')
  })
})

describe('owners on production', () => {
  it('every deploy-class route answers 403 PRODUCTION_ADMIN_ONLY and starts nothing', async () => {
    const answers = [
      await promote(prodId, asOwner),
      await call('POST', `/environments/${prodId}/promote/plan`, asOwner, {
        kind: 'promote',
        version: '0.3.215'
      }),
      await call('POST', `/promotions/${prodDeploy}/cancel`, asOwner),
      await call('POST', `/environments/${prodId}/stack/restart`, asOwner, { confirm: 'main' }),
      await call('POST', `/environments/${prodId}/stack/apply`, asOwner, { confirm: 'main' }),
      await call('GET', `/environments/${prodId}/stack/settings`, asOwner)
    ]
    for (const a of answers) {
      expect(a.statusCode).toBe(403)
      expect(a.json().code).toBe('PRODUCTION_ADMIN_ONLY')
    }
    expect(m.start).not.toHaveBeenCalled()
    expect(m.cancel).not.toHaveBeenCalled()
    expect(m.apply).not.toHaveBeenCalled()
    expect(m.gather).not.toHaveBeenCalled()
  })

  it('reads stay open: status-free deploy history and the run itself', async () => {
    expect((await call('GET', `/environments/${prodId}/deploys/hub`, asOwner)).statusCode).toBe(200)
    expect((await call('GET', `/promotions/${prodDeploy}`, asOwner)).statusCode).toBe(200)
  })

  it('admins deploy production; the app switch lets owners too; only admins set it', async () => {
    expect((await promote(prodId, asAdmin)).statusCode).toBe(202)
    const refused = await call('PUT', `/apps/${appId}/owner-policy`, asOwner, {
      owners_deploy_production: true
    })
    expect(refused.statusCode).toBe(403)
    const bad = await call('PUT', `/apps/${appId}/owner-policy`, asAdmin, {
      owners_deploy_production: 'yes'
    })
    expect(bad.statusCode).toBe(400)
    const on = await call('PUT', `/apps/${appId}/owner-policy`, asAdmin, {
      owners_deploy_production: true
    })
    expect(on.json()).toEqual({ data: { owners_deploy_production: true } })
    expect((await promote(prodId, asOwner)).statusCode).toBe(202)
    expect((await call('POST', `/promotions/${prodDeploy}/cancel`, asOwner)).statusCode).toBe(202)
  })

  it('a non-owner still gets 404, never a hint about production', async () => {
    const r = await promote(prodId, asOther)
    expect(r.statusCode).toBe(404)
    expect((await call('GET', `/apps/${appId}/access`, asOther)).statusCode).toBe(404)
  })
})

describe('GET /apps/:id/access', () => {
  it('says per environment whether the caller may deploy', async () => {
    const owner = (await call('GET', `/apps/${appId}/access`, asOwner)).json().data
    expect(owner).toMatchObject({ admin: false, owner: true, owners_deploy_production: false })
    expect(owner.environments).toEqual([
      {
        id: stagingId,
        key: 'staging',
        production: false,
        deploy: true,
        production_flag: null,
        archived: false,
        reported: null
      },
      {
        id: prodId,
        key: 'main',
        production: true,
        deploy: false,
        production_flag: null,
        archived: false,
        reported: null
      }
    ])
    const admin = (await call('GET', `/apps/${appId}/access`, asAdmin)).json().data
    expect(admin.environments.every((e: { deploy: boolean }) => e.deploy)).toBe(true)
  })
})

describe('database connection (owner rule)', () => {
  const dbFor = (envId: number) => ({
    id: 7,
    engine: 'mssql',
    host: 'db.x',
    port: 1433,
    status: 'requested',
    environment: { id: envId, app_id: appId, app_key: 'efp', env_key: 'x' }
  })
  it('an owner may set the connection of a non-production database only', async () => {
    m.getDatabase.mockResolvedValue(dbFor(prodId))
    const prod = await call('PUT', '/databases/7/connection', asOwner, { host: 'db.x' })
    expect(prod.statusCode).toBe(403)
    expect(prod.json().code).toBe('PRODUCTION_ADMIN_ONLY')
    m.getDatabase.mockResolvedValue(dbFor(stagingId))
    const staging = await call('PUT', '/databases/7/connection', asOwner, { host: 'db.x' })
    expect(staging.json().code).not.toBe('PRODUCTION_ADMIN_ONLY')
    // An administrator is never refused by the owner rule.
    m.getDatabase.mockResolvedValue(dbFor(prodId))
    const admin = await call('PUT', '/databases/7/connection', asAdmin, { host: 'db.x' })
    expect(admin.json().code).not.toBe('PRODUCTION_ADMIN_ONLY')
  })
})

describe('sign-in on production (M2)', () => {
  it('an owner may not change the app’s sign-in mode or production’s client; staging is theirs', async () => {
    const mode = await call('PATCH', `/signin/apps/${appId}/mode`, asOwner, {
      signin_mode: 'hub'
    })
    expect(mode.json().code).toBe('PRODUCTION_ADMIN_ONLY')
    for (const [method, path] of [
      ['POST', `/signin/environments/${prodId}/client`],
      ['PATCH', `/signin/environments/${prodId}/client`],
      ['POST', `/signin/environments/${prodId}/client/rotate`]
    ] as const) {
      const r = await call(method, path, asOwner, { active: true })
      expect([method, path, r.json().code]).toEqual([method, path, 'PRODUCTION_ADMIN_ONLY'])
    }
    const staging = await call('POST', `/signin/environments/${stagingId}/client`, asOwner, {})
    expect(staging.json().code).not.toBe('PRODUCTION_ADMIN_ONLY')
  })
})

describe('guard', () => {
  it('every Hub write not behind requireAdmin is owner-guarded or listed with a reason', () => {
    // Whatever the route authenticates with (requireAuth, authenticate + an inline check, an
    // onRequest hook, a bearer): only a requireAdmin preHandler takes a write off this list.
    const requireAdmin = auth.requireAdmin as unknown
    const strip = (u: string) => u.replace(/^\/api\/hub/, '')
    const pre = (r: RouteOptions) =>
      r.preHandler ? (Array.isArray(r.preHandler) ? r.preHandler : [r.preHandler]) : []
    const writes = routes.filter(
      (r) =>
        (Array.isArray(r.method) ? r.method : [r.method]).some(
          (x) => x !== 'GET' && x !== 'HEAD'
        ) && !pre(r).includes(requireAdmin as never)
    )
    // The sign-in plugin was really scanned.
    expect(routes.some((r) => strip(r.url).startsWith('/signin/'))).toBe(true)
    const guarded = new Set(OWNER_GUARDED.map((g) => `${g.method} ${g.url}`))
    const missing = writes
      .map((r) => `${r.method} ${strip(r.url)}`)
      .filter((k) => !guarded.has(k) && !(k in OWNER_UNGUARDED))
    expect(missing).toEqual([])
    // Every table entry names a route that exists (no stale entries).
    const all = new Set(routes.map((r) => `${r.method} ${strip(r.url)}`))
    for (const k of [...guarded, ...Object.keys(OWNER_UNGUARDED)]) expect(all.has(k)).toBe(true)
    // The guard really sits on each guarded route, after the route's own sign-in.
    for (const g of OWNER_GUARDED) {
      const r = routes.find((x) => x.method === g.method && strip(x.url) === g.url)
      const list = r ? pre(r) : []
      expect(list.at(-1)?.name).toBe('ownerDeployGuard')
    }
  })
})
