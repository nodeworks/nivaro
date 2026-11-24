import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A realtime process (NIVARO_ROLE=realtime) on a Hub shared deployment migrates nothing: it gates
// each app on the state the migrating web / worker processes keep in Redis (appSchemaKey), for the
// app's current database, and re-reads it (startAppSchemaFollower).

vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: () => {} }))
const lifecycle = vi.hoisted(() => ({ ready: 0 }))
vi.mock('../../../services/tenancy/app-lifecycle.js', async (orig) => ({
  ...(await orig<object>()),
  fireAppReady: () => {
    lifecycle.ready++
  }
}))
const forgot = vi.hoisted(() => [] as string[])
vi.mock('../../../services/app-state.js', async (orig) => ({
  ...(await orig<object>()),
  forgetAppState: (id: string) => {
    forgot.push(id)
  }
}))

const m = await import('../../../services/tenancy/app-migrations.js')
const { NIVARO_VERSION } = await import('../../../version.js')
type TenantRecord = import('../../../services/tenancy/types.js').TenantRecord
type TenantRegistry = import('../../../services/tenancy/types.js').TenantRegistry

const rec = (id: string, over: Partial<TenantRecord> = {}): TenantRecord => ({
  id,
  slug: id,
  name: `App ${id}`,
  status: 'active',
  dbClient: 'pg',
  dbConnection: `postgres://db.internal/app_${id}`,
  poolMax: null,
  hostnames: [`${id}.example.com`],
  ...over
})

function registry(list: TenantRecord[]): TenantRegistry {
  return {
    source: 'hub',
    async resolve() {
      return null
    },
    async listActive() {
      return list.filter((t) => t.status === 'active')
    },
    async listAll() {
      return [...list]
    },
    status: () => ({
      source: 'hub',
      count: list.length,
      loadedAt: '2026-11-23T00:00:00.000Z',
      stale: false,
      lastError: null
    })
  }
}

class FakeRedis {
  store = new Map<string, string>()
  sets = 0
  /** GET fails (Redis away) while set. */
  down = false
  async get(k: string) {
    if (this.down) throw new Error('connect ECONNREFUSED')
    return this.store.get(k) ?? null
  }
  async set(k: string, v: string) {
    this.sets++
    this.store.set(k, v)
    return 'OK'
  }
}

const stored = (t: TenantRecord, state: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: NIVARO_VERSION,
    state,
    at: '2026-11-23T00:00:00.000Z',
    error: state === 'failed' ? 'boom' : null,
    conn: m.appConnFingerprint(t),
    ...over
  })

const savedEnv = { ...process.env }
beforeEach(() => {
  delete process.env.CLOUD_META_DB_URL
  process.env.HUB_SHARED_DEPLOYMENT = 'shared-a'
  process.env.HUB_URL = 'https://hub.example'
  process.env.HUB_DEPLOYMENT_TOKEN = 't'.repeat(40)
  m._resetAppMigrationsForTests()
  lifecycle.ready = 0
  forgot.length = 0
})
afterEach(() => {
  m._resetAppMigrationsForTests()
  process.env = { ...savedEnv }
})

