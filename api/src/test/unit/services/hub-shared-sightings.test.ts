import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 6, Task 2: replica sightings of a shared deployment. Each process polls the
// tenants route with X-Nivaro-Instance (per process, ruling B4) and X-Nivaro-Version; the Hub
// keeps one sighting per instance in Redis (fake Redis here) and answers which live replicas hold
// a tenant list. A registered deployment whose replicas agree on a new version gets an `observed`
// shared deploy plus a `shared` deploy row per listed environment (once per version).

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

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { up: up542 } = await import('../../../db/migrations/542_hub_tables.js')
const { up: up543 } = await import('../../../db/migrations/543_hub_promotions.js')
const { up: up552 } = await import('../../../db/migrations/552_hub_shared_deployments.js')
const { up: up553 } = await import('../../../db/migrations/553_hub_moves.js')
const S = await import('../../../services/hub/shared/sightings.js')
const { sharedFromRow } = await import('../../../services/hub/shared/store.js')

const A = `"${'a'.repeat(64)}"`
const B = `"${'b'.repeat(64)}"`

/** A fake Redis that keeps what ioredis would, with a TTL on the fake clock. */
function fakeRedis(now: () => number) {
  const calls: string[] = []
  const inner = S.memorySightingsRedis(now)
  const r: Record<string, (...a: any[]) => Promise<any>> = {}
  for (const m of ['hset', 'hgetall', 'hdel', 'pexpire', 'set'] as const)
    r[m] = async (...a: any[]) => {
      calls.push(`${m} ${a[0]}`)
      return (inner as any)[m](...a)
    }
  return {
    redis: r as unknown as import('../../../services/hub/shared/sightings.js').SightingsRedis,
    calls
  }
}

let clock = Date.parse('2026-11-22T10:00:00Z')
const now = () => clock
const at = () => new Date(clock).toISOString()
let fake: ReturnType<typeof fakeRedis>

async function sharedRow(over: Record<string, unknown> = {}) {
  const key = `s${Math.random().toString(36).slice(2, 10)}`
  await db('nivaro_hub_shared_deployments').insert({
    key,
    name: key,
    mode: 'registered',
    link_url: 'https://x.example.com',
    status: 'active',
    version_pin: '0.3.210',
    ...over
  })
  return sharedFromRow(await db('nivaro_hub_shared_deployments').where({ key }).first())
}

beforeAll(async () => {
  await up542(db)
  await up543(db)
  await up552(db)
  await up553(db)
})
afterAll(async () => {
  S._setSightingsDepsForTests()
  await db.destroy()
})
beforeEach(() => {
  clock = Date.parse('2026-11-22T10:00:00Z')
  fake = fakeRedis(now)
  S._setSightingsDepsForTests({ redis: fake.redis, now })
})

describe('sightings', () => {
  it('two instances hold A, then one fetches B: holding [i2], behind [i1]', async () => {
    const sh = await sharedRow()
    await S.recordSighting(sh.id, { instance: 'i1', version: '0.3.210', etag: A, at: at() })
    await S.recordSighting(sh.id, { instance: 'i2', version: '0.3.210', etag: A, at: at() })
    expect(await S.replicasHolding(sh.id, A)).toEqual({ holding: ['i1', 'i2'], behind: [] })
    clock += 5_000
    await S.recordSighting(sh.id, { instance: 'i2', version: '0.3.210', etag: B, at: at() })
    expect(await S.replicasHolding(sh.id, B)).toEqual({ holding: ['i2'], behind: ['i1'] })
    expect(fake.calls.some((c) => c === `hset ${S.sightingsKey(sh.id)}`)).toBe(true)
  })

  it('ignores an instance unseen for more than 2 min', async () => {
    const sh = await sharedRow()
    await S.recordSighting(sh.id, { instance: 'old', version: '0.3.210', etag: A, at: at() })
    clock += 121_000
    await S.recordSighting(sh.id, { instance: 'new', version: '0.3.210', etag: B, at: at() })
    expect((await S.liveSightings(sh.id)).map((s) => s.instance)).toEqual(['new'])
    expect(await S.replicasHolding(sh.id, B)).toEqual({ holding: ['new'], behind: [] })
    // Still within the 10 min TTL: a wider window sees it.
    expect((await S.liveSightings(sh.id, 300_000)).map((s) => s.instance)).toEqual(['new', 'old'])
  })

  it('drops an instance past the 10 min TTL from the hash', async () => {
    const sh = await sharedRow()
    await S.recordSighting(sh.id, { instance: 'gone', version: null, etag: null, at: at() })
    clock += 11 * 60_000
    await S.recordSighting(sh.id, { instance: 'here', version: null, etag: null, at: at() })
    expect(Object.keys(await fake.redis.hgetall(S.sightingsKey(sh.id)))).toEqual(['here'])
  })

  it('refuses a bad instance name and stores a bad version or etag as null', async () => {
    const sh = await sharedRow()
    await S.recordSighting(sh.id, { instance: 'bad name!', version: '1', etag: A, at: at() })
    await S.recordSighting(sh.id, { instance: 'x'.repeat(101), version: '1', etag: A, at: at() })
    await S.recordSighting(sh.id, { instance: 'ok', version: 'v 1', etag: 'junk', at: at() })
    expect(await S.liveSightings(sh.id)).toEqual([
      { instance: 'ok', version: null, etag: null, at: at() }
    ])
  })

  it('writes last_seen_at at most once a minute', async () => {
    const sh = await sharedRow()
    await S.recordSighting(sh.id, { instance: 'i1', version: null, etag: null, at: at() })
    const first = (await db('nivaro_hub_shared_deployments').where({ id: sh.id }).first())
      .last_seen_at
    expect(first).not.toBeNull()
    clock += 30_000
    await S.recordSighting(sh.id, { instance: 'i1', version: null, etag: null, at: at() })
    expect(
      (await db('nivaro_hub_shared_deployments').where({ id: sh.id }).first()).last_seen_at
    ).toEqual(first)
    clock += 31_000
    await S.recordSighting(sh.id, { instance: 'i1', version: null, etag: null, at: at() })
    expect(
      (await db('nivaro_hub_shared_deployments').where({ id: sh.id }).first()).last_seen_at
    ).not.toEqual(first)
  })

  it('a Redis that fails drops the sighting but never throws; reads throw', async () => {
    const sh = await sharedRow()
    const broken = {
      hset: async () => {
        throw new Error('down')
      },
      hgetall: async () => {
        throw new Error('down')
      },
      hdel: async () => 0,
      pexpire: async () => 0,
      set: async () => null
    }
    S._setSightingsDepsForTests({ redis: broken, now })
    await expect(
      S.recordSighting(sh.id, { instance: 'i1', version: null, etag: A, at: at() })
    ).resolves.toBeUndefined()
    await expect(S.replicasHolding(sh.id, A)).rejects.toThrow()
  })
})

