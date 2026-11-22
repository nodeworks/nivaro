import Fastify, {
  type FastifyInstance,
  type InjectOptions,
  type LightMyRequestResponse
} from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub (phase 1): GitLab driver and dedicated placement routes. Real SQLite with the
// migration 542 tables; drivers' tokens are sealed at rest, masked on every answer and never
// written to an activity row.

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
const { up: up543 } = await import('../../../db/migrations/543_hub_promotions.js')
// 551 adds hub_token_lookup, which every hub token write fills (phase 7).
const { up: up551 } = await import('../../../db/migrations/551_hub_signins.js')
const { logActivity } = await import('../../../services/activity.js')
const { hubRoutes } = await import('../../../routes/hub.js')

const ADMIN = 'AAAAAAAA-0000-4000-8000-000000000001'
const OWNER = 'BBBBBBBB-0000-4000-8000-000000000002'
const KEY = 'a'.repeat(64)
const MASK = '••••••'
const TOKEN = 'glpat-plain-token-value'

const asAdmin = { 'x-user': ADMIN, 'x-admin': '1' }
const asOwner = { 'x-user': OWNER }

const CONFIG = {
  api: 'https://gitlab.example.com/api/v4',
  project: 'ops/efp-deploy',
  branch: 'production',
  pin_file: '.docker/nivaro-version',
  deploy_job: 'deploy_production'
}

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
  await up551(db)
  await up543(db)
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
  await db('nivaro_hub_apps').del()
  await db('nivaro_hub_placements').del()
  await db('nivaro_hub_drivers').del()
  vi.mocked(logActivity).mockClear()
  fakeRedis.del.mockClear()
})

const req = (
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  headers: Record<string, string>,
  payload?: unknown
): Promise<LightMyRequestResponse> => {
  const opts: InjectOptions = { method, url, headers }
  if (payload !== undefined) opts.payload = payload as InjectOptions['payload']
  return app.inject(opts)
}

async function createDriver(extra: Record<string, unknown> = {}) {
  const r = await req('POST', '/hub/drivers', asAdmin, {
    kind: 'gitlab',
    name: 'EFP GitLab',
    config: CONFIG,
    secret: TOKEN,
    ...extra
  })
  expect(r.statusCode).toBe(200)
  return r.json().data as { id: number; secret: string | null }
}

async function createPlacement(driverId: number, target: Record<string, unknown> = {}) {
  const r = await req('POST', '/hub/placements', asAdmin, {
    kind: 'dedicated',
    driver_id: driverId,
    target
  })
  expect(r.statusCode).toBe(200)
  return r.json().data.id as number
}

const idOf = (r: Array<{ id: number } | number>) =>
  r.map((x) => (typeof x === 'object' ? x.id : x))[0] as number

async function createHubApp(key = 'efp') {
  const found = await db('nivaro_hub_apps').where({ key }).first('id')
  if (found) return Number(found.id)
  return idOf(
    await db('nivaro_hub_apps')
      .insert({ key, name: key.toUpperCase(), signin_mode: 'direct', extensions: '[]' })
      .returning('id')
  )
}

/** An environment row naming `placementId` (straight to the table: no route validation). */
async function createEnv(placementId: number | null, key = 'prod') {
  const appId = await createHubApp()
  return idOf(
    await db('nivaro_hub_environments')
      .insert({
        app_id: appId,
        key,
        base_url: `https://${key}.example.com`,
        hostnames: '[]',
        status: 'active',
        position: 0,
        placement_id: placementId
      })
      .returning('id')
  )
}

// logActivity stores only ip + user agent from `req`; everything else it is given is checked.
const activityText = () =>
  JSON.stringify(
    vi.mocked(logActivity).mock.calls.map(([opts]) => ({ ...(opts as object), req: undefined }))
  )