describe('app schema follower (a realtime process on a shared deployment)', () => {
  it('gates every app on the stored state for its current database, migrating nothing', async () => {
    const a = rec('a')
    const b = rec('b')
    const c = rec('c')
    const d = rec('d')
    const redis = new FakeRedis()
    redis.store.set(m.appSchemaKey('a'), stored(a, 'ok'))
    // B's stored `ok` is about another database (the app moved): not ready here.
    redis.store.set(m.appSchemaKey('b'), stored(b, 'ok', { conn: 'other-db' }))
    redis.store.set(m.appSchemaKey('c'), stored(c, 'failed'))
    // D's `ok` is another version's (a rolling update): not ready at this version.
    redis.store.set(m.appSchemaKey('d'), stored(d, 'ok', { version: '0.0.0-old' }))
    const reg = registry([a, b, c, d])
    const stop = m.startAppSchemaFollower(() => reg, { redis, intervalMs: 60_000 })
    try {
      await m._followPassForTests(reg)
      expect(m.appReadyForRequests('a')).toBe(true)
      expect(m.appReadyForRequests('b')).toBe(false)
      expect(m.appReadyForRequests('c')).toBe(false)
      expect(m.appSchemaStatus('c')).toMatchObject({ state: 'failed', error: 'boom' })
      expect(m.appReadyForRequests('d')).toBe(false)
      // Reads only: no state written, no app-ready hooks (no per-app jobs on this process).
      expect(redis.sets).toBe(0)
      expect(lifecycle.ready).toBe(0)
    } finally {
      stop()
    }
  })

  it('follows an app that becomes migrated, and one whose database stops being migrated', async () => {
    const a = rec('a')
    const redis = new FakeRedis()
    const reg = registry([a])
    const stop = m.startAppSchemaFollower(() => reg, { redis, intervalMs: 60_000 })
    try {
      await m._followPassForTests(reg)
      expect(m.appReadyForRequests('a')).toBe(false)
      redis.store.set(m.appSchemaKey('a'), stored(a, 'ok'))
      await m._followPassForTests(reg)
      expect(m.appReadyForRequests('a')).toBe(true)
      // A migrating replica found the database behind (dropOk): pending again, and what this
      // process cached from the old database is forgotten.
      redis.store.set(m.appSchemaKey('a'), stored(a, 'pending'))
      await m._followPassForTests(reg)
      expect(m.appReadyForRequests('a')).toBe(false)
      expect(forgot).toEqual(['a'])
    } finally {
      stop()
    }
  })

  it('forgets an app that left the list', async () => {
    const a = rec('a')
    const redis = new FakeRedis()
    redis.store.set(m.appSchemaKey('a'), stored(a, 'ok'))
    const list = [a]
    const reg = registry(list)
    const stop = m.startAppSchemaFollower(() => reg, { redis, intervalMs: 60_000 })
    try {
      await m._followPassForTests(reg)
      expect(m.appReadyForRequests('a')).toBe(true)
      list.length = 0
      await m._followPassForTests(reg)
      expect(m.appReadyForRequests('a')).toBe(false)
      expect(m.appSchemaStatus('a').state).toBe('pending')
    } finally {
      stop()
    }
  })

  it('a request for an app that is not ready reads again soon (at most once a second)', async () => {
    const a = rec('a')
    const redis = new FakeRedis()
    const reg = registry([a])
    const stop = m.startAppSchemaFollower(() => reg, { redis, intervalMs: 60_000 })
    try {
      await new Promise((r) => setTimeout(r, 20))
      expect(m.appReadyForRequests('a')).toBe(false)
      redis.store.set(m.appSchemaKey('a'), stored(a, 'ok'))
      m.nudgeAppMigrations('a')
      const until = Date.now() + 2000
      while (!m.appReadyForRequests('a') && Date.now() < until)
        await new Promise((r) => setTimeout(r, 10))
      expect(m.appReadyForRequests('a')).toBe(true)
    } finally {
      stop()
    }
  })

  it('a Redis error keeps what this process knows, for each of two copied apps', async () => {
    // Two copies of one app (same user and row ids), each with its own database.
    const a = rec('a')
    const b = rec('b', { dbConnection: 'postgres://db.internal/app_b_copy' })
    const redis = new FakeRedis()
    redis.store.set(m.appSchemaKey('a'), stored(a, 'ok'))
    const reg = registry([a, b])
    const stop = m.startAppSchemaFollower(() => reg, { redis, intervalMs: 60_000 })
    try {
      await m._followPassForTests(reg)
      expect(m.appReadyForRequests('a')).toBe(true)
      expect(m.appReadyForRequests('b')).toBe(false)
      redis.down = true
      await m._followPassForTests(reg)
      await m._followPassForTests(reg)
      // A blip is not "not migrated": A keeps serving, nothing it cached is wiped; B stays out.
      expect(m.appReadyForRequests('a')).toBe(true)
      expect(m.appReadyForRequests('b')).toBe(false)
      expect(forgot).toEqual([])
      // Redis back with B migrated meanwhile: B follows, A unchanged.
      redis.down = false
      redis.store.set(m.appSchemaKey('b'), stored(b, 'ok'))
      await m._followPassForTests(reg)
      expect(m.appReadyForRequests('a')).toBe(true)
      expect(m.appReadyForRequests('b')).toBe(true)
      // An unreadable value is no answer either.
      redis.store.set(m.appSchemaKey('a'), '{not json')
      await m._followPassForTests(reg)
      expect(m.appReadyForRequests('a')).toBe(true)
    } finally {
      stop()
    }
  })

  it('an absent key keeps an `ok` for the grace period, then drops it (two copied apps)', async () => {
    const a = rec('a')
    const b = rec('b', { dbConnection: 'postgres://db.internal/app_b_copy' })
    const redis = new FakeRedis()
    redis.store.set(m.appSchemaKey('a'), stored(a, 'ok'))
    redis.store.set(m.appSchemaKey('b'), stored(b, 'ok'))
    let now = 1_000_000
    const reg = registry([a, b])
    const stop = m.startAppSchemaFollower(() => reg, {
      redis,
      intervalMs: 60_000,
      now: () => now
    })
    try {
      await m._followPassForTests(reg)
      expect(m.appReadyForRequests('a')).toBe(true)
      // A's key is gone (Redis flushed); B's is there.
      redis.store.delete(m.appSchemaKey('a'))
      await m._followPassForTests(reg)
      now += m.FOLLOW_ABSENT_GRACE_MS - 1_000
      await m._followPassForTests(reg)
      expect(m.appReadyForRequests('a')).toBe(true)
      expect(forgot).toEqual([])
      // A migrating process's 5-minute check writes it again: the grace starts over.
      redis.store.set(m.appSchemaKey('a'), stored(a, 'ok'))
      await m._followPassForTests(reg)
      redis.store.delete(m.appSchemaKey('a'))
      now += 10_000
      await m._followPassForTests(reg)
      now += m.FOLLOW_ABSENT_GRACE_MS - 1_000
      await m._followPassForTests(reg)
      expect(m.appReadyForRequests('a')).toBe(true)
      // Absent for longer than the grace: dropped, and what was cached from it forgotten.
      now += 2_000
      await m._followPassForTests(reg)
      expect(m.appReadyForRequests('a')).toBe(false)
      expect(forgot).toEqual(['a'])
      // B, a copy with the same ids, was never touched.
      expect(m.appReadyForRequests('b')).toBe(true)
      // A key naming another database drops an `ok` at once, with no grace.
      redis.store.set(m.appSchemaKey('b'), stored(b, 'ok', { conn: 'other-db' }))
      await m._followPassForTests(reg)
      expect(m.appReadyForRequests('b')).toBe(false)
      expect(forgot).toEqual(['a', 'b'])
    } finally {
      stop()
    }
  })

  it('an absent key never makes an app ready that was not', async () => {
    const a = rec('a')
    const redis = new FakeRedis()
    const reg = registry([a])
    const stop = m.startAppSchemaFollower(() => reg, { redis, intervalMs: 60_000 })
    try {
      await m._followPassForTests(reg)
      await m._followPassForTests(reg)
      expect(m.appReadyForRequests('a')).toBe(false)
      expect(m.appSchemaStatus('a').state).toBe('pending')
    } finally {
      stop()
    }
  })

  it('without the follower (self-hosted, Nivaro Cloud) every app is ready', () => {
    expect(m.appReadyForRequests('anything')).toBe(true)
  })
})
