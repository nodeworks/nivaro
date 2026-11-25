import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub placement routes (ideas 48–50) on a real SQLite with the hub tables (542 … 580): regions and
// hosts, placing an unplaced environment, the chargeback report + CSV, and read-only federation
// with another Hub through an injected fetch (no network). Admin only, every write logged.

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
const m = vi.hoisted(() => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/activity.js', () => ({ logActivity: m.logActivity }))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const migrations = [
  await import('../../../db/migrations/542_hub_tables.js'),
  await import('../../../db/migrations/552_hub_shared_deployments.js'),
  await import('../../../db/migrations/553_hub_moves.js'),
  await import('../../../db/migrations/567_hub_capacity.js'),
  await import('../../../db/migrations/569_hub_data.js'),
  await import('../../../db/migrations/580_hub_placement.js')
]
const { hubPlacementRoutes } = await import('../../../routes/hub-placement.js')
const { openSecret } = await import('../../../services/hub/secrets.js')
const fed = await import('../../../services/hub/placement/federation.js')

const ADMIN = { 'x-user': 'aaaaaaaa-0000-4000-8000-000000000001', 'x-admin': '1' }
const OWNER = { 'x-user': 'aaaaaaaa-0000-4000-8000-000000000002' }
const KEY = `nvk_${'k'.repeat(40)}`
const saved = { KEY: process.env.ENCRYPTION_KEY }

/** The other Hub, as an injected fetch: answers per path; records every call. */
const peer = {
  calls: [] as Array<{ url: string; auth: string | undefined }>,
  self: { auth: 'api_key', key_scope: 'read', product: 'Nivaro Hub', version: '0.3.215' } as Record<
    string,
    unknown
  >,
  fleet: { newest: '0.3.215', rows: [] as unknown[] } as Record<string, unknown>,
  down: false,
  status: 200
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const fakeFetch = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
  peer.calls.push({ url, auth: init.headers.authorization })
  if (peer.down) throw new Error('connect ECONNREFUSED')
  if (peer.status !== 200) return json(peer.status, { code: 'HUB_SCOPE_MISSING' })
  if (url.endsWith('/api/hub/federation/self')) return json(200, { data: peer.self })
  if (url.endsWith('/api/hub/fleet')) return json(200, { data: peer.fleet })
  return json(404, {})
})

let app: FastifyInstance

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  for (const mig of migrations) await mig.up(db)
  // Guarded and additive: a second run changes nothing.
  await migrations[migrations.length - 1].up(db)
  await (await import('../../../db/migrations/254_extension_settings.js')).up(db)
  await db.schema.createTable('nivaro_users', (t) => {
    t.uuid('id').primary()
    t.string('first_name')
    t.string('last_name')
    t.string('email')
  })
  app = Fastify()
  await app.register(
    async (f) => hubPlacementRoutes(f, { federation: { fetch: fakeFetch as never } }),
    { prefix: '/api/hub' }
  )
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await db.destroy()
  process.env.ENCRYPTION_KEY = saved.KEY
})

