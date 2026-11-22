import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub phase 6 Task 8: each app on a Hub shared deployment is migrated on its own database; an app
// whose migration failed (or has not finished) answers 503 APP_NOT_READY while the others serve.

vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: () => {} }))

const { getTenantDb, getTenantId } = await import('../../../db/tenant-context.js')
const m = await import('../../../services/tenancy/app-migrations.js')
const { tenantHook } = await import('../../../middleware/tenant.js')
const { setTenantRegistryForTests } = await import('../../../services/tenancy/registry.js')
const { NIVARO_VERSION } = await import('../../../version.js')
type TenantRecord = import('../../../services/tenancy/types.js').TenantRecord
type TenantRegistry = import('../../../services/tenancy/types.js').TenantRegistry

/** The connection a (never connected) tenant knex was built for. */
const connOf = (k: unknown) =>
  (k as { client: { connectionSettings: { database: string } } }).client.connectionSettings.database

const rec = (id: string, over: Partial<TenantRecord> = {}): TenantRecord => ({
  id,
  slug: id,
  name: `App ${id.toUpperCase()}`,
  status: 'active',
  dbClient: 'pg',
  dbConnection: `postgres://app_${id}:s3cret-${id}@db.internal:5432/app_${id}`,
  poolMax: null,
  hostnames: [`${id}.example.com`],
  ...over
})

function registry(list: TenantRecord[]): TenantRegistry {
  return {
    source: 'hub',
    async resolve(host) {
      const t = list.find((x) => x.hostnames.includes(host.split(':')[0]))
      return t ? { tenant: t, origin: `https://${host}` } : null
    },
    async listActive() {
      return list.filter((t) => t.status === 'active' || t.status === 'maintenance')
    },
    async listAll() {
      return [...list]
    },
    status: () => ({
      source: 'hub',
      count: list.length,
      loadedAt: '2026-11-22T00:00:00.000Z',
      stale: false,
      lastError: null
    })
  }
}

class FakeRedis {
  store = new Map<string, string>()
  sets: string[] = []
  async get(k: string) {
    return this.store.get(k) ?? null
  }
  async set(k: string, v: string) {
    this.sets.push(k)
    this.store.set(k, v)
    return 'OK'
  }
}

const savedEnv = { ...process.env }
let clock = Date.parse('2026-11-22T10:00:00.000Z')
const now = () => clock
const noSteps = vi.fn(async () => ({ applied: [], skipped: [], failed: [] }))
const noWorkspace = vi.fn(async () => {})
/** The app's ledger holds the newest migration (no database is reached in these tests). */
const current = async () => true

beforeEach(() => {
  delete process.env.CLOUD_META_DB_URL
  process.env.HUB_SHARED_DEPLOYMENT = 'shared-a'
  process.env.HUB_URL = 'https://hub.example'
  process.env.HUB_DEPLOYMENT_TOKEN = 't'.repeat(40)
  clock = Date.parse('2026-11-22T10:00:00.000Z')
  m._resetAppMigrationsForTests()
})
afterEach(() => {
  m._resetAppMigrationsForTests()
  setTenantRegistryForTests(null)
  process.env = { ...savedEnv }
})

