import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub phase 6 parked wave (T8 review N2): the 5-minute ledger checks of `ok` apps on a Hub shared
// deployment ran one after another inside a pass, and apps adopted together shared one verifyAt,
// so every 5 minutes one pass awaited N reads and an unreachable app database held it up to the
// pool's acquire timeout. Now: verifyAt carries up to 30 s of jitter (never later than 5 min),
// the checks run a few at a time, and one pass starts at most APP_SCHEMA_VERIFY_PER_PASS.

vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: () => {} }))

const m = await import('../../../services/tenancy/app-migrations.js')
type TenantRecord = import('../../../services/tenancy/types.js').TenantRecord
type TenantRegistry = import('../../../services/tenancy/types.js').TenantRegistry

const rec = (id: string): TenantRecord => ({
  id,
  slug: id,
  name: `App ${id}`,
  status: 'active',
  dbClient: 'pg',
  dbConnection: `postgres://app_${id}:pw@db.internal:5432/app_${id}`,
  poolMax: null,
  hostnames: [`${id}.example.com`]
})

function registry(list: TenantRecord[]): TenantRegistry {
  return {
    source: 'hub',
    async resolve() {
      return null
    },
    async listActive() {
      return [...list]
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

const savedEnv = { ...process.env }
let clock = 0
const now = () => clock
const base = {
  migrate: vi.fn(async () => [1, []] as [number, string[]]),
  schemaSteps: vi.fn(async () => ({ applied: [], skipped: [], failed: [] })),
  workspace: vi.fn(async () => {})
}

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
  process.env = { ...savedEnv }
})

/** Every app migrated `ok` now (one ensure each). */
async function allOk(apps: TenantRecord[]) {
  for (const t of apps) await m.ensureAppSchema(t, base)
  for (const t of apps) expect(m.appSchemaStatus(t.id).state).toBe('ok')
}

describe('verifyAt jitter', () => {
  it('the next check comes up to 30 s early at random, never later than 5 minutes', async () => {
    const schemaCurrent = vi.fn(async () => true)
    const reg = registry([rec('a')])
    // random → 0: exactly 5 minutes
    m._configureAppMigrationsForTests({ now, gate: true, random: () => 0 })
    await allOk([rec('a')])
    clock += m.APP_SCHEMA_VERIFY_MS - 1
    await m.appMigrationPass(reg, { ...base, schemaCurrent })
    expect(schemaCurrent).toHaveBeenCalledTimes(0)
    clock += 1
    await m.appMigrationPass(reg, { ...base, schemaCurrent })
    expect(schemaCurrent).toHaveBeenCalledTimes(1)
  })

  it('random → ~1: due 30 s early', async () => {
    const schemaCurrent = vi.fn(async () => true)
    m._configureAppMigrationsForTests({ now, gate: true, random: () => 0.9999 })
    await allOk([rec('a')])
    clock += m.APP_SCHEMA_VERIFY_MS - m.APP_SCHEMA_VERIFY_JITTER_MS + 5
    await m.appMigrationPass(registry([rec('a')]), { ...base, schemaCurrent })
    expect(schemaCurrent).toHaveBeenCalledTimes(1)
  })

  it('apps adopted together spread over the window', async () => {
    let r = 0
    const seq = [0, 0.5, 0.9999]
    m._configureAppMigrationsForTests({ now, gate: true, random: () => seq[r++ % seq.length] })
    const apps = [rec('a'), rec('b'), rec('c')]
    await allOk(apps)
    const checked: string[] = []
    const schemaCurrent = vi.fn(async (t: TenantRecord) => {
      checked.push(t.id)
      return true
    })
    const reg = registry(apps)
    // 4 min 31 s: only the app whose check came ~30 s early
    clock += m.APP_SCHEMA_VERIFY_MS - m.APP_SCHEMA_VERIFY_JITTER_MS + 1_000
    await m.appMigrationPass(reg, { ...base, schemaCurrent })
    expect(checked).toEqual(['c'])
    // 4 min 46 s: the middle one too
    clock += 15_000
    await m.appMigrationPass(reg, { ...base, schemaCurrent })
    expect(checked).toEqual(['c', 'b'])
  })
})

describe('checks a few at a time, bounded per pass', () => {
  it('at most APP_SCHEMA_VERIFY_CONCURRENCY at once; one hung database holds one lane, not the rest', async () => {
    m._configureAppMigrationsForTests({ now, gate: true, random: () => 0 })
    const apps = ['a', 'b', 'c', 'd', 'e', 'f'].map(rec)
    await allOk(apps)
    let inFlight = 0
    let peak = 0
    let releaseHung: () => void = () => {}
    const done: string[] = []
    const schemaCurrent = vi.fn(async (t: TenantRecord) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      if (t.id === 'a') await new Promise<void>((r) => (releaseHung = r))
      else await new Promise((r) => setTimeout(r, 5))
      inFlight--
      done.push(t.id)
      return true
    })
    clock += m.APP_SCHEMA_VERIFY_MS
    const pass = m.appMigrationPass(registry(apps), { ...base, schemaCurrent })
    await vi.waitFor(() => expect(done.length).toBe(5))
    expect(done).not.toContain('a')
    expect(peak).toBeLessThanOrEqual(m.APP_SCHEMA_VERIFY_CONCURRENCY)
    expect(peak).toBeGreaterThan(1)
    releaseHung()
    await pass
    expect(schemaCurrent).toHaveBeenCalledTimes(6)
  })

  it('one pass starts at most APP_SCHEMA_VERIFY_PER_PASS checks; the rest stay due for the next', async () => {
    m._configureAppMigrationsForTests({ now, gate: true, random: () => 0 })
    const n = m.APP_SCHEMA_VERIFY_PER_PASS + 5
    const apps = Array.from({ length: n }, (_, i) => rec(`x${i}`))
    await allOk(apps)
    const schemaCurrent = vi.fn(async () => true)
    const reg = registry(apps)
    clock += m.APP_SCHEMA_VERIFY_MS
    await m.appMigrationPass(reg, { ...base, schemaCurrent })
    expect(schemaCurrent).toHaveBeenCalledTimes(m.APP_SCHEMA_VERIFY_PER_PASS)
    clock += 5_000
    await m.appMigrationPass(reg, { ...base, schemaCurrent })
    expect(schemaCurrent).toHaveBeenCalledTimes(n)
    // and nobody twice
    const ids = schemaCurrent.mock.calls.map((c) => (c as unknown as [TenantRecord])[0].id)
    expect(new Set(ids).size).toBe(n)
  })

  it('an overlapping pass never checks an app another pass is checking', async () => {
    m._configureAppMigrationsForTests({ now, gate: true, random: () => 0 })
    await allOk([rec('a')])
    let release: () => void = () => {}
    const schemaCurrent = vi.fn(
      () =>
        new Promise<boolean>((r) => {
          release = () => r(true)
        })
    )
    const reg = registry([rec('a')])
    clock += m.APP_SCHEMA_VERIFY_MS
    const first = m.appMigrationPass(reg, { ...base, schemaCurrent })
    await m.appMigrationPass(reg, { ...base, schemaCurrent })
    expect(schemaCurrent).toHaveBeenCalledTimes(1)
    release()
    await first
  })

  it('a replaced database found by a check is migrated again in the same pass', async () => {
    m._configureAppMigrationsForTests({ now, gate: true, random: () => 0 })
    await allOk([rec('a'), rec('b')])
    base.migrate.mockClear()
    const schemaCurrent = vi.fn(async (t: TenantRecord) => t.id !== 'b')
    clock += m.APP_SCHEMA_VERIFY_MS
    await m.appMigrationPass(registry([rec('a'), rec('b')]), { ...base, schemaCurrent })
    expect(base.migrate).toHaveBeenCalledTimes(1)
    expect(m.appSchemaStatus('b').state).toBe('ok')
  })
})