beforeEach(async () => {
  vi.clearAllMocks()
  peer.calls = []
  peer.self = { auth: 'api_key', key_scope: 'read', product: 'Nivaro Hub', version: '0.3.215' }
  peer.fleet = { newest: '0.3.215', rows: [] }
  peer.down = false
  peer.status = 200
  fed._resetFederationCacheForTests()
  for (const t of [
    'nivaro_hub_apps',
    'nivaro_hub_app_owners',
    'nivaro_hub_environments',
    'nivaro_hub_placements',
    'nivaro_hub_drivers',
    'nivaro_hub_shared_deployments',
    'nivaro_hub_moves',
    'nivaro_hub_capacity_samples',
    'nivaro_hub_data_runs',
    'nivaro_hub_regions',
    'nivaro_hub_region_drivers',
    'nivaro_hub_app_cost_centers',
    'nivaro_hub_peers',
    'nivaro_extension_settings',
    'nivaro_users'
  ])
    await db(t).del()
  await db('nivaro_hub_apps').insert([
    { id: 1, key: 'shop', name: 'Shop', extensions: '[]' },
    { id: 2, key: 'crm', name: 'CRM', extensions: '[]' }
  ])
  await db('nivaro_users').insert({ id: OWNER['x-user'], first_name: 'Olive', last_name: 'Owner' })
  await db('nivaro_hub_app_owners').insert({ app_id: 1, user_id: OWNER['x-user'] })
  await db('nivaro_hub_drivers').insert([
    { id: 1, kind: 'docker', name: 'host-a', config: '{}' },
    { id: 2, kind: 'docker', name: 'host-b', config: '{}' },
    { id: 3, kind: 'gitlab', name: 'gitlab', config: '{}' }
  ])
  await db('nivaro_hub_placements').insert({
    id: 10,
    kind: 'dedicated',
    driver_id: 1,
    target: JSON.stringify({ stack: 'shop-prod' })
  })
  await db('nivaro_hub_environments').insert([
    { id: 11, app_id: 1, key: 'prod', base_url: 'https://shop.example.com', placement_id: 10 },
    { id: 12, app_id: 2, key: 'prod', base_url: 'https://crm.example.com', placement_id: null }
  ])
})

const req = (
  method: string,
  url: string,
  headers: Record<string, string> = ADMIN,
  payload?: unknown
) =>
  app.inject({ method: method as never, url: `/api/hub${url}`, headers, payload: payload as never })

describe('regions and hosts', () => {
  it('is admin only', async () => {
    expect((await req('GET', '/placement', OWNER)).statusCode).toBe(403)
    expect((await req('POST', '/regions', OWNER, { key: 'eu', name: 'EU' })).statusCode).toBe(403)
  })

  it('makes a region, puts a host in it and draws the map', async () => {
    const made = await req('POST', '/regions', ADMIN, {
      key: 'eu-west',
      name: 'EU West',
      cost_percent: 120
    })
    expect(made.statusCode).toBe(201)
    const regionId = made.json().data.id
    expect(
      (await req('POST', '/regions', ADMIN, { key: 'eu-west', name: 'Again' })).statusCode
    ).toBe(409)
    expect((await req('POST', '/regions', ADMIN, { key: 'EU', name: 'x' })).json().code).toBe(
      'BAD_KEY'
    )
    expect(
      (await req('POST', '/regions', ADMIN, { key: 'us', name: 'US', cost_percent: 0 })).json().code
    ).toBe('BAD_COST_PERCENT')

    const put = await req('PUT', '/placement/hosts/1', ADMIN, {
      region_id: regionId,
      label: 'rack 4'
    })
    expect(put.statusCode).toBe(200)
    expect(
      (await req('PUT', '/placement/hosts/3', ADMIN, { region_id: regionId })).json().code
    ).toBe('NOT_A_HOST')
    const map = (await req('GET', '/placement')).json().data
    expect(map.regions).toHaveLength(1)
    expect(map.regions[0].hosts.map((h: { name: string }) => h.name)).toEqual(['host-a'])
    expect(map.regions[0].hosts[0]).toMatchObject({
      label: 'rack 4',
      environments: [{ env_id: 11, app_key: 'shop', stack: 'shop-prod' }]
    })
    expect(map.ungrouped.map((h: { name: string }) => h.name)).toEqual(['host-b'])
    expect(map.unplaced).toEqual([
      expect.objectContaining({ env_id: 12, app_key: 'crm', env_key: 'prod' })
    ])
    expect(m.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'nivaro_hub_region_drivers', item: '1' })
    )

    // A region keeps its key; delete leaves its hosts ungrouped.
    expect((await req('PATCH', `/regions/${regionId}`, ADMIN, { key: 'other' })).json().code).toBe(
      'BAD_KEY'
    )
    expect(
      (await req('PATCH', `/regions/${regionId}`, ADMIN, { name: 'EU W' })).json().data.name
    ).toBe('EU W')
    expect((await req('DELETE', `/regions/${regionId}`)).statusCode).toBe(204)
    const after = (await req('GET', '/placement')).json().data
    expect(after.ungrouped.map((h: { name: string }) => h.name).sort()).toEqual([
      'host-a',
      'host-b'
    ])
  })

  it('places an unplaced environment on a host, once', async () => {
    expect(
      (
        await req('POST', '/placement/environments/12/place', ADMIN, {
          driver_id: 2,
          stack: 'Bad Name'
        })
      ).json().code
    ).toBe('BAD_STACK')
    expect(
      (
        await req('POST', '/placement/environments/12/place', ADMIN, {
          driver_id: 3,
          stack: 'crm-prod'
        })
      ).json().code
    ).toBe('NOT_A_HOST')
    expect(
      (
        await req('POST', '/placement/environments/12/place', ADMIN, {
          driver_id: 1,
          stack: 'shop-prod'
        })
      ).json().code
    ).toBe('STACK_NAME_TAKEN')
    const ok = await req('POST', '/placement/environments/12/place', ADMIN, {
      driver_id: 2,
      stack: 'crm-prod'
    })
    expect(ok.statusCode).toBe(201)
    const env = await db('nivaro_hub_environments').where({ id: 12 }).first('placement_id')
    expect(Number(env.placement_id)).toBe(ok.json().data.placement_id)
    // Already running somewhere: move it instead.
    const again = await req('POST', '/placement/environments/11/place', ADMIN, {
      driver_id: 2,
      stack: 'shop-b'
    })
    expect(again.statusCode).toBe(409)
    expect(again.json().code).toBe('ALREADY_PLACED')
    expect(m.logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'hub-env-place' }))
  })

  it('refuses while a move holds the environment', async () => {
    await db('nivaro_hub_moves').insert({
      id: 1,
      app_id: 2,
      environment_id: 12,
      kind: 'between_stacks',
      status: 'interrupted',
      from_placement_id: 10,
      to_placement_id: 10,
      routing: 'automatic',
      steps: '{}'
    })
    const r = await req('POST', '/placement/environments/12/place', ADMIN, {
      driver_id: 2,
      stack: 'crm-prod'
    })
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('MOVE_OPEN')
  })
})

