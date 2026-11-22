import Fastify, { type FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 6, Task 3: the shared-deployment admin routes and the app-key routes. Real
// SQLite with the hub tables (542–553); the deployment link client and the dedicated app's hub
// link are mocked (their own tests cover them). Every route is admin-only; the token is shown
// once; no activity row ever holds a token or an app key.

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
  status: vi.fn(),
  appStatus: vi.fn(),
  linkedFp: vi.fn(),
  deleteShared: null as null | ((...a: unknown[]) => Promise<unknown>),
  stackKey: null as string | null,
  lockFail: false
}))
vi.mock('../../../services/hub/promote-lock.js', async (orig) => {
  const real = await orig<typeof import('../../../services/hub/promote-lock.js')>()
  const failing = (): never => {
    throw new real.PromotionError('LOCK_UNAVAILABLE', 'The Hub cannot reach Redis', 503)
  }
  return {
    ...real,
    defaultSharedLock: () => {
      const l = real.defaultSharedLock()
      return m.lockFail ? { ...l, take: async () => failing() } : l
    },
    defaultPromoteLock: () => {
      const l = real.defaultPromoteLock()
      return m.lockFail ? { ...l, take: async () => failing() } : l
    }
  }
})
vi.mock('../../../services/hub/docker/stack-settings.js', async (orig) => {
  const real = await orig<typeof import('../../../services/hub/docker/stack-settings.js')>()
  return {
    ...real,
    openStackSecrets: (row: Parameters<typeof real.openStackSecrets>[0]) =>
      m.stackKey ? { ENCRYPTION_KEY: m.stackKey } : real.openStackSecrets(row)
  }
})
vi.mock('../../../services/hub/shared/deployment-client.js', async (orig) => {
  const real = await orig<typeof import('../../../services/hub/shared/deployment-client.js')>()
  return {
    ...real,
    deploymentClient: vi.fn(() => ({ status: m.status, appStatus: m.appStatus })),
    linkedKeyFingerprint: m.linkedFp
  }
})
vi.mock('../../../services/hub/shared/store.js', async (orig) => {
  const real = await orig<typeof import('../../../services/hub/shared/store.js')>()
  return {
    ...real,
    deleteShared: (...a: Parameters<typeof real.deleteShared>) =>
      m.deleteShared ? m.deleteShared(...a) : real.deleteShared(...a)
  }
})

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const migrations = [
  await import('../../../db/migrations/542_hub_tables.js'),
  await import('../../../db/migrations/543_hub_promotions.js'),
  await import('../../../db/migrations/544_hub_databases.js'),
  await import('../../../db/migrations/545_hub_creations.js'),
  await import('../../../db/migrations/546_hub_stack_settings.js'),
  await import('../../../db/migrations/550_hub_oidc.js'),
  await import('../../../db/migrations/551_hub_signins.js'),
  await import('../../../db/migrations/552_hub_shared_deployments.js'),
  await import('../../../db/migrations/553_hub_moves.js')
]
const { hubRoutes } = await import('../../../routes/hub.js')
const { setSharedReapply, sharedStatusKey } = await import('../../../routes/hub-shared.js')
const { logActivity } = await import('../../../services/activity.js')
const { HUB_MASK, openSecret, sealSecret } = await import('../../../services/hub/secrets.js')
const { keyFingerprint } = await import('../../../services/app-key-fingerprint.js')
const { DeploymentLinkError } = await import('../../../services/hub/shared/deployment-client.js')
const { PromotionError, defaultSharedLock, defaultPromoteLock } = await import(
  '../../../services/hub/promote-lock.js'
)
const { _setSightingsDepsForTests, memorySightingsRedis, recordSighting } = await import(
  '../../../services/hub/shared/sightings.js'
)

const HUB_KEY = 'e'.repeat(64)
const APP_KEY = 'ab'.repeat(32)
const OTHER_KEY = 'cd'.repeat(32)
const asAdmin = { 'x-user': 'AAAAAAAA-0000-4000-8000-000000000001', 'x-admin': '1' }
const asUser = { 'x-user': 'BBBBBBBB-0000-4000-8000-000000000002' }
const LINK = 'https://shared-one.internal.example.com'

let app: FastifyInstance
const prev: Record<string, string | undefined> = {}
let cache: Map<string, string>

function fakeRedis() {
  cache = new Map()
  return {
    get: async (k: string) => cache.get(k) ?? null,
    set: async (k: string, v: string) => {
      cache.set(k, v)
      return 'OK'
    },
    del: async (...keys: string[]) => {
      for (const k of keys) cache.delete(k)
      return keys.length
    }
  }
}