describe('ensureAppSchema', () => {
  it('two apps both reach ok, each migrated on its own database, the version stored', async () => {
    const redis = new FakeRedis()
    m._configureAppMigrationsForTests({ redis, now })
    const seen: Array<{ tenant: string | undefined; db: unknown; client: string }> = []
    const migrate = vi.fn(async (k: unknown, client: string) => {
      seen.push({ tenant: getTenantId(), db: connOf(k), client })
      return [1, []] as [number, string[]]
    })
    const a = await m.ensureAppSchema(rec('a'), {
      migrate,
      schemaSteps: noSteps,
      workspace: noWorkspace
    })
    const b = await m.ensureAppSchema(rec('b'), {
      migrate,
      schemaSteps: noSteps,
      workspace: noWorkspace
    })
    expect(a).toMatchObject({ state: 'ok', version: NIVARO_VERSION, error: null })
    expect(b.state).toBe('ok')
    expect(seen).toEqual([
      { tenant: 'a', db: 'app_a', client: 'pg' },
      { tenant: 'b', db: 'app_b', client: 'pg' }
    ])
    expect(m.appSchemaStatus('a').state).toBe('ok')
    const stored = JSON.parse(redis.store.get(`nvr:tenancy:schema:a:${NIVARO_VERSION}`) ?? '{}')
    expect(stored).toMatchObject({ version: NIVARO_VERSION, state: 'ok', error: null })
    // the connection never reaches Redis, only a fingerprint of it
    expect(JSON.stringify([...redis.store.values()])).not.toContain('s3cret')
  })

  it('runs migrate, then the default workspace, then each extension schema step, inside the app', async () => {
    m._configureAppMigrationsForTests({ now })
    const order: string[] = []
    const migrate = vi.fn(async () => {
      order.push(`migrate:${getTenantId()}`)
      return [1, []] as [number, string[]]
    })
    const workspace = vi.fn(async () => {
      order.push(`workspace:${getTenantId()}`)
    })
    const schemaSteps = vi.fn(async (ext: string, k: unknown) => {
      order.push(`steps:${ext}:${getTenantId()}:${connOf(k) === 'app_a'}`)
      return { applied: [], skipped: [], failed: [] }
    })
    await m.ensureAppSchema(rec('a'), {
      migrate,
      workspace,
      schemaSteps,
      extensions: () => ['ext-1', 'ext-2']
    })
    expect(order).toEqual(['migrate:a', 'workspace:a', 'steps:ext-1:a:true', 'steps:ext-2:a:true'])
  })

  it("B's migration fails: B failed with scrubbed text, A ok, a request to B answers APP_NOT_READY while A serves", async () => {
    m._configureAppMigrationsForTests({ now, gate: true })
    const migrate = vi.fn(async () => {
      if (getTenantId() === 'b')
        throw new Error(
          'connect ECONNREFUSED postgres://app_b:s3cret-b@db.internal:5432/app_b password=s3cret-b'
        )
      return [1, []] as [number, string[]]
    })
    const deps = { migrate, schemaSteps: noSteps, workspace: noWorkspace, schemaCurrent: current }
    expect((await m.ensureAppSchema(rec('a'), deps)).state).toBe('ok')
    const b = await m.ensureAppSchema(rec('b'), deps)
    expect(b.state).toBe('failed')
    expect(b.error).toBeTruthy()
    expect(b.error).not.toContain('s3cret')
    expect((b.error ?? '').length).toBeLessThanOrEqual(300)
    expect(m.appReadyForRequests('b')).toBe(false)
    expect(m.appReadyForRequests('a')).toBe(true)

    setTenantRegistryForTests(registry([rec('a'), rec('b')]))
    const app = Fastify()
    app.addHook('onRequest', tenantHook)
    app.get('/api/items/x', async () => ({ ok: true }))
    app.get('/api/version', async () => ({ version: NIVARO_VERSION, tenant: getTenantId() }))
    app.get('/', async () => 'home')
    try {
      const resB = await app.inject({ url: '/api/items/x', headers: { host: 'b.example.com' } })
      expect(resB.statusCode).toBe(503)
      expect(resB.json()).toMatchObject({ statusCode: 503, code: 'APP_NOT_READY' })
      expect(resB.body).not.toContain('s3cret')
      const html = await app.inject({
        url: '/',
        headers: { host: 'b.example.com', accept: 'text/html' }
      })
      expect(html.statusCode).toBe(503)
      expect(html.headers['content-type']).toContain('text/html')
      expect(html.body).toContain('App B')
      // B3: /api/version still answers inside the app, so a move can verify it
      const ver = await app.inject({ url: '/api/version', headers: { host: 'b.example.com' } })
      expect(ver.statusCode).toBe(200)
      expect(ver.json()).toMatchObject({ tenant: 'b' })
      const resA = await app.inject({ url: '/api/items/x', headers: { host: 'a.example.com' } })
      expect(resA.statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('a migration still running answers APP_NOT_READY too (no schema state yet = not ready)', async () => {
    m._configureAppMigrationsForTests({ now, gate: true })
    expect(m.appSchemaStatus('c')).toEqual({
      state: 'pending',
      version: null,
      at: null,
      error: null
    })
    expect(m.appReadyForRequests('c')).toBe(false)
  })

  it('without the migration loop (self-hosted, cloud, or before it starts) every app counts as ready', () => {
    expect(m.appReadyForRequests('anything')).toBe(true)
  })
})

describe('startAppMigrations', () => {
  it('never runs more than 2 at once (3 apps), and all reach ok', async () => {
    let running = 0
    let peak = 0
    const migrate = vi.fn(async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 20))
      running--
      return [1, []] as [number, string[]]
    })
    const stop = m.startAppMigrations(registry([rec('a'), rec('b'), rec('c')]), {
      concurrency: 2,
      intervalMs: 60_000,
      now,
      migrate,
      schemaSteps: noSteps,
      workspace: noWorkspace
    })
    try {
      await vi.waitFor(
        () => {
          for (const id of ['a', 'b', 'c']) expect(m.appSchemaStatus(id).state).toBe('ok')
        },
        { timeout: 5_000, interval: 10 }
      )
      expect(migrate).toHaveBeenCalledTimes(3)
      expect(peak).toBe(2)
    } finally {
      stop()
    }
  })

  it('the stored version equals the current one: no migrate call, the app is ready', async () => {
    const redis = new FakeRedis()
    const reg = registry([rec('a')])
    // a first process migrates and stores the state …
    m._configureAppMigrationsForTests({ redis, now })
    const migrate = vi.fn(async () => [1, []] as [number, string[]])
    await m.ensureAppSchema(rec('a'), {
      migrate,
      schemaSteps: noSteps,
      workspace: noWorkspace,
      schemaCurrent: current
    })
    expect(migrate).toHaveBeenCalledTimes(1)
    // … a second process (a fresh state) reads it and does not migrate again
    m._resetAppMigrationsForTests()
    m._configureAppMigrationsForTests({ redis, now, gate: true })
    await m.appMigrationPass(reg, {
      migrate,
      schemaSteps: noSteps,
      workspace: noWorkspace,
      schemaCurrent: current
    })
    expect(migrate).toHaveBeenCalledTimes(1)
    expect(m.appReadyForRequests('a')).toBe(true)
  })

  it('a stored ok for another database (the connection changed) is not trusted', async () => {
    const redis = new FakeRedis()
    m._configureAppMigrationsForTests({ redis, now })
    const migrate = vi.fn(async () => [1, []] as [number, string[]])
    await m.ensureAppSchema(rec('a'), {
      migrate,
      schemaSteps: noSteps,
      workspace: noWorkspace,
      schemaCurrent: current
    })
    m._resetAppMigrationsForTests()
    m._configureAppMigrationsForTests({ redis, now, gate: true })
    const moved = rec('a', { dbConnection: 'postgres://app_a:x@other.internal:5432/app_a' })
    await m.appMigrationPass(registry([moved]), {
      migrate,
      schemaSteps: noSteps,
      workspace: noWorkspace,
      schemaCurrent: current
    })
    expect(migrate).toHaveBeenCalledTimes(2)
  })

  it('a failure is retried at most once every 5 minutes', async () => {
    m._configureAppMigrationsForTests({ now, gate: true })
    const migrate = vi.fn(async () => {
      throw new Error('relation "nivaro_x" does not exist')
    })
    const deps = { migrate, schemaSteps: noSteps, workspace: noWorkspace, schemaCurrent: current }
    const reg = registry([rec('b')])
    await m.appMigrationPass(reg, deps)
    expect(migrate).toHaveBeenCalledTimes(1)
    expect(m.appSchemaStatus('b').state).toBe('failed')
    clock += 60_000
    await m.appMigrationPass(reg, deps)
    clock += 3 * 60_000
    await m.appMigrationPass(reg, deps)
    expect(migrate).toHaveBeenCalledTimes(1)
    clock += 60_000 + 1
    await m.appMigrationPass(reg, deps)
    expect(migrate).toHaveBeenCalledTimes(2)
  })

  it('migrates active, maintenance and provisioning apps, never a suspended one', async () => {
    m._configureAppMigrationsForTests({ now, gate: true })
    const migrated: string[] = []
    const migrate = vi.fn(async () => {
      migrated.push(getTenantId() ?? '')
      return [1, []] as [number, string[]]
    })
    await m.appMigrationPass(
      registry([
        rec('a'),
        rec('m', { status: 'maintenance' }),
        rec('p', { status: 'provisioning' }),
        rec('s', { status: 'suspended' })
      ]),
      { migrate, schemaSteps: noSteps, workspace: noWorkspace, concurrency: 4 }
    )
    expect(migrated.sort()).toEqual(['a', 'm', 'p'])
  })

  it('another process holding the migration lock is not a failure: tried again on the next pass', async () => {
    m._configureAppMigrationsForTests({ now, gate: true })
    let busy = true
    const migrate = vi.fn(async () => {
      if (busy)
        throw new Error(
          'Could not acquire the migration advisory lock within 60000ms — another instance may be stuck mid-migration.'
        )
      return [1, []] as [number, string[]]
    })
    const deps = { migrate, schemaSteps: noSteps, workspace: noWorkspace, schemaCurrent: current }
    const reg = registry([rec('a')])
    await m.appMigrationPass(reg, deps)
    expect(m.appSchemaStatus('a').state).toBe('pending')
    busy = false
    clock += 31_000
    await m.appMigrationPass(reg, deps)
    expect(m.appSchemaStatus('a').state).toBe('ok')
  })
})

describe('readiness app-schemas', () => {
  it('warns naming the failed apps (outside any app); passes when every app is ok', async () => {
    m._configureAppMigrationsForTests({ now, gate: true })
    const migrate = vi.fn(async () => {
      if (getTenantId() === 'b') throw new Error('boom')
      return [1, []] as [number, string[]]
    })
    await m.appMigrationPass(registry([rec('a'), rec('b')]), {
      migrate,
      schemaSteps: noSteps,
      workspace: noWorkspace
    })
    const r = m.judgeAppSchemas(null)
    expect(r.status).toBe('warn')
    expect(r.detail).toContain('b')
    expect(r.detail).not.toContain('boom')
    // inside an app it speaks for that app only
    expect(m.judgeAppSchemas('a').status).toBe('pass')
    expect(m.judgeAppSchemas('b').status).toBe('warn')
  })

  it('getTenantDb is never set outside a pass (the loop runs outside any app)', () => {
    expect(getTenantDb()).toBeUndefined()
  })
})

describe('a replaced database behind the same connection (P6-8 I-3)', () => {
  it('a stored ok whose database lacks the newest migration is re-migrated, not adopted', async () => {
    const redis = new FakeRedis()
    m._configureAppMigrationsForTests({ redis, now })
    const migrate = vi.fn(async () => [1, []] as [number, string[]])
    await m.ensureAppSchema(rec('a'), { migrate, schemaSteps: noSteps, workspace: noWorkspace })
    // a fresh process; the database was restored from an older backup meanwhile
    m._resetAppMigrationsForTests()
    m._configureAppMigrationsForTests({ redis, now, gate: true })
    const behind = vi.fn(async () => false)
    await m.appMigrationPass(registry([rec('a')]), {
      migrate,
      schemaSteps: noSteps,
      workspace: noWorkspace,
      schemaCurrent: behind
    })
    expect(behind).toHaveBeenCalledTimes(1)
    expect(migrate).toHaveBeenCalledTimes(2)
    expect(m.appSchemaStatus('a').state).toBe('ok')
  })

  it('an ok app is checked again every 5 minutes: a replaced database is re-migrated', async () => {
    m._configureAppMigrationsForTests({ now, gate: true })
    const migrate = vi.fn(async () => [1, []] as [number, string[]])
    let isCurrent = true
    const schemaCurrent = vi.fn(async () => isCurrent)
    const deps = { migrate, schemaSteps: noSteps, workspace: noWorkspace, schemaCurrent }
    const reg = registry([rec('a')])
    await m.appMigrationPass(reg, deps)
    expect(migrate).toHaveBeenCalledTimes(1)
    // within the interval: no check, no migrate
    clock += 60_000
    await m.appMigrationPass(reg, deps)
    expect(schemaCurrent).toHaveBeenCalledTimes(0)
    // 5 minutes on: one check; the database is still current → untouched
    clock += 4 * 60_000
    await m.appMigrationPass(reg, deps)
    expect(schemaCurrent).toHaveBeenCalledTimes(1)
    expect(migrate).toHaveBeenCalledTimes(1)
    await m.appMigrationPass(reg, deps)
    expect(schemaCurrent).toHaveBeenCalledTimes(1)
    // the database is replaced (an environment refresh copied an older one in)
    isCurrent = false
    clock += 5 * 60_000
    await m.appMigrationPass(reg, deps)
    // the check dropped the ok; the same pass (or the next) migrates it again
    await m.appMigrationPass(reg, deps)
    expect(migrate).toHaveBeenCalledTimes(2)
    expect(m.appSchemaStatus('a').state).toBe('ok')
  })

  it('a check that cannot read the database keeps the ok (no flapping on a blip)', async () => {
    m._configureAppMigrationsForTests({ now, gate: true })
    const migrate = vi.fn(async () => [1, []] as [number, string[]])
    const schemaCurrent = vi.fn(async () => null)
    const deps = { migrate, schemaSteps: noSteps, workspace: noWorkspace, schemaCurrent }
    const reg = registry([rec('a')])
    await m.appMigrationPass(reg, deps)
    clock += 5 * 60_000
    await m.appMigrationPass(reg, deps)
    expect(schemaCurrent).toHaveBeenCalledTimes(1)
    expect(migrate).toHaveBeenCalledTimes(1)
    expect(m.appReadyForRequests('a')).toBe(true)
  })
})

describe('ledgerHasMigration', () => {
  it('true when the ledger names it, false when not or when there is no ledger', async () => {
    const { default: knex } = await import('knex')
    const k = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })
    try {
      expect(await m.ledgerHasMigration(k, '553_x.ts')).toBe(false)
      await k.schema.createTable('nivaro_migrations', (t) => {
        t.increments('id')
        t.string('name')
      })
      await k('nivaro_migrations').insert({ name: '552_y.ts' })
      expect(await m.ledgerHasMigration(k, '553_x.ts')).toBe(false)
      await k('nivaro_migrations').insert({ name: '553_x.ts' })
      expect(await m.ledgerHasMigration(k, '553_x.ts')).toBe(true)
    } finally {
      await k.destroy()
    }
  })
})