describe('cost chargeback', () => {
  it('reports per app, department and owner, with the region factor', async () => {
    const region = (
      await req('POST', '/regions', ADMIN, { key: 'eu', name: 'EU', cost_percent: 200 })
    ).json().data
    await req('PUT', '/placement/hosts/1', ADMIN, { region_id: region.id })
    await req('PUT', '/chargeback/settings', ADMIN, {
      currency: 'eur',
      rates: { cpu_core_month: 10, memory_gb_month: 2, environment_month: 5 }
    })
    expect(
      (await req('PUT', '/chargeback/settings', ADMIN, { rates: { cpu_core_month: -5 } }))
        .statusCode
    ).toBe(400)
    await req('PUT', '/chargeback/apps/1', ADMIN, { department: 'Retail', cost_center: 'CC-1' })
    const now = new Date()
    await db('nivaro_hub_capacity_samples').insert([
      { sampled_at: now, scope: 'environment', environment_id: 11, cpu_pct: 100, memory_mb: 2048 },
      { sampled_at: now, scope: 'environment', environment_id: 11, cpu_pct: 300, memory_mb: 2048 }
    ])
    const r = (await req('GET', '/chargeback')).json().data
    expect(r.currency).toBe('EUR')
    const shop = r.apps.find((a: { app_key: string }) => a.app_key === 'shop')
    // (2 cores × 10 + 2 GB × 2 + 5) × 200% = 58
    expect(shop.environments[0]).toMatchObject({
      runs_on: 'host-a',
      region: 'EU',
      usage: { cpu_cores: 2, memory_gb: 2 },
      gaps: ['storage', 'database size']
    })
    expect(shop.total).toBe(58)
    expect(shop.department).toBe('Retail')
    const crm = r.apps.find((a: { app_key: string }) => a.app_key === 'crm')
    expect(crm.environments[0].runs_on).toBe('Not placed')
    expect(crm.total).toBe(5)
    expect(r.departments).toEqual([
      { key: 'retail', label: 'Retail', apps: 1, total: 58 },
      { key: '', label: 'No department', apps: 1, total: 5 }
    ])
    expect(r.owners[0]).toMatchObject({ label: 'Olive Owner', total: 58 })
    expect(r.total).toBe(63)
  })

  it('exports a formula-safe CSV and logs it', async () => {
    await req('PUT', '/chargeback/apps/1', ADMIN, { department: '=cmd|"/c calc"!A1' })
    const csv = await req('GET', '/chargeback.csv')
    expect(csv.statusCode).toBe(200)
    expect(csv.headers['content-type']).toMatch(/text\/csv/)
    expect(csv.body).toContain(`"'=cmd|""/c calc""!A1"`)
    expect(m.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'hub-chargeback-export' })
    )
    expect((await req('GET', '/chargeback.csv', OWNER)).statusCode).toBe(403)
  })
})