beforeAll(async () => {
  for (const k of ['HUB', 'ENCRYPTION_KEY', 'HUB_URL', 'NODE_ENV']) prev[k] = process.env[k]
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = HUB_KEY
  process.env.HUB_URL = 'https://hub.example.com'
  for (const mig of migrations) await mig.up(db)
  app = Fastify()
  app.decorate('redis', fakeRedis() as never)
  await app.register(hubRoutes, { prefix: '/api/hub' })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await db.destroy()
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

beforeEach(async () => {
  vi.clearAllMocks()
  m.deleteShared = null
  m.stackKey = null
  m.lockFail = false
  setSharedReapply(null)
  cache.clear()
  _setSightingsDepsForTests({ redis: memorySightingsRedis() })
  for (const t of [
    'nivaro_hub_apps',
    'nivaro_hub_environments',
    'nivaro_hub_placements',
    'nivaro_hub_drivers',
    'nivaro_hub_shared_deployments',
    'nivaro_hub_shared_deploys',
    'nivaro_hub_stack_settings',
    'nivaro_hub_moves'
  ])
    await db(t).del()
  await db('nivaro_hub_apps').insert({ id: 1, key: 'acme', name: 'Acme' })
  await db('nivaro_hub_drivers').insert({
    id: 3,
    kind: 'docker',
    name: 'swarm',
    config: JSON.stringify({ agent_url: 'https://agent.example.com', dns_mode: 'automatic' })
  })
})

async function create(over: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/hub/shared',
    headers: asAdmin,
    payload: {
      key: 'shared-one',
      name: 'Shared one',
      link_url: LINK,
      extensions: ['efp-ops'],
      ...over
    }
  })
  expect(res.statusCode).toBe(201)
  return res.json().data as {
    row: { id: number; token: string | null }
    token: string
    env_block: string
  }
}

async function placeEnv(sharedId: number, envId = 7, status = 'active') {
  await db('nivaro_hub_placements').insert({
    id: 50 + envId,
    kind: 'shared',
    driver_id: null,
    target: JSON.stringify({ pool_max: 5 }),
    shared_deployment_id: sharedId
  })
  await db('nivaro_hub_environments').insert({
    id: envId,
    app_id: 1,
    key: `env${envId}`,
    base_url: `https://env${envId}.example.com`,
    hostnames: '[]',
    status,
    placement_id: 50 + envId
  })
}

async function dedicatedEnv(
  envId = 9,
  hubToken: string | null = 'hub-Link-Token-0123456789-abcdefghijkl'
) {
  await db('nivaro_hub_environments').insert({
    id: envId,
    app_id: 1,
    key: `env${envId}`,
    base_url: `https://env${envId}.example.com`,
    hostnames: '[]',
    status: 'active',
    hub_token: hubToken ? sealSecret(hubToken) : null
  })
}

/** Every logged activity call, without the request object (which holds the raw body). */
function loggedText(): string {
  return JSON.stringify(
    vi.mocked(logActivity).mock.calls.map(([o]) => {
      const { req: _req, ...rest } = o as Record<string, unknown>
      return rest
    })
  )
}

describe('admin only', () => {
  it('a non-admin gets 403 on every route', async () => {
    const routes: Array<[string, string]> = [
      ['GET', '/api/hub/shared'],
      ['POST', '/api/hub/shared'],
      ['GET', '/api/hub/shared/1'],
      ['PATCH', '/api/hub/shared/1'],
      ['POST', '/api/hub/shared/1/token'],
      ['DELETE', '/api/hub/shared/1'],
      ['GET', '/api/hub/shared/1/status'],
      ['GET', '/api/hub/environments/1/app-key'],
      ['PUT', '/api/hub/environments/1/app-key']
    ]
    for (const [method, url] of routes) {
      const res = await app.inject({
        method: method as 'GET',
        url,
        headers: asUser,
        payload: method === 'GET' || method === 'DELETE' ? undefined : {}
      })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
    }
  })
})