describe('hub drivers', () => {
  it('POST stores the token sealed and answers it masked; GET lists it masked', async () => {
    const d = await createDriver()
    expect(d).toMatchObject({ kind: 'gitlab', name: 'EFP GitLab', config: CONFIG, secret: MASK })
    const stored = await db('nivaro_hub_drivers').where({ id: d.id }).first()
    expect(stored.secret).toMatch(/^enc:v1:/)
    expect(stored.secret).not.toContain(TOKEN)

    const list = await req('GET', '/hub/drivers', asAdmin)
    expect(list.statusCode).toBe(200)
    expect(list.json().data).toEqual([
      { id: d.id, kind: 'gitlab', name: 'EFP GitLab', config: CONFIG, secret: MASK }
    ])
    expect(list.body).not.toContain(TOKEN)
    expect(list.body).not.toContain('enc:v1:')
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'create',
        collection: 'nivaro_hub_drivers',
        item: String(d.id)
      })
    )
    expect(activityText()).not.toContain(TOKEN)
  })

  it('PATCH with the mask keeps the stored token', async () => {
    const d = await createDriver()
    const before = (await db('nivaro_hub_drivers').where({ id: d.id }).first()).secret
    const r = await req('PATCH', `/hub/drivers/${d.id}`, asAdmin, {
      name: 'Renamed',
      secret: MASK
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toMatchObject({ name: 'Renamed', secret: MASK, config: CONFIG })
    expect((await db('nivaro_hub_drivers').where({ id: d.id }).first()).secret).toBe(before)

    // Absent also keeps it.
    const r2 = await req('PATCH', `/hub/drivers/${d.id}`, asAdmin, {
      config: { deploy_job: 'deploy_prod' }
    })
    expect(r2.statusCode).toBe(200)
    expect(r2.json().data.config.deploy_job).toBe('deploy_prod')
    expect((await db('nivaro_hub_drivers').where({ id: d.id }).first()).secret).toBe(before)
    expect(activityText()).not.toContain(TOKEN)
  })

  it('PATCH changing the GitLab address with the mask → 400 SECRET_REQUIRED, nothing stored', async () => {
    const d = await createDriver()
    const r = await req('PATCH', `/hub/drivers/${d.id}`, asAdmin, {
      config: { api: 'https://evil.example.net/api/v4' },
      secret: MASK
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().code).toBe('SECRET_REQUIRED')
    const stored = await db('nivaro_hub_drivers').where({ id: d.id }).first()
    expect(JSON.parse(stored.config).api).toBe(CONFIG.api)

    const fresh = await req('PATCH', `/hub/drivers/${d.id}`, asAdmin, {
      config: { api: 'https://gitlab2.example.com/api/v4' },
      secret: 'glpat-new'
    })
    expect(fresh.statusCode).toBe(200)
    expect(fresh.json().data.secret).toBe(MASK)
  })

  it('validation failures → 400 with the validator code; unknown id → 404', async () => {
    const bad = await req('POST', '/hub/drivers', asAdmin, {
      kind: 'github',
      name: 'x',
      config: CONFIG
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('BAD_KIND')
    const badSecret = await req('POST', '/hub/drivers', asAdmin, {
      kind: 'gitlab',
      name: 'x',
      config: CONFIG,
      secret: 42
    })
    expect(badSecret.statusCode).toBe(400)
    expect(badSecret.json().code).toBe('BAD_SECRET')
    expect(await db('nivaro_hub_drivers').count({ n: '*' })).toEqual([{ n: 0 }])
    expect((await req('PATCH', '/hub/drivers/999', asAdmin, { name: 'x' })).statusCode).toBe(404)
    expect((await req('PATCH', '/hub/drivers/abc', asAdmin, { name: 'x' })).statusCode).toBe(404)
  })

  it('no encryption key → 400 HUB_NEEDS_ENCRYPTION_KEY and nothing stored', async () => {
    delete process.env.ENCRYPTION_KEY
    const r = await req('POST', '/hub/drivers', asAdmin, {
      kind: 'gitlab',
      name: 'x',
      config: CONFIG,
      secret: TOKEN
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().code).toBe('HUB_NEEDS_ENCRYPTION_KEY')
    expect(await db('nivaro_hub_drivers').count({ n: '*' })).toEqual([{ n: 0 }])
  })

  it('DELETE in use → 409 IN_USE; free → 204; missing → 404', async () => {
    const d = await createDriver()
    const placementId = await createPlacement(d.id)
    const envId = await createEnv(placementId)
    const inUse = await req('DELETE', `/hub/drivers/${d.id}`, asAdmin)
    expect(inUse.statusCode).toBe(409)
    expect(inUse.json().code).toBe('IN_USE')
    await db('nivaro_hub_environments').where({ id: envId }).update({ placement_id: null })
    const gone = await req('DELETE', `/hub/drivers/${d.id}`, asAdmin)
    expect(gone.statusCode).toBe(204)
    expect(await db('nivaro_hub_drivers').count({ n: '*' })).toEqual([{ n: 0 }])
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'delete', collection: 'nivaro_hub_drivers' })
    )
    const missing = await req('DELETE', `/hub/drivers/${d.id}`, asAdmin)
    expect(missing.statusCode).toBe(404)
    expect(missing.json().code).toBe('NOT_FOUND')
  })

  it('an environment with a driver, deleted → its placement goes; the driver then deletes (204)', async () => {
    const d = await createDriver()
    const placementId = await createPlacement(d.id)
    const appId = await createHubApp()
    const env = await req('POST', `/hub/apps/${appId}/environments`, asAdmin, {
      key: 'prod',
      base_url: 'https://efp.example.com',
      placement_id: placementId
    })
    expect(env.statusCode).toBe(200)
    expect((await req('DELETE', `/hub/drivers/${d.id}`, asAdmin)).statusCode).toBe(409)
    const del = await req('DELETE', `/hub/environments/${env.json().data.id}`, asAdmin)
    expect(del.statusCode).toBe(200)
    expect(await db('nivaro_hub_placements').where({ id: placementId }).first()).toBeUndefined()
    expect((await req('DELETE', `/hub/drivers/${d.id}`, asAdmin)).statusCode).toBe(204)
  })

  it('a placement no environment names never blocks a driver delete, and goes with it', async () => {
    const d = await createDriver()
    await createPlacement(d.id)
    await createPlacement(d.id)
    const r = await req('DELETE', `/hub/drivers/${d.id}`, asAdmin)
    expect(r.statusCode).toBe(204)
    expect(await db('nivaro_hub_placements').count({ n: '*' })).toEqual([{ n: 0 }])
  })

  it('an environment moved off its placement (PATCH) releases it', async () => {
    const d = await createDriver()
    const placementId = await createPlacement(d.id)
    const envId = await createEnv(placementId)
    const r = await req('PATCH', `/hub/environments/${envId}`, asAdmin, { placement_id: null })
    expect(r.statusCode).toBe(200)
    expect(await db('nivaro_hub_placements').where({ id: placementId }).first()).toBeUndefined()
    expect((await req('DELETE', `/hub/drivers/${d.id}`, asAdmin)).statusCode).toBe(204)
  })

  it('an environment delete keeps a placement another environment still names', async () => {
    const d = await createDriver()
    const placementId = await createPlacement(d.id)
    const a = await createEnv(placementId, 'a1')
    await createEnv(placementId, 'b1')
    expect((await req('DELETE', `/hub/environments/${a}`, asAdmin)).statusCode).toBe(200)
    expect(await db('nivaro_hub_placements').where({ id: placementId }).first()).toBeTruthy()
  })

  it('non-admins are refused (403)', async () => {
    const d = await createDriver()
    for (const [method, url] of [
      ['GET', '/hub/drivers'],
      ['POST', '/hub/drivers'],
      ['PATCH', `/hub/drivers/${d.id}`],
      ['DELETE', `/hub/drivers/${d.id}`],
      ['POST', '/hub/placements'],
      ['PATCH', '/hub/placements/1'],
      ['GET', '/hub/placements/1']
    ] as const)
      expect([
        method,
        url,
        (await req(method, url, asOwner, method === 'GET' ? undefined : {})).statusCode
      ]).toEqual([method, url, 403])
  })
})

describe('hub placements', () => {
  it('POST → {data:{id}}; GET reads it back; PATCH changes the branch', async () => {
    const d = await createDriver()
    const r = await req('POST', '/hub/placements', asAdmin, {
      kind: 'dedicated',
      driver_id: d.id,
      target: { branch: 'staging' }
    })
    expect(r.statusCode).toBe(200)
    const id = r.json().data.id
    expect(typeof id).toBe('number')
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'create',
        collection: 'nivaro_hub_placements',
        item: String(id)
      })
    )

    const got = await req('GET', `/hub/placements/${id}`, asAdmin)
    expect(got.statusCode).toBe(200)
    expect(got.json().data).toEqual({
      id,
      kind: 'dedicated',
      driver_id: d.id,
      target: { branch: 'staging' }
    })

    const patched = await req('PATCH', `/hub/placements/${id}`, asAdmin, {
      target: { branch: 'production' }
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().data).toEqual({
      id,
      kind: 'dedicated',
      driver_id: d.id,
      target: { branch: 'production' }
    })
  })

  it('unknown driver or bad input → 400; unknown placement → 404', async () => {
    const noDriver = await req('POST', '/hub/placements', asAdmin, {
      kind: 'dedicated',
      driver_id: 999
    })
    expect(noDriver.statusCode).toBe(400)
    expect(noDriver.json().code).toBe('BAD_DRIVER')
    const badKind = await req('POST', '/hub/placements', asAdmin, { kind: 'shared', driver_id: 1 })
    expect(badKind.statusCode).toBe(400)
    expect(badKind.json().code).toBe('BAD_KIND')
    expect(await db('nivaro_hub_placements').count({ n: '*' })).toEqual([{ n: 0 }])
    expect((await req('GET', '/hub/placements/999', asAdmin)).statusCode).toBe(404)
    expect(
      (await req('PATCH', '/hub/placements/999', asAdmin, { target: { branch: 'x' } })).statusCode
    ).toBe(404)
    const d = await createDriver()
    const p = await req('POST', '/hub/placements', asAdmin, { kind: 'dedicated', driver_id: d.id })
    const toMissing = await req('PATCH', `/hub/placements/${p.json().data.id}`, asAdmin, {
      driver_id: 999
    })
    expect(toMissing.statusCode).toBe(400)
    expect(toMissing.json().code).toBe('BAD_DRIVER')
  })
})