describe('request nudges (review minor 2)', () => {
  it('a request to a failed app waiting out its retry starts no pass; nudges fold to one a second', async () => {
    m._configureAppMigrationsForTests({ now })
    const failing = vi.fn(async () => {
      throw new Error('boom')
    })
    await m.ensureAppSchema(rec('b'), {
      migrate: failing,
      schemaSteps: noSteps,
      workspace: noWorkspace
    })
    expect(m.appSchemaStatus('b').state).toBe('failed')
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    try {
      const listAll = vi.fn(async () => [rec('b')])
      const stop = m.startAppMigrations(
        { ...registry([rec('b')]), listAll },
        {
          intervalMs: 60_000,
          now,
          migrate: failing,
          schemaSteps: noSteps,
          workspace: noWorkspace,
          schemaCurrent: current
        }
      )
      await vi.advanceTimersByTimeAsync(100)
      const passes = listAll.mock.calls.length
      for (let i = 0; i < 20; i++) {
        m.nudgeAppMigrations('b')
        await vi.advanceTimersByTimeAsync(60)
      }
      expect(listAll.mock.calls.length).toBe(passes)
      expect(failing).toHaveBeenCalledTimes(1)
      stop()
      // an app with no state yet: twenty nudges in 1.2 s make at most two passes
      const spy = vi.fn(async () => [] as TenantRecord[])
      const stop2 = m.startAppMigrations(
        { ...registry([]), listAll: spy },
        { intervalMs: 60_000, now }
      )
      await vi.advanceTimersByTimeAsync(100)
      const before = spy.mock.calls.length
      for (let i = 0; i < 20; i++) {
        m.nudgeAppMigrations('x')
        await vi.advanceTimersByTimeAsync(60)
      }
      expect(spy.mock.calls.length - before).toBeLessThanOrEqual(2)
      stop2()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('deployment token rotation (review minor 5)', () => {
  it('a new HUB_DEPLOYMENT_TOKEN does not make every app migrate again', async () => {
    process.env.ENCRYPTION_KEY = 'ab'.repeat(32)
    const redis = new FakeRedis()
    m._configureAppMigrationsForTests({ redis, now })
    const migrate = vi.fn(async () => [1, []] as [number, string[]])
    const deps = { migrate, schemaSteps: noSteps, workspace: noWorkspace, schemaCurrent: current }
    await m.ensureAppSchema(rec('a'), deps)
    m._resetAppMigrationsForTests()
    process.env.HUB_DEPLOYMENT_TOKEN = 'r'.repeat(40)
    m._configureAppMigrationsForTests({ redis, now, gate: true })
    await m.appMigrationPass(registry([rec('a')]), deps)
    expect(migrate).toHaveBeenCalledTimes(1)
    expect(m.appReadyForRequests('a')).toBe(true)
  })
})