describe('create, read, token', () => {
  it('create shows the token once; a later GET shows the mask', async () => {
    const made = await create()
    expect(made.token.length).toBeGreaterThanOrEqual(43)
    expect(made.row.token).toBe(HUB_MASK)
    const raw = await db('nivaro_hub_shared_deployments').where({ id: made.row.id }).first('token')
    expect(raw.token).not.toContain(made.token)
    expect(openSecret(raw.token)).toBe(made.token)

    const got = await app.inject({
      method: 'GET',
      url: `/api/hub/shared/${made.row.id}`,
      headers: asAdmin
    })
    expect(got.statusCode).toBe(200)
    expect(got.json().data.row.token).toBe(HUB_MASK)
    expect(got.body).not.toContain(made.token)

    const list = await app.inject({ method: 'GET', url: '/api/hub/shared', headers: asAdmin })
    expect(list.json().data[0].token).toBe(HUB_MASK)
    expect(list.body).not.toContain(made.token)
  })

  it('the env block names the key and HUB_URL, and holds the token only on create', async () => {
    const made = await create()
    expect(made.env_block).toContain('HUB_SHARED_DEPLOYMENT=shared-one')
    expect(made.env_block).toContain('HUB_URL=https://hub.example.com')
    expect(made.env_block).toContain(`HUB_DEPLOYMENT_TOKEN=${made.token}`)
    expect(made.env_block).toContain('HUB_SHARED_EXTENSIONS=efp-ops')
    const got = await app.inject({
      method: 'GET',
      url: `/api/hub/shared/${made.row.id}`,
      headers: asAdmin
    })
    const block = got.json().data.env_block as string
    expect(block).toContain('HUB_SHARED_DEPLOYMENT=shared-one')
    expect(block).toContain('HUB_URL=https://hub.example.com')
    expect(block).toContain('HUB_DEPLOYMENT_TOKEN=')
    expect(block).not.toContain(made.token)
  })

  it('a docker deployment has no env block (the Hub renders its stack)', async () => {
    const made = await create({ key: 'shared-two', mode: 'docker', driver_id: 3 })
    expect(made.env_block).toBeNull()
  })

  it('a bad create answers the store code', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/hub/shared',
      headers: asAdmin,
      payload: { key: 'shared-one', name: 'x', link_url: 'http://example.com' }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ statusCode: 400, code: 'BAD_LINK_URL' })
    expect(typeof res.json().message).toBe('string')
    await create()
    const dup = await app.inject({
      method: 'POST',
      url: '/api/hub/shared',
      headers: asAdmin,
      payload: { key: 'shared-one', name: 'again', link_url: LINK }
    })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().code).toBe('KEY_TAKEN')
  })

  it('the list has the apps count and live replicas; the detail has apps placed and sightings', async () => {
    const made = await create()
    await placeEnv(made.row.id, 7)
    await placeEnv(made.row.id, 8, 'maintenance')
    await recordSighting(made.row.id, {
      instance: 'web-1',
      version: '0.3.210',
      etag: `"${'a'.repeat(64)}"`,
      at: new Date().toISOString()
    })
    const list = await app.inject({ method: 'GET', url: '/api/hub/shared', headers: asAdmin })
    expect(list.json().data[0]).toMatchObject({ apps: 2, live_replicas: 1 })
    const got = await app.inject({
      method: 'GET',
      url: `/api/hub/shared/${made.row.id}`,
      headers: asAdmin
    })
    const d = got.json().data
    expect(d.apps).toEqual([
      expect.objectContaining({
        env_id: 7,
        app_key: 'acme',
        tenant_id: 'acme-e7',
        status: 'active',
        pool_max: 5
      }),
      expect.objectContaining({ env_id: 8, tenant_id: 'acme-e8', status: 'maintenance' })
    ])
    expect(d.sightings).toEqual([
      expect.objectContaining({ instance: 'web-1', version: '0.3.210' })
    ])
  })

  it("the placed apps are Task 2's served set: its status map, mid-move envs, pool_max 1-20", async () => {
    const made = await create()
    await placeEnv(made.row.id, 7, 'moving') // dead status → maintenance (T2 WIRE_STATUS)
    await placeEnv(made.row.id, 8, 'weird') // a status the contract has no word for → not served
    await placeEnv(made.row.id, 11)
    await db('nivaro_hub_placements')
      .where({ id: 61 })
      .update({ target: JSON.stringify({ pool_max: 50 }) })
    // env 12 moved out (its placement now elsewhere) but the move has not retired the source
    await db('nivaro_hub_placements').insert({ id: 70, kind: 'gitlab', driver_id: 3, target: '{}' })
    await db('nivaro_hub_environments').insert({
      id: 12,
      app_id: 1,
      key: 'env12',
      base_url: 'https://env12.example.com',
      hostnames: '[]',
      status: 'active',
      placement_id: 70
    })
    await db('nivaro_hub_placements').insert({
      id: 71,
      kind: 'shared',
      driver_id: null,
      target: JSON.stringify({ pool_max: 5 }),
      shared_deployment_id: made.row.id
    })
    await db('nivaro_hub_moves').insert({
      app_id: 1,
      environment_id: 12,
      from_placement_id: 71,
      to_placement_id: 70,
      kind: 'to_dedicated',
      routing: 'automatic',
      status: 'running',
      step: 'files_delta',
      steps: '[]'
    })
    const got = await app.inject({
      method: 'GET',
      url: `/api/hub/shared/${made.row.id}`,
      headers: asAdmin
    })
    const apps = got.json().data.apps as Array<Record<string, unknown>>
    expect(apps.map((a) => [a.tenant_id, a.status, a.pool_max, a.placed_here])).toEqual([
      ['acme-e11', 'active', null, true],
      ['acme-e12', 'maintenance', 5, false],
      ['acme-e7', 'maintenance', 5, true]
    ])
    const list = await app.inject({ method: 'GET', url: '/api/hub/shared', headers: asAdmin })
    expect(list.json().data[0].apps).toBe(3)
  })

  it('sightings that cannot be read show as null, never as no replicas', async () => {
    const made = await create()
    _setSightingsDepsForTests({
      redis: {
        hset: async () => 1,
        hgetall: async () => {
          throw new Error('redis down')
        },
        hdel: async () => 1,
        pexpire: async () => 1,
        set: async () => 'OK'
      }
    })
    const list = await app.inject({ method: 'GET', url: '/api/hub/shared', headers: asAdmin })
    expect(list.json().data[0].live_replicas).toBeNull()
    const got = await app.inject({
      method: 'GET',
      url: `/api/hub/shared/${made.row.id}`,
      headers: asAdmin
    })
    expect(got.json().data.sightings).toBeNull()
    expect(got.json().data.warnings.map((w: { code: string }) => w.code)).toContain(
      'SIGHTINGS_UNAVAILABLE'
    )
  })

  it('rotating answers the new token once (and an env block with it); the old one stays 24 h', async () => {
    const made = await create()
    const res = await app.inject({
      method: 'POST',
      url: `/api/hub/shared/${made.row.id}/token`,
      headers: asAdmin
    })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.token).not.toBe(made.token)
    expect(d.reapply).toBe('manual')
    expect(d.env_block).toContain(`HUB_DEPLOYMENT_TOKEN=${d.token}`)
    expect(new Date(d.previous_token_valid_until).getTime()).toBeGreaterThan(
      Date.now() + 23 * 3600_000
    )
    const got = await app.inject({
      method: 'GET',
      url: `/api/hub/shared/${made.row.id}`,
      headers: asAdmin
    })
    expect(got.body).not.toContain(d.token)
    expect(got.json().data.previous_token_valid_until).toBe(d.previous_token_valid_until)
  })

  it('rotating a docker deployment re-applies its stack through the registered hook (R7)', async () => {
    const made = await create({ key: 'shared-two', mode: 'docker', driver_id: 3 })
    const none = await app.inject({
      method: 'POST',
      url: `/api/hub/shared/${made.row.id}/token`,
      headers: asAdmin
    })
    expect(none.json().data.reapply).toBe('unavailable')
    const hook = vi.fn(async () => ({ started: true }))
    setSharedReapply(hook)
    const res = await app.inject({
      method: 'POST',
      url: `/api/hub/shared/${made.row.id}/token`,
      headers: asAdmin
    })
    expect(res.json().data.reapply).toBe('started')
    expect(res.json().data.env_block).toBeNull()
    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({ id: made.row.id }),
      asAdmin['x-user']
    )
  })
})