describe('Task 14 fix M3: a passing check keeps the stored `ok` alive', () => {
  it('rewrites the stored state with a fresh TTL, so an importer reading it never goes idle', async () => {
    const sets: Array<{ key: string; value: string; ttl: number }> = []
    const store = new Map<string, string>()
    const redis = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string, _mode: 'EX', ttl: number) => {
        sets.push({ key: k, value: v, ttl })
        store.set(k, v)
        return 'OK'
      }
    }
    m._configureAppMigrationsForTests({ now, gate: true, random: () => 0, redis })
    await allOk([rec('a')])
    sets.length = 0
    // 29 days on: the key written at migration is about to expire.
    clock += 29 * 24 * 3_600_000
    store.delete(m.appSchemaKey('a')) // as if it had expired already
    await m.appMigrationPass(registry([rec('a')]), {
      ...base,
      schemaCurrent: vi.fn(async () => true)
    })
    expect(sets.map((s) => s.key)).toEqual([m.appSchemaKey('a')])
    expect(sets[0].ttl).toBeGreaterThanOrEqual(30 * 24 * 3600)
    expect(JSON.parse(sets[0].value)).toMatchObject({ state: 'ok' })
    expect(await m.storedAppSchemaOk(rec('a'), redis)).toBe(true)
  })

  it('a check that finds the database behind does not write `ok`', async () => {
    const store = new Map<string, string>()
    const redis = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => {
        store.set(k, v)
        return 'OK'
      }
    }
    m._configureAppMigrationsForTests({ now, gate: true, random: () => 0, redis })
    await allOk([rec('a')])
    clock += m.APP_SCHEMA_VERIFY_MS
    await m.appMigrationPass(registry([rec('a')]), {
      ...base,
      migrate: vi.fn(async () => {
        throw new Error('down')
      }),
      schemaCurrent: vi.fn(async () => false)
    })
    expect(await m.storedAppSchemaOk(rec('a'), redis)).toBe(false)
  })
})

