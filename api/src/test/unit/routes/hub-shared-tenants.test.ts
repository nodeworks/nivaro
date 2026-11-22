import Fastify, { type FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 6, Task 2: GET /api/hub/shared/:key/tenants — the Hub side of the phase-5
// tenants contract. Real SQLite with the hub tables (542–553); phase-3 database rows with sealed
// connections; mounted through hubRoutes (the one register line). The body carries connections
// and app keys, so every log line of the process is captured and swept.

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
  const deny = async () => {
    throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
  }
  return { requireAuth: vi.fn(deny), requireAdmin: vi.fn(deny), authenticate: vi.fn(deny) }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const M = {
  m542: await import('../../../db/migrations/542_hub_tables.js'),
  m543: await import('../../../db/migrations/543_hub_promotions.js'),
  m544: await import('../../../db/migrations/544_hub_databases.js'),
  m545: await import('../../../db/migrations/545_hub_creations.js'),
  m546: await import('../../../db/migrations/546_hub_stack_settings.js'),
  m550: await import('../../../db/migrations/550_hub_oidc.js'),
  m551: await import('../../../db/migrations/551_hub_signins.js'),
  m552: await import('../../../db/migrations/552_hub_shared_deployments.js'),
  m553: await import('../../../db/migrations/553_hub_moves.js')
}
const { hubRoutes } = await import('../../../routes/hub.js')
const Store = await import('../../../services/hub/shared/store.js')
const Sightings = await import('../../../services/hub/shared/sightings.js')
const { sealStoredConnection } = await import('../../../services/hub/db/stored-connection.js')
const { sealSecret } = await import('../../../services/hub/secrets.js')
const { parseHubTenants } = await import('../../../services/tenancy/hub-contract.js')
const { exemptFromLimits } = await import('../../../plugins/rate-limit.js')
const { shouldSkip } = await import('../../../plugins/api-logger.js')
const { _resetTenantWarningsForTests } = await import('../../../services/hub/shared/tenants.js')

const HUB_KEY = 'c'.repeat(64)
const APP_KEY = 'ab'.repeat(32)
const PASSWORDS = ['pw-dev-Q7xk2', 'pw-prod-Z9ab1', 'pw-stage-M3c', 'pw-in-K8w', 'pw-gone-R2t']
const BROKEN_SECRET = 'hunter2-broken'

let app: FastifyInstance
let logs: string[] = []
let token = ''
let sharedId = 0
const sharedKey = 'shared-one'
let placementId = 0
let dedicatedId = 0
let appId = 0
const env: Record<string, number> = {}
const saved = { HUB: process.env.HUB, KEY: process.env.ENCRYPTION_KEY }

async function insertId(table: string, row: Record<string, unknown>): Promise<number> {
  const [r] = await db(table).insert(row).returning('id')
  return Number(typeof r === 'object' ? (r as { id: number }).id : r)
}

async function dbRecord(name: string, password: string, sealed?: string): Promise<number> {
  return insertId('nivaro_hub_databases', {
    server_id: 1,
    engine: 'pg',
    host: 'pg1.example.com',
    database_name: name,
    login_name: `${name}_app`,
    status: 'ready',
    adopted: true,
    connection:
      sealed ??
      sealStoredConnection({
        engine: 'pg',
        host: 'pg1.example.com',
        port: 5432,
        database: name,
        user: `${name}_app`,
        password,
        ssl_mode: 'require',
        trust_server_cert: false
      })
  })
}

async function envRow(
  key: string,
  o: { placement: number | null; status?: string; db: number }
): Promise<number> {
  return insertId('nivaro_hub_environments', {
    app_id: appId,
    key,
    status: o.status ?? 'active',
    base_url: `https://acme-${key}.example.com`,
    hostnames: JSON.stringify([`alt-${key}.example.com`]),
    placement_id: o.placement,
    version_pin: '0.3.210',
    db_ref: `hub-db:${o.db}`
  })
}

async function moveRow(o: Record<string, unknown>): Promise<number> {
  return insertId('nivaro_hub_moves', {
    app_id: appId,
    kind: 'to_shared',
    routing: 'automatic',
    status: 'running',
    steps: '[]',
    ...o
  })
}

const call = (headers: Record<string, string> = {}, key = sharedKey) =>
  app.inject({
    method: 'GET',
    url: `/api/hub/shared/${key}/tenants`,
    headers: { authorization: `Bearer ${token}`, ...headers },
    remoteAddress: headers['x-test-ip'] ?? '10.9.9.9'
  })

beforeAll(async () => {
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = HUB_KEY
  for (const m of Object.values(M)) await m.up(db)

  appId = await insertId('nivaro_hub_apps', { key: 'acme', name: 'Acme' })
  const created = await Store.createShared(
    (() => {
      const v = Store.validateSharedInput({
        key: sharedKey,
        name: 'Shared one',
        link_url: 'https://shared-one.internal.example.com'
      })
      if (!v.ok) throw new Error(v.code)
      return v.row
    })(),
    null
  )
  token = created.token
  sharedId = created.row.id
  await db('nivaro_hub_shared_deployments')
    .where({ id: sharedId })
    .update({ version_pin: '0.3.210' })
  placementId = await insertId('nivaro_hub_placements', {
    kind: 'shared',
    shared_deployment_id: sharedId,
    target: JSON.stringify({ pool_max: 4 })
  })
  dedicatedId = await insertId('nivaro_hub_placements', {
    kind: 'dedicated',
    driver_id: 1,
    target: JSON.stringify({ stack: 'acme-old' })
  })

  env.dev = await envRow('dev', {
    placement: placementId,
    db: await dbRecord('acme_dev', PASSWORDS[0])
  })
  env.prod = await envRow('prod', {
    placement: placementId,
    db: await dbRecord('acme_prod', PASSWORDS[1])
  })
  await Store.setAppKey(env.dev, APP_KEY)
  // Moving out of this deployment, inside maintenance (B1: maintenance set at maintenance_on).
  env.stage = await envRow('stage', {
    placement: placementId,
    status: 'maintenance',
    db: await dbRecord('acme_stage', PASSWORDS[2])
  })
  await moveRow({
    environment_id: env.stage,
    from_placement_id: placementId,
    to_placement_id: dedicatedId,
    kind: 'to_dedicated',
    step: 'files_delta'
  })
  // Moving in (B2): placed on this deployment before release → maintenance.
  env.incoming = await envRow('incoming', {
    placement: dedicatedId,
    db: await dbRecord('acme_in', PASSWORDS[3])
  })
  await moveRow({
    environment_id: env.incoming,
    from_placement_id: dedicatedId,
    to_placement_id: placementId,
    step: 'target_ready',
    placed_at: new Date()
  })
  // Moving in under manual routing (B8): place_on_target runs first, so a placed env sits at
  // files_warm / maintenance_on / wait_idle while already listed here.
  env.manual = await envRow('manual', {
    placement: dedicatedId,
    db: await dbRecord('acme_manual', 'pw-manual-1')
  })
  await moveRow({
    environment_id: env.manual,
    from_placement_id: dedicatedId,
    to_placement_id: placementId,
    routing: 'manual',
    steps: JSON.stringify([
      'check',
      'place_on_target',
      'files_warm',
      'route',
      'verify',
      'maintenance_on',
      'wait_idle',
      'files_delta',
      'target_ready',
      'release',
      'retire_source',
      'done'
    ]),
    step: 'wait_idle',
    placed_at: new Date()
  })
  // Moving in but not placed yet: not listed.
  env.early = await envRow('early', {
    placement: dedicatedId,
    db: await dbRecord('acme_early', 'x')
  })
  await moveRow({
    environment_id: env.early,
    from_placement_id: dedicatedId,
    to_placement_id: placementId,
    step: 'files_warm'
  })
  // Moved out and already retired from here: not listed.
  env.gone = await envRow('gone', {
    placement: dedicatedId,
    db: await dbRecord('acme_gone', PASSWORDS[4])
  })
  await moveRow({
    environment_id: env.gone,
    from_placement_id: placementId,
    to_placement_id: dedicatedId,
    kind: 'to_dedicated',
    step: 'retire_source'
  })
  // Archived: never listed.
  env.archived = await envRow('archived', {
    placement: placementId,
    status: 'archived',
    db: await dbRecord('acme_arch', 'y')
  })
  // A database record that cannot be opened (its seal holds no connection).
  env.broken = await envRow('broken', {
    placement: placementId,
    db: await dbRecord(
      'acme_broken',
      '',
      sealSecret(`{"note":"postgres://acme:${BROKEN_SECRET}@pg1.example.com/acme"}`)
    )
  })

  app = Fastify({
    logger: {
      level: 'trace',
      stream: {
        write(line: string) {
          logs.push(line)
        }
      }
    }
  })
  await app.register(hubRoutes, { prefix: '/api/hub' })
  await app.ready()
})
afterAll(async () => {
  await app.close()
  await db.destroy()
  Sightings._setSightingsDepsForTests()
  for (const [k, v] of [
    ['HUB', saved.HUB],
    ['ENCRYPTION_KEY', saved.KEY]
  ] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})
beforeEach(() => {
  Sightings._setSightingsDepsForTests({ redis: Sightings.memorySightingsRedis() })
})

describe('GET /api/hub/shared/:key/tenants', () => {
  it('answers the phase-5 contract: every tenant parses, none dropped', async () => {
    const res = await call()
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers.etag).toMatch(/^"[0-9a-f]{64}"$/)
    const body = res.json()
    const parsed = parseHubTenants(body, sharedKey)
    expect(parsed?.dropped).toEqual([])
    const ids = parsed?.tenants.map((t) => t.id)
    expect(ids).toEqual(
      [
        `acme-e${env.dev}`,
        `acme-e${env.incoming}`,
        `acme-e${env.manual}`,
        `acme-e${env.prod}`,
        `acme-e${env.stage}`
      ].sort()
    )
  })

  it('carries id = tenantIdFor, origin, pool_max, and the app key only when known', async () => {
    const { data } = (await call()).json()
    const dev = data.tenants.find((t: { env_key: string }) => t.env_key === 'dev')
    const prod = data.tenants.find((t: { env_key: string }) => t.env_key === 'prod')
    expect(dev).toMatchObject({
      id: Store.tenantIdFor({ key: 'acme' }, { id: env.dev }),
      app_key: 'acme',
      name: 'Acme',
      status: 'active',
      origin: 'https://acme-dev.example.com',
      pool_max: 4,
      encryption_key: APP_KEY,
      hostnames: ['acme-dev.example.com', 'alt-dev.example.com']
    })
    expect(dev.db.client).toBe('pg')
    expect(dev.db.connection).toContain(encodeURIComponent(PASSWORDS[0]))
    expect(prod.encryption_key).toBeUndefined()
    const parsed = parseHubTenants({ data }, sharedKey)
    const rec = parsed?.tenants.find((t) => t.id === dev.id)
    expect(rec?.encryptionKey).toBe(APP_KEY)
    expect(rec?.origin).toBe('https://acme-dev.example.com')
  })

  it('answers 304 for the ETag it sent; the ETag ignores generated_at', async () => {
    const first = await call()
    const etag = String(first.headers.etag)
    const again = await call({ 'if-none-match': etag })
    expect(again.statusCode).toBe(304)
    expect(again.body).toBe('')
    expect(again.headers.etag).toBe(etag)
    expect(again.headers['cache-control']).toBe('no-store')
    const other = await call({ 'if-none-match': `"${'0'.repeat(64)}"` })
    expect(other.statusCode).toBe(200)
  })

  it('lists a move out of here (step files_delta) as maintenance, and a placed move in', async () => {
    const { data } = (await call()).json()
    const by = Object.fromEntries(
      data.tenants.map((t: { env_key: string; status: string }) => [t.env_key, t.status])
    )
    expect(by.stage).toBe('maintenance')
    expect(by.incoming).toBe('maintenance')
    expect(by.manual).toBe('maintenance')
    expect(by.early).toBeUndefined()
    expect(by.gone).toBeUndefined()
  })

  it('a released move out (placement already elsewhere) stays listed as maintenance until retired', async () => {
    const id = await envRow('released', {
      placement: dedicatedId,
      status: 'active',
      db: await dbRecord('acme_rel', 'pw-rel-1')
    })
    const mv = await moveRow({
      environment_id: id,
      from_placement_id: placementId,
      to_placement_id: dedicatedId,
      kind: 'to_dedicated',
      step: 'release'
    })
    let t = (await call())
      .json()
      .data.tenants.find((x: { env_key: string }) => x.env_key === 'released')
    expect(t?.status).toBe('maintenance')
    await db('nivaro_hub_moves').where({ id: mv }).update({ step: 'retire_source' })
    t = (await call())
      .json()
      .data.tenants.find((x: { env_key: string }) => x.env_key === 'released')
    expect(t).toBeUndefined()
    await db('nivaro_hub_moves').where({ id: mv }).update({ status: 'success' })
  })

  it('leaves out an archived env and a broken database record, logging only the tenant id', async () => {
    _resetTenantWarningsForTests()
    logs = []
    const { data } = (await call()).json()
    const keys = data.tenants.map((t: { env_key: string }) => t.env_key)
    expect(keys).not.toContain('archived')
    expect(keys).not.toContain('broken')
    const all = logs.join('\n')
    expect(all).toContain(`acme-e${env.broken}`)
    expect(all).not.toContain('postgres://')
    expect(all).not.toContain(BROKEN_SECRET)
  })

  it('a wrong token and an unknown key get the same 401', async () => {
    const wrong = await call({ authorization: `Bearer ${'x'.repeat(43)}`, 'x-test-ip': '10.1.1.1' })
    const unknown = await call({ 'x-test-ip': '10.1.1.2' }, 'no-such-deployment')
    const none = await call({ authorization: '', 'x-test-ip': '10.1.1.3' })
    for (const r of [wrong, unknown, none]) {
      expect(r.statusCode).toBe(401)
      expect(r.headers['cache-control']).toBe('no-store')
    }
    expect(wrong.json()).toEqual(unknown.json())
    expect(wrong.json().code).toBe('HUB_SHARED_UNAUTHORIZED')
  })

  it('never accepts the derived link bearer (ruling R7)', async () => {
    const res = await call({
      authorization: `Bearer ${Store.deploymentLinkBearer(token)}`,
      'x-test-ip': '10.1.1.4'
    })
    expect(res.statusCode).toBe(401)
  })

  it('the 21st bad token in a minute from one address → 429, even with the right token', async () => {
    const ip = '10.2.2.2'
    for (let i = 0; i < 20; i++)
      expect((await call({ authorization: 'Bearer nope', 'x-test-ip': ip })).statusCode).toBe(401)
    expect((await call({ authorization: 'Bearer nope', 'x-test-ip': ip })).statusCode).toBe(429)
    expect((await call({ 'x-test-ip': ip })).statusCode).toBe(429)
    expect((await call({ 'x-test-ip': '10.2.2.3' })).statusCode).toBe(200)
  })

  it('records what a replica proves it holds (its If-None-Match), never the ETag just sent', async () => {
    // First poll: holds nothing yet; a 200 does not prove the replica kept the list.
    const first = await call({ 'x-nivaro-instance': 'p1', 'x-nivaro-version': '0.3.210' })
    const etag = String(first.headers.etag)
    expect(first.statusCode).toBe(200)
    expect(await Sightings.replicasHolding(sharedId, etag)).toEqual({
      holding: [],
      behind: ['p1']
    })
    // Next poll names it: now proven.
    await call({ 'x-nivaro-instance': 'p1', 'x-nivaro-version': '0.3.210', 'if-none-match': etag })
    await call({ 'x-nivaro-instance': 'p2', 'x-nivaro-version': '0.3.210', 'if-none-match': etag })
    await call({ 'x-nivaro-instance': 'bad name', 'x-nivaro-version': '0.3.210' })
    const seen = await Sightings.liveSightings(sharedId)
    expect(seen.map((s) => [s.instance, s.version, s.etag])).toEqual([
      ['p1', '0.3.210', etag],
      ['p2', '0.3.210', etag]
    ])
    expect(await Sightings.replicasHolding(sharedId, etag)).toEqual({
      holding: ['p1', 'p2'],
      behind: []
    })

    // The list changes; p1 gets the new one (200) but its next poll still carries the old tag
    // (it dropped the body: too large, unparseable, timed out) → it never counts as holding.
    await db('nivaro_hub_environments').where({ id: env.prod }).update({ status: 'suspended' })
    try {
      const changed = await call({ 'x-nivaro-instance': 'p1', 'if-none-match': etag })
      expect(changed.statusCode).toBe(200)
      const next = String(changed.headers.etag)
      expect(next).not.toBe(etag)
      const again = await call({ 'x-nivaro-instance': 'p1', 'if-none-match': etag })
      expect(again.statusCode).toBe(200)
      expect(await Sightings.replicasHolding(sharedId, next)).toEqual({
        holding: [],
        behind: ['p1', 'p2']
      })
      // p2 takes it and proves it on its next poll.
      await call({ 'x-nivaro-instance': 'p2', 'if-none-match': next })
      expect(await Sightings.replicasHolding(sharedId, next)).toEqual({
        holding: ['p2'],
        behind: ['p1']
      })
    } finally {
      await db('nivaro_hub_environments').where({ id: env.prod }).update({ status: 'active' })
    }
  })

  it('observes a new version only for apps placed here (not a released move-out or an app moving in)', async () => {
    const releasedId = await envRow('rel2', {
      placement: dedicatedId,
      db: await dbRecord('acme_rel2', 'pw-rel-2')
    })
    const mv = await moveRow({
      environment_id: releasedId,
      from_placement_id: placementId,
      to_placement_id: dedicatedId,
      kind: 'to_dedicated',
      step: 'release'
    })
    try {
      await call({ 'x-nivaro-instance': 'p1', 'x-nivaro-version': '0.3.212' })
      await call({ 'x-nivaro-instance': 'p2', 'x-nivaro-version': '0.3.212' })
      const runs = await db('nivaro_hub_shared_deploys').where({ shared_deployment_id: sharedId })
      expect(runs).toHaveLength(1)
      expect(runs[0]).toMatchObject({ kind: 'observed', version: '0.3.212' })
      const rows = await db('nivaro_hub_deploys').where({ shared_deploy_id: runs[0].id })
      // Placed here: dev, prod, stage (moving out, still placed). Not the incoming app (served by
      // its source until release), not the released one, not the broken one.
      expect(rows.map((r) => Number(r.environment_id)).sort((a, b) => a - b)).toEqual(
        [env.dev, env.prod, env.stage].sort((a, b) => a - b)
      )
      expect((await Store.getShared(sharedId))?.version_pin).toBe('0.3.212')
      const pins = Object.fromEntries(
        (
          await db('nivaro_hub_environments')
            .whereIn('id', [env.dev, env.incoming, releasedId])
            .select('id', 'version_pin')
        ).map((r) => [Number(r.id), r.version_pin])
      )
      expect(pins[env.dev]).toBe('0.3.212')
      expect(pins[env.incoming]).toBe('0.3.210')
      expect(pins[releasedId]).toBe('0.3.210')
    } finally {
      await db('nivaro_hub_moves').where({ id: mv }).update({ status: 'success' })
    }
  })

  it('never puts a response body, connection, password or app key into any log line', async () => {
    logs = []
    const res = await call({ 'x-nivaro-instance': 'p9' })
    await call({ authorization: 'Bearer wrong', 'x-test-ip': '10.3.3.3' })
    const all = logs.join('\n')
    expect(logs.length).toBeGreaterThan(0)
    const connections = res
      .json()
      .data.tenants.map((t: { db: { connection: string } }) => t.db.connection)
    expect(connections.length).toBeGreaterThan(0)
    for (const c of connections) expect(all).not.toContain(c)
    expect(all).not.toContain('postgres://')
    expect(all).not.toContain(APP_KEY)
    expect(all).not.toContain(token)
    for (const pw of PASSWORDS) expect(all).not.toContain(pw)
  })

  it('warns about a database record that cannot be opened at most once per few minutes', async () => {
    _resetTenantWarningsForTests()
    logs = []
    await call()
    await call()
    await call()
    const lines = logs.filter((l) => l.includes(`acme-e${env.broken}`))
    expect(lines).toHaveLength(1)
  })

  it('is not written to the request log (polls, path and status only)', () => {
    expect(shouldSkip('/api/hub/shared/shared-one/tenants', 'GET')).toBe(true)
    expect(shouldSkip('/api/hub/shared/shared-one', 'GET')).toBe(false)
  })

  it('is exempt from the anonymous limiter only in hub mode', () => {
    const req = (url: string) => ({ raw: { url }, headers: {} })
    expect(exemptFromLimits(req('/api/hub/shared/shared-one/tenants'))).toBe(true)
    expect(exemptFromLimits(req('/api/hub/shared/shared-one/other'))).toBe(false)
    process.env.HUB = 'off'
    try {
      expect(exemptFromLimits(req('/api/hub/shared/shared-one/tenants'))).toBe(false)
    } finally {
      process.env.HUB = 'on'
    }
  })
})

describe('mounting', () => {
  it('is not mounted outside hub mode', async () => {
    process.env.HUB = 'off'
    const a = Fastify()
    try {
      await a.register(hubRoutes, { prefix: '/api/hub' })
      await a.ready()
      const res = await a.inject({
        method: 'GET',
        url: `/api/hub/shared/${sharedKey}/tenants`,
        headers: { authorization: `Bearer ${token}` }
      })
      expect(res.statusCode).toBe(404)
    } finally {
      process.env.HUB = 'on'
      await a.close()
    }
  })
})
