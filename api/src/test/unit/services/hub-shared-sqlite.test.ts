import type { Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Hub gap `sqlite` (0.3.215): the Hub side of SQLite apps on a shared deployment — the SQLite
// database record, the tenants body, the one-process rule (place / size change / upgrade) and the
// move blocker. Real SQLite with the hub tables (542–553).

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
const M = [
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
const Dbs = await import('../../../services/hub/db/databases.js')
const Store = await import('../../../services/hub/shared/store.js')
const Lite = await import('../../../services/hub/shared/sqlite-apps.js')
const { tenantsBody } = await import('../../../services/hub/shared/tenants.js')
const { parseHubTenants } = await import('../../../services/tenancy/hub-contract.js')

const saved = { HUB: process.env.HUB, KEY: process.env.ENCRYPTION_KEY }
let appId = 0
let shared: Awaited<ReturnType<typeof Store.getShared>>
let liteRecord = 0
let liteEnv = 0

async function insertId(table: string, row: Record<string, unknown>): Promise<number> {
  const [r] = await db(table).insert(row).returning('id')
  return Number(typeof r === 'object' ? (r as { id: number }).id : r)
}

beforeAll(async () => {
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = 'c'.repeat(64)
  for (const m of M) await m.up(db)
  appId = await insertId('nivaro_hub_apps', { key: 'lite', name: 'Lite' })
  const v = Store.validateSharedInput({
    key: 'shared-lite',
    name: 'Shared lite',
    link_url: 'https://shared-lite.internal.example.com'
  })
  if (!v.ok) throw new Error(v.code)
  const created = await Store.createShared(v.row, null)
  await db('nivaro_hub_shared_deployments')
    .where({ id: created.row.id })
    .update({ version_pin: '0.3.215', mode: 'docker' })
  shared = await Store.getShared(created.row.id)
  const placement = await insertId('nivaro_hub_placements', {
    kind: 'shared',
    shared_deployment_id: created.row.id,
    target: JSON.stringify({ pool_max: 2 })
  })
  liteRecord = (await Dbs.createSqliteDatabase(null)).id
  liteEnv = await insertId('nivaro_hub_environments', {
    app_id: appId,
    key: 'prod',
    status: 'active',
    base_url: 'https://lite.example.com',
    placement_id: placement,
    version_pin: '0.3.215',
    db_ref: `hub-db:${liteRecord}`
  })
  await Store.setAppKey(liteEnv, 'ab'.repeat(32))
})

afterAll(async () => {
  process.env.HUB = saved.HUB
  process.env.ENCRYPTION_KEY = saved.KEY
  await db.destroy()
})

describe('the SQLite database record', () => {
  it('is ready at once, with no server, host, login or connection', async () => {
    const d = await Dbs.getDatabase(liteRecord)
    expect(d).toMatchObject({
      engine: 'sqlite',
      status: 'ready',
      server_id: null,
      host: '',
      login_name: null,
      connection: null,
      database_name: 'app.sqlite',
      created_by_hub: true
    })
    expect(Dbs.isSqliteRecord(d)).toBe(true)
  })

  it('opens as its file name on the wire; the Hub never connects to it', async () => {
    expect(await Dbs.openDatabaseWire(liteRecord)).toEqual({
      client: 'sqlite',
      connection: 'app.sqlite',
      create: true
    })
    const moved = await Dbs.createSqliteDatabase(null, undefined, { existing: true })
    expect(await Dbs.openDatabaseWire(moved.id)).toEqual({
      client: 'sqlite',
      connection: 'app.sqlite'
    })
    await expect(Dbs.openDatabaseConnection(liteRecord)).rejects.toMatchObject({
      code: 'SQLITE_FILE'
    })
    await expect(Dbs.checkDatabase(liteRecord)).rejects.toMatchObject({ code: 'SQLITE_FILE' })
    await expect(Dbs.setConnection(liteRecord, {})).rejects.toMatchObject({ code: 'NOT_MANUAL' })
  })

  it('refuses a file name that is not a plain SQLite file name', async () => {
    await expect(Dbs.createSqliteDatabase(null, '../x.sqlite')).rejects.toMatchObject({
      code: 'BAD_NAME'
    })
  })
})

describe('the tenants body', () => {
  it('lists the SQLite app with its file name, which the deployment reads as its own folder', async () => {
    const { body } = await tenantsBody(shared!)
    const t = body.data.tenants.find(
      (x) => x.id === Store.tenantIdFor({ key: 'lite' }, { id: liteEnv })
    )
    // H2: a NEW record (never placed) lets the deployment make the file, once.
    expect(t?.db).toMatchObject({ client: 'sqlite', connection: 'app.sqlite', create: true })
    expect(typeof (t?.db as { record?: unknown } | undefined)?.record).toBe('number')
    const parsed = parseHubTenants(body, 'shared-lite', () => ({
      root: '/srv/up/app-db',
      problem: null
    }))!
    expect(parsed.dropped).toEqual([])
    expect(parsed.tenants[0].dbConnection).toBe(`/srv/up/app-db/lite-e${liteEnv}/app.sqlite`)
  })

  it('names the SQLite apps among listed environments', async () => {
    expect(
      await Lite.sqliteAppsAmong([{ env: { id: liteEnv, key: 'prod' }, app: { key: 'lite' } }])
    ).toEqual(['lite/prod'])
    expect(await Lite.environmentUsesSqlite(liteEnv)).toBe(true)
  })
})

describe('one process only', () => {
  const base = { key: 'd', mode: 'docker' as const, settings: {}, version_pin: '0.3.215' }

  it('a Docker deployment of size small at 0.3.215 or later serves SQLite apps', () => {
    expect(Lite.sqliteSharedRefusal(base)).toBeNull()
    expect(Lite.sqliteSharedRefusal({ ...base, version_pin: '0.4.0' })).toBeNull()
  })

  it('refuses a registered, a medium or large one, and an older or unknown version', () => {
    expect(Lite.sqliteSharedRefusal({ ...base, mode: 'registered' as never })?.code).toBe(
      'SQLITE_ONE_PROCESS'
    )
    expect(Lite.sqliteSharedRefusal({ ...base, settings: { size: 'medium' } })?.code).toBe(
      'SQLITE_ONE_PROCESS'
    )
    expect(Lite.sqliteSharedRefusal(base, { size: 'large' })?.code).toBe('SQLITE_ONE_PROCESS')
    for (const v of ['0.3.214', '0.3.215-rc.1', null, 'latest'])
      expect(Lite.sqliteSharedRefusal({ ...base, version_pin: v })?.code, String(v)).toBe(
        'SQLITE_SHARED_VERSION'
      )
  })
})