describe('observed versions', () => {
  async function envRow(appId: number, key: string, pin: string | null) {
    await db('nivaro_hub_environments').insert({
      app_id: appId,
      key,
      base_url: `https://${key}.example.com`,
      hostnames: '[]',
      version_pin: pin
    })
    const r = await db('nivaro_hub_environments').where({ app_id: appId, key }).first()
    return { id: Number(r.id), app_id: appId, version_pin: pin }
  }

  it('replicas that disagree record nothing', async () => {
    const sh = await sharedRow()
    const e = await envRow(901, 'dev', '0.3.210')
    await S.recordSighting(sh.id, { instance: 'i1', version: '0.3.211', etag: A, at: at() })
    await S.recordSighting(sh.id, { instance: 'i2', version: '0.3.210', etag: A, at: at() })
    expect(await S.noteObservedVersion(sh, [e])).toBeNull()
    expect(await db('nivaro_hub_shared_deploys').where({ shared_deployment_id: sh.id })).toEqual([])
  })

  it('agreement on a new version: one observed row, a shared row per env, pins moved', async () => {
    const sh = await sharedRow()
    const e1 = await envRow(902, 'dev', '0.3.210')
    const e2 = await envRow(902, 'prod', '0.3.210')
    await S.recordSighting(sh.id, { instance: 'i1', version: '0.3.211', etag: A, at: at() })
    await S.recordSighting(sh.id, { instance: 'i2', version: '0.3.211', etag: A, at: at() })
    expect(await S.noteObservedVersion(sh, [e1, e2])).toBe('0.3.211')

    const runs = await db('nivaro_hub_shared_deploys').where({ shared_deployment_id: sh.id })
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      kind: 'observed',
      version: '0.3.211',
      from_version: '0.3.210',
      status: 'success'
    })
    const rows = await db('nivaro_hub_deploys').whereIn('environment_id', [e1.id, e2.id])
    expect(rows).toHaveLength(2)
    for (const r of rows)
      expect(r).toMatchObject({
        kind: 'shared',
        version: '0.3.211',
        from_version: '0.3.210',
        status: 'success',
        shared_deploy_id: runs[0].id,
        app_id: 902
      })
    const after = sharedFromRow(
      await db('nivaro_hub_shared_deployments').where({ id: sh.id }).first()
    )
    expect(after.version_pin).toBe('0.3.211')
    const pins = await db('nivaro_hub_environments')
      .whereIn('id', [e1.id, e2.id])
      .pluck('version_pin')
    expect(pins).toEqual(['0.3.211', '0.3.211'])

    // Again (the same stale row, another Hub process, the guard expired): never twice.
    clock += 120_000
    await S.recordSighting(sh.id, { instance: 'i1', version: '0.3.211', etag: A, at: at() })
    expect(await S.noteObservedVersion(sh, [e1, e2])).toBeNull()
    expect(await S.noteObservedVersion(after, [e1, e2])).toBeNull()
    expect(
      await db('nivaro_hub_shared_deploys').where({ shared_deployment_id: sh.id })
    ).toHaveLength(1)
  })

  it('a docker deployment is never observed; no sightings, no row', async () => {
    const docker = await sharedRow({ mode: 'docker', driver_id: 1, stack: 'st' })
    await S.recordSighting(docker.id, { instance: 'i1', version: '0.3.299', etag: A, at: at() })
    expect(await S.noteObservedVersion(docker, [])).toBeNull()
    const quiet = await sharedRow()
    expect(await S.noteObservedVersion(quiet, [])).toBeNull()
    expect(
      await db('nivaro_hub_shared_deploys').whereIn('shared_deployment_id', [docker.id, quiet.id])
    ).toEqual([])
  })
})