describe('federation (read only)', () => {
  const row = (o: Record<string, unknown> = {}) => ({
    app_id: 5,
    app_key: 'billing',
    app_name: 'Billing <script>',
    environment_id: 50,
    env_key: 'production',
    env_status: 'active',
    base_url: 'https://billing.other.example',
    placement: 'dedicated',
    version: '0.3.214',
    state: 'ok',
    up: true,
    alerts: [],
    ...o
  })

  it('registers a Hub with a hub:read key, seals it and never answers it back', async () => {
    const r = await req('POST', '/federation/peers', ADMIN, {
      name: 'EU Hub',
      base_url: 'https://hub.other.example',
      token: KEY
    })
    expect(r.statusCode).toBe(201)
    expect(r.json().data.token).toBe('••••••')
    expect(JSON.stringify(r.json())).not.toContain(KEY)
    expect(peer.calls).toEqual([
      { url: 'https://hub.other.example/api/hub/federation/self', auth: `Bearer ${KEY}` }
    ])
    const stored = await db('nivaro_hub_peers').first('token')
    expect(stored.token).not.toContain(KEY)
    expect(openSecret(stored.token)).toBe(KEY)
    const list = (await req('GET', '/federation/peers')).json().data
    expect(list[0].token).toBe('••••••')
    expect(JSON.stringify(list)).not.toContain(KEY)
  })

  it('refuses a key that can write, a key without the scope and an older Hub; stores nothing', async () => {
    peer.self = { auth: 'api_key', key_scope: 'write' }
    const wide = await req('POST', '/federation/peers', ADMIN, {
      name: 'x',
      base_url: 'https://hub.other.example',
      token: KEY
    })
    expect(wide.statusCode).toBe(409)
    expect(wide.json().code).toBe('PEER_KEY_TOO_WIDE')
    peer.status = 403
    expect(
      (
        await req('POST', '/federation/peers', ADMIN, {
          name: 'x',
          base_url: 'https://hub.other.example',
          token: KEY
        })
      ).json().code
    ).toBe('PEER_SCOPE_MISSING')
    peer.status = 404
    expect(
      (
        await req('POST', '/federation/peers', ADMIN, {
          name: 'x',
          base_url: 'https://hub.other.example',
          token: KEY
        })
      ).json().code
    ).toBe('PEER_TOO_OLD')
    expect(
      (
        await req('POST', '/federation/peers', ADMIN, {
          name: 'x',
          base_url: 'https://hub.other.example/x',
          token: KEY
        })
      ).json().code
    ).toBe('BAD_URL')
    expect(await db('nivaro_hub_peers').count({ n: '*' }).first()).toMatchObject({ n: 0 })
  })

  it('a new address needs the key again (an old key never goes to a new origin)', async () => {
    const id = (
      await req('POST', '/federation/peers', ADMIN, {
        name: 'EU',
        base_url: 'https://hub.other.example',
        token: KEY
      })
    ).json().data.id
    peer.calls = []
    const moved = await req('PATCH', `/federation/peers/${id}`, ADMIN, {
      base_url: 'https://evil.example'
    })
    expect(moved.json().code).toBe('TOKEN_REQUIRED')
    expect(peer.calls).toEqual([])
    expect(
      (
        await req('PATCH', `/federation/peers/${id}`, ADMIN, { name: 'EU 2', token: '••••••' })
      ).json().data.name
    ).toBe('EU 2')
  })

  it('shows the other Hub’s apps rebuilt, cached and stale when it stops answering', async () => {
    await req('POST', '/federation/peers', ADMIN, {
      name: 'EU',
      base_url: 'https://hub.other.example',
      token: KEY
    })
    peer.fleet = {
      newest: '0.3.215',
      rows: [row(), row({ app_id: 'x' }), row({ base_url: 'javascript:x' })]
    }
    peer.calls = []
    const a = (await req('GET', '/federation/fleet')).json().data
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({
      name: 'EU',
      base_url: 'https://hub.other.example',
      ok: true,
      version: '0.3.215'
    })
    expect(a[0].rows).toHaveLength(2)
    expect(a[0].rows[0]).toMatchObject({
      app_name: 'Billing <script>',
      host: 'billing.other.example',
      path: '/hub?app=5'
    })
    expect(a[0].rows[1].host).toBeNull()
    // Only GETs of the two read routes, with the key.
    expect(peer.calls.map((c) => c.url)).toEqual([
      'https://hub.other.example/api/hub/federation/self',
      'https://hub.other.example/api/hub/fleet'
    ])
    // Cached 60 s.
    peer.calls = []
    await req('GET', '/federation/fleet')
    expect(peer.calls).toEqual([])
    // Down: the last good answer, marked stale; the outcome is recorded.
    peer.down = true
    const b = (await req('GET', '/federation/fleet?fresh=1')).json().data[0]
    expect(b).toMatchObject({ ok: false, error: 'PEER_UNREACHABLE', stale: true })
    expect(b.rows).toHaveLength(2)
    expect((await db('nivaro_hub_peers').first('last_error')).last_error).toBe('PEER_UNREACHABLE')
    // A key widened to hub:write since is refused on the next read.
    peer.down = false
    peer.self = { auth: 'api_key', key_scope: 'write' }
    const c = (await req('GET', '/federation/fleet?fresh=1')).json().data[0]
    expect(c.error).toBe('PEER_KEY_TOO_WIDE')
    expect(peer.calls.some((x) => x.url.endsWith('/api/hub/fleet'))).toBe(false)
  })

  it('caps the answer size', async () => {
    await req('POST', '/federation/peers', ADMIN, {
      name: 'EU',
      base_url: 'https://hub.other.example',
      token: KEY
    })
    peer.fleet = { rows: [row({ app_name: 'x'.repeat(5 * 1024 * 1024) })] }
    const a = (await req('GET', '/federation/fleet?fresh=1')).json().data[0]
    expect(a.error).toBe('PEER_TOO_LARGE')
  })

  it('answers /federation/self with the caller key’s Hub scope only', async () => {
    const r = await req('GET', '/federation/self', {
      ...OWNER,
      'x-auth': 'api_key',
      'x-scopes': JSON.stringify([{ collection: '$hub', actions: ['read'] }])
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toMatchObject({
      product: 'Nivaro Hub',
      auth: 'api_key',
      key_scope: 'read'
    })
    expect(Object.keys(r.json().data).sort()).toEqual(['auth', 'key_scope', 'product', 'version'])
    expect((await req('GET', '/federation/self', ADMIN)).json().data.key_scope).toBeNull()
  })
})