describe('update and delete', () => {
  it('PATCH changes the editable fields; mode or key → 400 IMMUTABLE', async () => {
    const made = await create()
    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/hub/shared/${made.row.id}`,
      headers: asAdmin,
      payload: { name: 'Renamed', pool_budget: 80, host_pattern: '*.apps.example.com' }
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().data).toMatchObject({
      name: 'Renamed',
      pool_budget: 80,
      host_pattern: '*.apps.example.com',
      token: HUB_MASK
    })
    const mode = await app.inject({
      method: 'PATCH',
      url: `/api/hub/shared/${made.row.id}`,
      headers: asAdmin,
      payload: { mode: 'docker' }
    })
    expect(mode.statusCode).toBe(400)
    expect(mode.json().code).toBe('IMMUTABLE')
    const key = await app.inject({
      method: 'PATCH',
      url: `/api/hub/shared/${made.row.id}`,
      headers: asAdmin,
      payload: { key: 'other-key' }
    })
    expect(key.json().code).toBe('IMMUTABLE')
    const other = await app.inject({
      method: 'PATCH',
      url: `/api/hub/shared/${made.row.id}`,
      headers: asAdmin,
      payload: { version_pin: '9.9.9' }
    })
    expect(other.statusCode).toBe(400)
    expect(other.json().code).toBe('NOT_EDITABLE')
    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/hub/shared/${made.row.id}`,
      headers: asAdmin,
      payload: { pool_budget: 0 }
    })
    expect(bad.json().code).toBe('BAD_BUDGET')
  })

  it('PATCH on a retired deployment → 409 IMMUTABLE', async () => {
    const made = await create()
    await db('nivaro_hub_shared_deployments')
      .where({ id: made.row.id })
      .update({ status: 'retired' })
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/hub/shared/${made.row.id}`,
      headers: asAdmin,
      payload: { name: 'Again' }
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('IMMUTABLE')
    expect(
      (await db('nivaro_hub_shared_deployments').where({ id: made.row.id }).first()).name
    ).toBe('Shared one')
  })

  it('DELETE with a placement → 409 SHARED_IN_USE; without → deleted', async () => {
    const made = await create()
    await placeEnv(made.row.id, 7)
    const busy = await app.inject({
      method: 'DELETE',
      url: `/api/hub/shared/${made.row.id}`,
      headers: asAdmin
    })
    expect(busy.statusCode).toBe(409)
    expect(busy.json().code).toBe('SHARED_IN_USE')
    await db('nivaro_hub_placements').del()
    const done = await app.inject({
      method: 'DELETE',
      url: `/api/hub/shared/${made.row.id}`,
      headers: asAdmin
    })
    expect(done.statusCode).toBe(200)
    expect(done.json().data.outcome).toBe('deleted')
    expect(
      await db('nivaro_hub_shared_deployments').where({ id: made.row.id }).first()
    ).toBeUndefined()
  })

  it('DELETE of a deployment that ran → retired (history kept)', async () => {
    const made = await create()
    await db('nivaro_hub_shared_deploys').insert({
      shared_deployment_id: made.row.id,
      kind: 'observed',
      version: '0.3.210',
      status: 'success'
    })
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/hub/shared/${made.row.id}`,
      headers: asAdmin
    })
    expect(res.json().data.outcome).toBe('retired')
    expect(
      (await db('nivaro_hub_shared_deployments').where({ id: made.row.id }).first()).status
    ).toBe('retired')
  })

  it('DELETE when Redis cannot take the lock → 503 LOCK_UNAVAILABLE', async () => {
    const made = await create()
    m.deleteShared = async () => {
      throw new PromotionError('LOCK_UNAVAILABLE', 'The Hub cannot reach Redis', 503)
    }
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/hub/shared/${made.row.id}`,
      headers: asAdmin
    })
    expect(res.statusCode).toBe(503)
    expect(res.json().code).toBe('LOCK_UNAVAILABLE')
  })

  it('an unknown id → 404', async () => {
    for (const [method, url] of [
      ['GET', '/api/hub/shared/999'],
      ['PATCH', '/api/hub/shared/999'],
      ['DELETE', '/api/hub/shared/999'],
      ['POST', '/api/hub/shared/999/token'],
      ['GET', '/api/hub/shared/999/status']
    ]) {
      const res = await app.inject({
        method: method as 'GET',
        url,
        headers: asAdmin,
        payload: method === 'PATCH' ? {} : undefined
      })
      expect(res.statusCode, `${method} ${url}`).toBe(404)
    }
  })
})

describe('status', () => {
  const STATUS = {
    version: '0.3.210',
    instance: 'web-1',
    registry: { count: 1, loaded_at: null, etag: null, stale: false, dropped: [] },
    apps: [],
    extensions: [],
    oidc: null,
    process: {}
  }

  it('answers the link status and caches it 30 s in nvr:hub:shared-status:<id>', async () => {
    const made = await create()
    m.status.mockResolvedValue(STATUS)
    const a = await app.inject({
      method: 'GET',
      url: `/api/hub/shared/${made.row.id}/status`,
      headers: asAdmin
    })
    expect(a.json().data).toMatchObject({ state: 'ok', version: '0.3.210' })
    await new Promise((r) => setTimeout(r, 10))
    expect(cache.has(sharedStatusKey(made.row.id))).toBe(true)
    const b = await app.inject({
      method: 'GET',
      url: `/api/hub/shared/${made.row.id}/status`,
      headers: asAdmin
    })
    expect(b.json().data.version).toBe('0.3.210')
    expect(m.status).toHaveBeenCalledTimes(1)
    await app.inject({
      method: 'GET',
      url: `/api/hub/shared/${made.row.id}/status?fresh=1`,
      headers: asAdmin
    })
    expect(m.status).toHaveBeenCalledTimes(2)
  })

  it('a link failure answers {state: unreachable, code}', async () => {
    const made = await create()
    m.status.mockRejectedValue(new DeploymentLinkError('LINK_REFUSED', 401))
    const res = await app.inject({
      method: 'GET',
      url: `/api/hub/shared/${made.row.id}/status`,
      headers: asAdmin
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toMatchObject({ state: 'unreachable', code: 'LINK_REFUSED' })
  })
})

describe('app key', () => {
  it('64 hex → {fp}; the env row holds it sealed; GET shows mask + fp, never the key', async () => {
    await dedicatedEnv(9)
    m.linkedFp.mockResolvedValue({ ok: true, fp: keyFingerprint(APP_KEY) })
    const res = await app.inject({
      method: 'PUT',
      url: '/api/hub/environments/9/app-key',
      headers: asAdmin,
      payload: { key: APP_KEY }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({
      fp: keyFingerprint(APP_KEY),
      changed: true,
      verified: 'hub-link'
    })
    const row = await db('nivaro_hub_environments').where({ id: 9 }).first()
    expect(row.encryption_key).not.toContain(APP_KEY)
    expect(openSecret(row.encryption_key)).toBe(APP_KEY)
    expect(row.encryption_key_fp).toBe(keyFingerprint(APP_KEY))
    const got = await app.inject({
      method: 'GET',
      url: '/api/hub/environments/9/app-key',
      headers: asAdmin
    })
    expect(got.json().data).toEqual({
      known: true,
      key: HUB_MASK,
      fp: keyFingerprint(APP_KEY),
      source: 'entry'
    })
    expect(got.body).not.toContain(APP_KEY)
  })

  it('not 64 hex → 400 BAD_KEY', async () => {
    await dedicatedEnv(9)
    for (const key of ['abc', 'zz'.repeat(32), '', 42]) {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/hub/environments/9/app-key',
        headers: asAdmin,
        payload: { key }
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().code).toBe('BAD_KEY')
    }
    expect(m.linkedFp).not.toHaveBeenCalled()
  })

  it('the hub link reporting another fingerprint → 409 APP_KEY_MISMATCH, nothing stored', async () => {
    await dedicatedEnv(9)
    m.linkedFp.mockResolvedValue({ ok: true, fp: keyFingerprint(OTHER_KEY) })
    const res = await app.inject({
      method: 'PUT',
      url: '/api/hub/environments/9/app-key',
      headers: asAdmin,
      payload: { key: APP_KEY }
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('APP_KEY_MISMATCH')
    expect(res.body).not.toContain(APP_KEY)
    expect((await db('nivaro_hub_environments').where({ id: 9 }).first()).encryption_key).toBeNull()
  })

  it('a shared placement checks the deployment link app status', async () => {
    const made = await create()
    await placeEnv(made.row.id, 7)
    m.appStatus.mockResolvedValue({ key_fp: keyFingerprint(OTHER_KEY) })
    const res = await app.inject({
      method: 'PUT',
      url: '/api/hub/environments/7/app-key',
      headers: asAdmin,
      payload: { key: APP_KEY }
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('APP_KEY_MISMATCH')
    expect(m.appStatus).toHaveBeenCalledWith('acme-e7')
  })

  it('the Docker stack settings holding another key → 409 APP_KEY_MISMATCH', async () => {
    await dedicatedEnv(9, null)
    m.stackKey = OTHER_KEY
    const res = await app.inject({
      method: 'PUT',
      url: '/api/hub/environments/9/app-key',
      headers: asAdmin,
      payload: { key: APP_KEY }
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('APP_KEY_MISMATCH')
    expect(res.json().message).toMatch(/stack settings/)
    // The same key as the stack's → the Hub already holds it: nothing to change.
    m.stackKey = APP_KEY
    const same = await app.inject({
      method: 'PUT',
      url: '/api/hub/environments/9/app-key',
      headers: asAdmin,
      payload: { key: APP_KEY }
    })
    expect(same.statusCode).toBe(200)
    expect(same.json().data).toEqual({ fp: keyFingerprint(APP_KEY), changed: false })
  })

  it('a stack-settings key the Hub knows reads as known, source stack', async () => {
    await dedicatedEnv(9, null)
    m.stackKey = APP_KEY
    const got = await app.inject({
      method: 'GET',
      url: '/api/hub/environments/9/app-key',
      headers: asAdmin
    })
    expect(got.json().data).toEqual({
      known: true,
      key: HUB_MASK,
      fp: keyFingerprint(APP_KEY),
      source: 'stack'
    })
  })

  it('a link that cannot tell → stored, unverified', async () => {
    await dedicatedEnv(9)
    m.linkedFp.mockResolvedValue({ ok: false, code: 'HUB_LINK_MISSING' })
    const res = await app.inject({
      method: 'PUT',
      url: '/api/hub/environments/9/app-key',
      headers: asAdmin,
      payload: { key: APP_KEY }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({
      fp: keyFingerprint(APP_KEY),
      changed: true,
      verified: null,
      unverified_code: 'HUB_LINK_MISSING'
    })
  })

  async function putKey(envId: number, key: string) {
    return app.inject({
      method: 'PUT',
      url: `/api/hub/environments/${envId}/app-key`,
      headers: asAdmin,
      payload: { key }
    })
  }
  async function storedEntry(envId: number) {
    const row = await db('nivaro_hub_environments').where({ id: envId }).first()
    return { key: row.encryption_key ? openSecret(row.encryption_key) : null, row }
  }

  it('the same key re-sent → 200 no-op, nothing written, nothing asked', async () => {
    await dedicatedEnv(9)
    m.linkedFp.mockResolvedValue({ ok: true, fp: keyFingerprint(APP_KEY) })
    expect((await putKey(9, APP_KEY)).statusCode).toBe(200)
    const before = await storedEntry(9)
    m.linkedFp.mockClear()
    const again = await putKey(9, APP_KEY.toUpperCase())
    expect(again.statusCode).toBe(200)
    expect(again.json().data).toEqual({ fp: keyFingerprint(APP_KEY), changed: false })
    expect(m.linkedFp).not.toHaveBeenCalled()
    expect((await storedEntry(9)).row.encryption_key).toBe(before.row.encryption_key)
  })

  it('replacing a stored key with a positive match from the app → saved', async () => {
    await dedicatedEnv(9)
    m.linkedFp.mockResolvedValue({ ok: true, fp: keyFingerprint(APP_KEY) })
    await putKey(9, APP_KEY)
    m.linkedFp.mockResolvedValue({ ok: true, fp: keyFingerprint(OTHER_KEY) })
    const res = await putKey(9, OTHER_KEY)
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({
      fp: keyFingerprint(OTHER_KEY),
      changed: true,
      verified: 'hub-link'
    })
    expect((await storedEntry(9)).key).toBe(OTHER_KEY)
  })

  it('replacing a stored key the app cannot confirm → 409 APP_KEY_UNVERIFIED, nothing saved', async () => {
    await dedicatedEnv(9)
    m.linkedFp.mockResolvedValue({ ok: true, fp: keyFingerprint(APP_KEY) })
    await putKey(9, APP_KEY)
    for (const answer of [
      { ok: false, code: 'UNREACHABLE' },
      { ok: false, code: 'HUB_LINK_MISSING' },
      { ok: true, fp: null }
    ]) {
      m.linkedFp.mockResolvedValue(answer)
      const res = await putKey(9, OTHER_KEY)
      expect(res.statusCode).toBe(409)
      expect(res.json().code).toBe('APP_KEY_UNVERIFIED')
      expect(res.body).not.toContain(OTHER_KEY)
      expect((await storedEntry(9)).key).toBe(APP_KEY)
    }
    // The app still reporting the old key → mismatch.
    m.linkedFp.mockResolvedValue({ ok: true, fp: keyFingerprint(APP_KEY) })
    expect((await putKey(9, OTHER_KEY)).json().code).toBe('APP_KEY_MISMATCH')
    expect((await storedEntry(9)).key).toBe(APP_KEY)
  })

  it('a dedicated env with no link and a stored key → 409 APP_KEY_UNVERIFIED', async () => {
    await dedicatedEnv(9, null)
    await db('nivaro_hub_environments')
      .where({ id: 9 })
      .update({ encryption_key: sealSecret(APP_KEY), encryption_key_fp: keyFingerprint(APP_KEY) })
    const res = await putKey(9, OTHER_KEY)
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('APP_KEY_UNVERIFIED')
  })

  it('a shared placement with a stored key → any different key 409 APP_KEY_IMMUTABLE', async () => {
    const made = await create()
    await placeEnv(made.row.id, 7)
    await db('nivaro_hub_environments')
      .where({ id: 7 })
      .update({ encryption_key: sealSecret(APP_KEY), encryption_key_fp: keyFingerprint(APP_KEY) })
    for (const st of [
      () => m.appStatus.mockRejectedValue(new DeploymentLinkError('LINK_UNREACHABLE')),
      () => m.appStatus.mockResolvedValue({ key_fp: keyFingerprint(OTHER_KEY) })
    ]) {
      st()
      const res = await putKey(7, OTHER_KEY)
      expect(res.statusCode).toBe(409)
      expect(res.json().code).toBe('APP_KEY_IMMUTABLE')
      expect((await storedEntry(7)).key).toBe(APP_KEY)
    }
    expect((await putKey(7, APP_KEY)).json().data).toEqual({
      fp: keyFingerprint(APP_KEY),
      changed: false
    })
  })

  it('a shared placement with no stored key and the link down → stored, unverified', async () => {
    const made = await create()
    await placeEnv(made.row.id, 7)
    m.appStatus.mockRejectedValue(new DeploymentLinkError('LINK_UNREACHABLE'))
    const res = await putKey(7, APP_KEY)
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({
      fp: keyFingerprint(APP_KEY),
      changed: true,
      verified: null,
      unverified_code: 'LINK_UNREACHABLE'
    })
    expect((await storedEntry(7)).key).toBe(APP_KEY)
  })

  it('runs under the shared lock (shared placement) or the environment lock (dedicated)', async () => {
    const made = await create()
    await placeEnv(made.row.id, 7)
    m.appStatus.mockResolvedValue({ key_fp: null })
    const lock = defaultSharedLock()
    const held = await lock.take(made.row.id, 'move')
    const busy = await putKey(7, APP_KEY)
    expect(busy.statusCode).toBe(409)
    expect(busy.json().code).toBe('SHARED_BUSY')
    expect((await storedEntry(7)).key).toBeNull()
    await lock.release(made.row.id, held as string)
    expect((await putKey(7, APP_KEY)).statusCode).toBe(200)

    await dedicatedEnv(9)
    m.linkedFp.mockResolvedValue({ ok: true, fp: null })
    const envLock = defaultPromoteLock()
    const t = await envLock.take(9, 'promotion')
    const blocked = await putKey(9, APP_KEY)
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().code).toBe('PROMOTION_RUNNING')
    await envLock.release(9, t as string)
    expect((await putKey(9, APP_KEY)).statusCode).toBe(200)
  })

  it('a lock that cannot be taken (Redis down) → 503 LOCK_UNAVAILABLE, nothing saved', async () => {
    await dedicatedEnv(9)
    m.linkedFp.mockResolvedValue({ ok: true, fp: keyFingerprint(APP_KEY) })
    m.lockFail = true
    const res = await putKey(9, APP_KEY)
    expect(res.statusCode).toBe(503)
    expect(res.json().code).toBe('LOCK_UNAVAILABLE')
    expect((await storedEntry(9)).key).toBeNull()
  })

  it('an entry that no longer opens is named, never hidden behind the stack key', async () => {
    await dedicatedEnv(9, null)
    await db('nivaro_hub_environments')
      .where({ id: 9 })
      .update({ encryption_key: 'not-a-sealed-value', encryption_key_fp: keyFingerprint(APP_KEY) })
    const unknown = await app.inject({
      method: 'GET',
      url: '/api/hub/environments/9/app-key',
      headers: asAdmin
    })
    expect(unknown.json().data).toMatchObject({
      known: false,
      code: 'APP_KEY_UNKNOWN',
      entry_unreadable: true
    })
    m.stackKey = OTHER_KEY
    const stack = await app.inject({
      method: 'GET',
      url: '/api/hub/environments/9/app-key',
      headers: asAdmin
    })
    expect(stack.json().data).toMatchObject({
      known: true,
      source: 'stack',
      entry_unreadable: true
    })
  })

  it('an unknown key answers APP_KEY_UNKNOWN with the plain sentence', async () => {
    await dedicatedEnv(9)
    const res = await app.inject({
      method: 'GET',
      url: '/api/hub/environments/9/app-key',
      headers: asAdmin
    })
    expect(res.json().data).toMatchObject({ known: false, key: null, code: 'APP_KEY_UNKNOWN' })
    expect(res.json().data.message).toMatch(/GitLab/)
    const missing = await app.inject({
      method: 'GET',
      url: '/api/hub/environments/999/app-key',
      headers: asAdmin
    })
    expect(missing.statusCode).toBe(404)
  })
})

describe('activity', () => {
  it('every write is logged, and no activity row holds the token or the key', async () => {
    const made = await create()
    const rot = await app.inject({
      method: 'POST',
      url: `/api/hub/shared/${made.row.id}/token`,
      headers: asAdmin
    })
    await app.inject({
      method: 'PATCH',
      url: `/api/hub/shared/${made.row.id}`,
      headers: asAdmin,
      payload: { name: 'X' }
    })
    await dedicatedEnv(9)
    m.linkedFp.mockResolvedValue({ ok: true, fp: null })
    await app.inject({
      method: 'PUT',
      url: '/api/hub/environments/9/app-key',
      headers: asAdmin,
      payload: { key: APP_KEY }
    })
    await app.inject({ method: 'DELETE', url: `/api/hub/shared/${made.row.id}`, headers: asAdmin })
    const actions = vi.mocked(logActivity).mock.calls.map(([o]) => (o as { action: string }).action)
    expect(actions).toEqual([
      'hub-shared-create',
      'hub-shared-token',
      'hub-shared-update',
      'hub-app-key',
      'hub-shared-delete'
    ])
    const keyCall = vi
      .mocked(logActivity)
      .mock.calls.map(([o]) => o as { action: string; comment?: string })
      .find((o) => o.action === 'hub-app-key')
    expect(keyCall?.comment).toBe(`fp=${keyFingerprint(APP_KEY)} verified=none:NO_KEY_FP`)
    const text = loggedText()
    expect(text).not.toContain(made.token)
    expect(text).not.toContain(rot.json().data.token)
    expect(text).not.toContain(APP_KEY)
  })
})
