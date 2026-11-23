import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub phase 6 final review (core) M2: the app-migration loop on a Hub shared deployment.
//  - The interval never starts a pass while the previous one is still deciding (a pass asked for
//    meanwhile runs once that one ends).
//  - An app whose ledger another check is reading is "not decided" this pass: never adopted as
//    `ok` without the I-3 ledger check.
//  - Adopting stored `ok` states runs a few checks at a time, so one unreachable app database does
//    not hold every app behind it at "getting ready".
//  - Final review (rest) I-1: an app whose database was replaced forgets its cached module state.

vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: () => {} }))

const m = await import('../../../services/tenancy/app-migrations.js')
const { registerAppKeyed } = await import('../../../services/app-forget.js')
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

function registry(list: TenantRecord[], listAll?: () => Promise<TenantRecord[]>): TenantRegistry {
  return {
    source: 'hub',
    async resolve() {
      return null
    },
    async listActive() {
      return [...list]
    },
    listAll: listAll ?? (async () => [...list]),
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
  async get(k: string) {
    return this.store.get(k) ?? null
  }
  async set(k: string, v: string) {
    this.store.set(k, v)
    return 'OK'
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
  base.migrate.mockClear()
})
afterEach(() => {
  m._resetAppMigrationsForTests()
  process.env = { ...savedEnv }
})

/** A stored `ok` for each app, as an earlier process left it; this process starts fresh. */
async function storedOk(redis: FakeRedis, apps: TenantRecord[]) {
  m._configureAppMigrationsForTests({ redis, now })
  for (const t of apps) await m.ensureAppSchema(t, base)
  m._resetAppMigrationsForTests()
  m._configureAppMigrationsForTests({ redis, now, gate: true })
  base.migrate.mockClear()
}

async function until(cond: () => boolean, ms = 10_000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('the loop runs one pass at a time', () => {
  it('interval ticks while a pass is deciding start none; one more runs after it ends', async () => {
    let lists = 0
    let open = 0
    let peak = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const reg = registry([], async () => {
      lists++
      open++
      peak = Math.max(peak, open)
      if (lists === 1) await gate
      open--
      return []
    })
    m._configureAppMigrationsForTests({ now })
    const stop = m.startAppMigrations(reg, { ...base, intervalMs: 50 })
    try {
      await until(() => lists === 1)
      // Several interval ticks go by while the first pass is still reading.
      await new Promise((r) => setTimeout(r, 300))
      expect(lists).toBe(1)
      release()
      await until(() => lists >= 2)
      expect(peak).toBe(1)
    } finally {
      stop()
    }
  })
})

describe('adopting stored ok states', () => {
  it('an app whose ledger is being read by another check is not adopted this pass', async () => {
    const redis = new FakeRedis()
    await storedOk(redis, [rec('a')])
    let release: (v: boolean) => void = () => {}
    const schemaCurrent = vi.fn(() => new Promise<boolean>((r) => (release = r)))
    const reg = registry([rec('a')])
    const first = m.appMigrationPass(reg, { ...base, schemaCurrent })
    await until(() => schemaCurrent.mock.calls.length === 1)
    // A second pass (a nudge) meets the check still running: no decision for this app.
    await m.appMigrationPass(reg, { ...base, schemaCurrent })
    expect(m.appReadyForRequests('a')).toBe(false)
    expect(schemaCurrent).toHaveBeenCalledTimes(1)
    // The check says the database is behind (replaced): migrated again, never adopted.
    release(false)
    await first
    expect(base.migrate).toHaveBeenCalledTimes(1)
    expect(m.appSchemaStatus('a').state).toBe('ok')
  })

  it('a few checks at a time: one hung database does not hold the others at not ready', async () => {
    const redis = new FakeRedis()
    const apps = ['a', 'b', 'c', 'd'].map(rec)
    await storedOk(redis, apps)
    let releaseHung: () => void = () => {}
    const schemaCurrent = vi.fn(async (t: TenantRecord) => {
      if (t.id === 'a') await new Promise<void>((r) => (releaseHung = () => r()))
      return true
    })
    const pass = m.appMigrationPass(registry(apps), { ...base, schemaCurrent })
    await until(() => ['b', 'c', 'd'].every((id) => m.appReadyForRequests(id)))
    expect(m.appReadyForRequests('a')).toBe(false)
    releaseHung()
    await pass
    expect(m.appReadyForRequests('a')).toBe(true)
    expect(base.migrate).not.toHaveBeenCalled()
  })
})

describe('a replaced database', () => {
  it('forgets the app’s cached module state when its ok is dropped', async () => {
    m._configureAppMigrationsForTests({ now, gate: true, random: () => 0 })
    const cache = registerAppKeyed(new Map<string, string>())
    await m.ensureAppSchema(rec('a'), base)
    await m.ensureAppSchema(rec('b'), base)
    cache.set('a\u0000relations', 'old')
    cache.set('b\u0000relations', 'kept')
    clock += m.APP_SCHEMA_VERIFY_MS
    const schemaCurrent = vi.fn(async (t: TenantRecord) => t.id !== 'a')
    await m.appMigrationPass(registry([rec('a'), rec('b')]), { ...base, schemaCurrent })
    expect(cache.has('a\u0000relations')).toBe(false)
    expect(cache.get('b\u0000relations')).toBe('kept')
  })
})