describe('Task 14 fix round 2: the refresh writes only a confirmed `ok` over nothing or its own `ok`', () => {
  function memRedis() {
    const store = new Map<string, string>()
    const sets: string[] = []
    return {
      store,
      sets,
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => {
        sets.push(k)
        store.set(k, v)
        return 'OK'
      }
    }
  }

  it('a ledger that cannot be read (null) writes nothing: a `pending` another replica wrote stays', async () => {
    const redis = memRedis()
    m._configureAppMigrationsForTests({ now, gate: true, random: () => 0, redis })
    await allOk([rec('a')])
    // Another replica found the database behind (dropOk): `pending` for this version.
    const pending = JSON.stringify({ version: null, state: 'pending', at: null, error: null })
    redis.store.set(m.appSchemaKey('a'), pending)
    redis.sets.length = 0
    clock += m.APP_SCHEMA_VERIFY_MS
    await m.appMigrationPass(registry([rec('a')]), {
      ...base,
      schemaCurrent: vi.fn(async () => {
        throw new Error('ledger unreadable')
      })
    })
    expect(redis.sets).toEqual([])
    expect(redis.store.get(m.appSchemaKey('a'))).toBe(pending)
  })

  it('a confirmed check never overwrites a state written by another version or another state', async () => {
    const redis = memRedis()
    m._configureAppMigrationsForTests({ now, gate: true, random: () => 0, redis })
    await allOk([rec('a')])
    const key = m.appSchemaKey('a')
    const other = JSON.stringify({ version: '9.9.9', state: 'ok', at: null, error: null })
    redis.store.set(key, other)
    redis.sets.length = 0
    clock += m.APP_SCHEMA_VERIFY_MS
    await m.appMigrationPass(registry([rec('a')]), {
      ...base,
      schemaCurrent: vi.fn(async () => true)
    })
    expect(redis.sets).toEqual([])
    expect(redis.store.get(key)).toBe(other)
  })
})
