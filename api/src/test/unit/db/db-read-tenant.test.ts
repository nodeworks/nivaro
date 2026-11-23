import knex, { type Knex } from 'knex'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// Hub phase 6 ruling P6-32 (E2E A bug 2): on a multi-tenant process `dbRead` was the placeholder
// knex (no connections), so every items list and count read answered 500 "Unable to acquire a
// connection" — on a Hub shared deployment AND in Nivaro Cloud (the alias dates from the first
// commit). dbRead now resolves per tenant exactly as `db` does. The REAL db/index.ts, with two
// tenant databases (SQLite in memory) entered the way the tenant hook enters them.

vi.unmock('../../../db/index.js')
vi.mock('../../../db/metadata-query-cache.js', () => ({ attachMetadataQueryCache: () => {} }))
vi.mock('../../../db/config-epoch.js', () => ({ attachConfigEpoch: () => {} }))
vi.mock('../../../db/chaos-seam.js', () => ({ attachChaosSeam: () => {} }))

const savedEnv = { ...process.env }
let dbA: Knex
let dbB: Knex

async function appDb(rows: string[]): Promise<Knex> {
  const k = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true
  })
  await k.schema.createTable('notes', (t) => {
    t.increments('id')
    t.string('title')
  })
  if (rows.length) await k('notes').insert(rows.map((title) => ({ title })))
  return k
}

beforeAll(async () => {
  dbA = await appDb(['a1', 'a2', 'a3'])
  dbB = await appDb(['b1'])
})
afterAll(async () => {
  await dbA.destroy()
  await dbB.destroy()
})
afterEach(() => {
  process.env = { ...savedEnv }
  vi.resetModules()
})

/** db/index.ts and tenant-context.ts fresh under the env set (multiTenant is read at import). */
async function load(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  vi.resetModules()
  const idx = await import('../../../db/index.js')
  const tc = await import('../../../db/tenant-context.js')
  const inApp = <T>(id: string, k: Knex, fn: () => Promise<T>) =>
    new Promise<T>((resolve, reject) =>
      tc.runWithTenantDb(k, id, () => void fn().then(resolve, reject), id)
    )
  return { ...idx, inApp }
}

/** The list read and the count read the items service makes (services/items.ts readByQuery). */
async function listAndCount(dbRead: Knex) {
  const rows = (await dbRead('notes').select(['id', 'title']).orderBy('id')) as Array<{
    title: string
  }>
  const [c] = (await dbRead('notes').count('* as count')) as Array<{ count: number | string }>
  return { titles: rows.map((r) => r.title), count: Number(c.count) }
}

const HUB = {
  CLOUD_META_DB_URL: undefined,
  HUB_SHARED_DEPLOYMENT: 'shared-a',
  HUB_URL: 'https://hub.example',
  HUB_DEPLOYMENT_TOKEN: 't'.repeat(40)
}
const CLOUD = {
  CLOUD_META_DB_URL: 'postgres://meta@127.0.0.1:1/meta',
  HUB_SHARED_DEPLOYMENT: undefined
}

describe.each([
  ['a Hub shared deployment', HUB],
  ['Nivaro Cloud (same bug: a cloud fix)', CLOUD]
])('dbRead on %s', (_name, env) => {
  it("each app's list and count read its own rows", async () => {
    const { dbRead, inApp } = await load(env)
    const a = await inApp('app-a-e1', dbA, () => listAndCount(dbRead))
    const b = await inApp('app-b-e2', dbB, () => listAndCount(dbRead))
    expect(a).toEqual({ titles: ['a1', 'a2', 'a3'], count: 3 })
    expect(b).toEqual({ titles: ['b1'], count: 1 })
  })

  it('dbRead is the tenant-first db proxy, never the placeholder knex', async () => {
    const { dbRead, db, _staticDb } = await load(env)
    expect(dbRead).toBe(db)
    expect(dbRead).not.toBe(_staticDb)
  })

  it('outside any app a read resolves to nothing (as db does), never a pool error', async () => {
    const { dbRead } = await load(env)
    await expect(dbRead('notes').select('*')).resolves.toBeUndefined()
  })

  it('DB_READ_HOST is never used across tenants (one server for the whole process)', async () => {
    const { dbRead, db } = await load({ ...env, DB_READ_HOST: 'replica.internal' })
    expect(dbRead).toBe(db)
  })
})

describe('self-hosted (unchanged)', () => {
  it('without a replica dbRead is the db proxy; with one, its own pool', async () => {
    const plain = await load({ CLOUD_META_DB_URL: undefined, HUB_SHARED_DEPLOYMENT: undefined })
    expect(plain.dbRead).toBe(plain.db)
    await plain.closeDb().catch(() => {})
    const replica = await load({
      CLOUD_META_DB_URL: undefined,
      HUB_SHARED_DEPLOYMENT: undefined,
      DB_READ_HOST: 'replica.internal'
    })
    expect(replica.dbRead).not.toBe(replica.db)
    expect(replica.dbRead).not.toBe(replica._staticDb)
    await replica.closeDb().catch(() => {})
  })
})
