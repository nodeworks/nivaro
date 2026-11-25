import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Knex } from 'knex'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

// Hub gap sqlite (0.3.215): the database file through the move's transfer path on a shared
// deployment — the source hands it over only while frozen; the target fetches it with the ticket,
// checks it and puts it in place of the app's file (its pool closed and opened again); a checksum
// that is not the source's leaves the target as it was; a rollback discards the copy.

const root = mkdtempSync(join(tmpdir(), 'nvr-db-transfer-'))
const saved = {
  STORAGE_LOCAL_ROOT: process.env.STORAGE_LOCAL_ROOT,
  HUB_SHARED_DEPLOYMENT: process.env.HUB_SHARED_DEPLOYMENT
}
process.env.STORAGE_LOCAL_ROOT = root
process.env.HUB_SHARED_DEPLOYMENT = 'shared-lite'

const T = await import('../../../db/sqlite-tenant.js')
const ctx = await import('../../../db/tenant-context.js')
const X = await import('../../../db/sqlite-transfer.js')
const D = await import('../../../services/hub-transfer/database.js')
const { pullDeps } = await import('../../../services/hub-transfer/pull.js')
type TenantRecord = import('../../../services/tenancy/types.js').TenantRecord

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(root, { recursive: true, force: true })
})

const realFetch = pullDeps.fetch
afterEach(() => {
  pullDeps.fetch = realFetch
})

function tenant(id: string, status: TenantRecord['status'] = 'maintenance'): TenantRecord {
  return {
    id,
    slug: id.split('-e')[0],
    name: id,
    status,
    dbClient: 'sqlite',
    dbConnection: T.sqliteTenantPath(id, 'app.sqlite'),
    poolMax: null,
    hostnames: [`${id}.example.com`]
  }
}

async function seed(t: TenantRecord, rows: number): Promise<void> {
  await ctx.withTenant(t, async () => {
    const k = ctx.getTenantDb() as Knex
    await k.schema.createTable('nivaro_migrations', (tb) => {
      tb.increments('id')
      tb.string('name')
    })
    await k('nivaro_migrations').insert({ name: '559_x.ts' })
    await k.schema.createTable('items', (tb) => {
      tb.increments('id')
      tb.string('v', 20)
    })
    for (let i = 0; i < rows; i++) await k('items').insert({ v: `r${i}` })
  })
}