describe('deploy history cache', () => {
  const deployKeysDropped = () => fakeRedis.del.mock.calls.flat().map(String)

  it('a placement PATCH forgets the deploy history of the environment naming it', async () => {
    const d = await createDriver()
    const id = await createPlacement(d.id)
    const envId = await createEnv(id)
    const r = await req('PATCH', `/hub/placements/${id}`, asAdmin, { target: { branch: 'x' } })
    expect(r.statusCode).toBe(200)
    expect(deployKeysDropped()).toContain(`nvr:hub:deploys:${envId}:20`)
  })

  it('a driver PATCH forgets the deploy history of every environment it deploys', async () => {
    const d = await createDriver()
    const envId = await createEnv(await createPlacement(d.id))
    const r = await req('PATCH', `/hub/drivers/${d.id}`, asAdmin, { name: 'Renamed' })
    expect(r.statusCode).toBe(200)
    expect(deployKeysDropped()).toContain(`nvr:hub:deploys:${envId}:20`)
  })

  it('a driver no environment uses forgets nothing', async () => {
    const d = await createDriver()
    await req('PATCH', `/hub/drivers/${d.id}`, asAdmin, { name: 'Renamed' })
    expect(fakeRedis.del).not.toHaveBeenCalled()
  })
})

describe('placement delete', () => {
  it('DELETE a free placement → 204 and an activity row; missing → 404', async () => {
    const d = await createDriver()
    const id = await createPlacement(d.id)
    const r = await req('DELETE', `/hub/placements/${id}`, asAdmin)
    expect(r.statusCode).toBe(204)
    expect(await db('nivaro_hub_placements').count({ n: '*' })).toEqual([{ n: 0 }])
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'delete',
        collection: 'nivaro_hub_placements',
        item: String(id)
      })
    )
    const again = await req('DELETE', `/hub/placements/${id}`, asAdmin)
    expect(again.statusCode).toBe(404)
    expect(again.json().code).toBe('NOT_FOUND')
  })

  it('a placement an environment names → 409 IN_USE and it stays', async () => {
    const d = await createDriver()
    const id = await createPlacement(d.id)
    await createEnv(id)
    const r = await req('DELETE', `/hub/placements/${id}`, asAdmin)
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('IN_USE')
    expect(await db('nivaro_hub_placements').where({ id }).first()).toBeTruthy()
  })

  it('non-admins are refused (403)', async () => {
    const d = await createDriver()
    const id = await createPlacement(d.id)
    expect((await req('DELETE', `/hub/placements/${id}`, asOwner)).statusCode).toBe(403)
  })
})

describe('hub mode off', () => {
  it('driver, placement, status and deploy routes answer 404', async () => {
    const saved = process.env.HUB
    delete process.env.HUB
    const off = Fastify()
    await off.register(hubRoutes, { prefix: '/hub' })
    await off.ready()
    process.env.HUB = saved
    const calls: Array<['GET' | 'POST' | 'PATCH' | 'DELETE', string]> = [
      ['GET', '/hub/drivers'],
      ['POST', '/hub/drivers'],
      ['PATCH', '/hub/drivers/1'],
      ['DELETE', '/hub/drivers/1'],
      ['POST', '/hub/placements'],
      ['PATCH', '/hub/placements/1'],
      ['GET', '/hub/placements/1'],
      ['GET', '/hub/environments/1/status'],
      ['GET', '/hub/environments/1/deploys'],
      ['GET', '/hub/apps/1/status']
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