/** A fake fetch that serves the source's snapshot as the transfer route does. */
function serve(snap: { path: string; sha256: string; bytes: number }, over: { sha?: string } = {}) {
  pullDeps.fetch = async (url: string, init: RequestInit) => {
    expect(url).toBe('http://10.1.2.3:3055/api/hub-transfer/database')
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Transfer ${'t'.repeat(40)}`
    )
    return new Response(readFileSync(snap.path), {
      status: 200,
      headers: {
        'content-length': String(snap.bytes),
        'x-nivaro-sha256': over.sha ?? snap.sha256
      }
    })
  }
}

const REQ = { source: 'http://10.1.2.3:3055/api/hub-transfer/files', ticket: 't'.repeat(40) }

describe('source: handed over only while frozen', () => {
  it('an app not in maintenance is refused SOURCE_NOT_FROZEN; frozen, its file is snapshotted and frozen', async () => {
    const live = tenant('src-e1', 'active')
    await seed(live, 3)
    await expect(ctx.withTenant(live, () => D.databaseSnapshot(live))).rejects.toMatchObject({
      code: 'SOURCE_NOT_FROZEN'
    })
    const frozen = { ...live, status: 'maintenance' as const }
    const snap = await ctx.withTenant(frozen, () => D.databaseSnapshot(frozen))
    expect(X.sqliteFileFrozen(frozen.dbConnection)).toBe(true)
    // A write attempt on the frozen source.
    await expect(
      ctx.withTenant(frozen, async () => (ctx.getTenantDb() as Knex)('items').insert({ v: 'no' }))
    ).rejects.toMatchObject({ code: 'SQLITE_FROZEN' })
    expect((await ctx.withTenant(frozen, () => D.databaseSum(frozen))).sha256).toBe(snap.sha256)
    rmSync(snap.path)
    X.thawSqliteFile(frozen.dbConnection)
    await ctx.closeTenantPool(frozen.dbConnection)
  })
})

describe('target: fetched, checked, put in place', () => {
  it('the target app reads the source rows after the pull (its pool closed and opened again)', async () => {
    const src = tenant('src-e2')
    await seed(src, 7)
    const snap = await ctx.withTenant(src, () => D.databaseSnapshot(src))
    const dst = tenant('dst-e2')
    // The target app already opened (and migrated) its own empty file.
    await seed(dst, 0)
    serve(snap)
    const out = await ctx.withTenant(dst, () => D.pullDatabaseShared(dst, REQ))
    expect(out).toMatchObject({ sha256: snap.sha256, bytes: snap.bytes })
    expect(out.verified).toEqual({ integrity: 'ok', migrations: 1, latest: '559_x.ts' })
    const n = await ctx.withTenant(dst, async () =>
      Number((await (ctx.getTenantDb() as Knex)('items').count({ n: '*' }))[0].n)
    )
    expect(n).toBe(7)
    rmSync(snap.path)
    X.thawSqliteFile(src.dbConnection)
    await ctx.closeTenantPool(src.dbConnection)
    await ctx.closeTenantPool(dst.dbConnection)
  })

  it('a checksum that is not the source’s: SQLITE_CHECKSUM_MISMATCH, the target file untouched', async () => {
    const src = tenant('src-e3')
    await seed(src, 4)
    const snap = await ctx.withTenant(src, () => D.databaseSnapshot(src))
    const dst = tenant('dst-e3')
    await seed(dst, 2)
    const was = (await ctx.withTenant(dst, () => D.databaseSum(dst))).sha256
    serve(snap, { sha: 'f'.repeat(64) })
    await expect(ctx.withTenant(dst, () => D.pullDatabaseShared(dst, REQ))).rejects.toMatchObject({
      code: 'SQLITE_CHECKSUM_MISMATCH'
    })
    expect((await ctx.withTenant(dst, () => D.databaseSum(dst))).sha256).toBe(was)
    rmSync(snap.path)
    X.thawSqliteFile(src.dbConnection)
    await ctx.closeTenantPool(src.dbConnection)
    await ctx.closeTenantPool(dst.dbConnection)
  })

  it('a source that is not frozen answers 409; the pull says SOURCE_NOT_FROZEN', async () => {
    const dst = tenant('dst-e4')
    pullDeps.fetch = async () =>
      new Response(JSON.stringify({ code: 'SOURCE_NOT_FROZEN' }), { status: 409 })
    await expect(ctx.withTenant(dst, () => D.pullDatabaseShared(dst, REQ))).rejects.toMatchObject({
      code: 'SOURCE_NOT_FROZEN'
    })
  })

  it('a source address that is not a transfer route is refused BAD_SOURCE', async () => {
    const dst = tenant('dst-e5')
    await expect(
      D.pullDatabaseShared(dst, { source: 'http://10.1.2.3/elsewhere', ticket: REQ.ticket })
    ).rejects.toMatchObject({ code: 'BAD_SOURCE' })
  })
})

describe('rollback before release: the copy is discarded', () => {
  it('removes the app file of an app held in maintenance; refuses an active one', async () => {
    const dst = tenant('dst-e6')
    await seed(dst, 1)
    await expect(D.discardDatabaseShared({ ...dst, status: 'active' })).rejects.toMatchObject({
      code: 'SOURCE_NOT_FROZEN'
    })
    await D.discardDatabaseShared(dst)
    const { existsSync } = await import('node:fs')
    expect(existsSync(dst.dbConnection)).toBe(false)
    expect(existsSync(`${dst.dbConnection}.lock`)).toBe(false)
  })
})
