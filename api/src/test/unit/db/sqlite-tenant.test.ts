import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

// Hub gap `sqlite` (0.3.215): SQLite apps on a Hub shared deployment — the file in the app's own
// folder, one write lock per file, the file lock between processes, and the db-check.

const root = mkdtempSync(join(tmpdir(), 'nvr-sqlite-tenant-'))
const saved = {
  NIVARO_SQLITE_APPS_DIR: process.env.NIVARO_SQLITE_APPS_DIR,
  HUB_SHARED_DEPLOYMENT: process.env.HUB_SHARED_DEPLOYMENT,
  NIVARO_ROLE: process.env.NIVARO_ROLE
}
process.env.NIVARO_SQLITE_APPS_DIR = join(root, 'app-db')
process.env.HUB_SHARED_DEPLOYMENT = 'shared-lite'
delete process.env.NIVARO_ROLE

const t = await import('../../../db/sqlite-tenant.js')
const ctx = await import('../../../db/tenant-context.js')
const { checkSqliteDatabase, sqliteDbIdentity } = await import(
  '../../../services/tenancy/app-status.js'
)
const { parseHubTenants } = await import('../../../services/tenancy/hub-contract.js')

const apps = join(root, 'app-db')

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(root, { recursive: true, force: true })
})

describe('sqlite tenant: where the file lives', () => {
  it('keeps each app in its own folder under <uploads>/app-db, outside the stored-files keys', () => {
    expect(t.sqliteAppsRoot()).toBe(apps)
    expect(t.sqliteTenantPath('acme-e12', 'app.sqlite')).toBe(join(apps, 'acme-e12', 'app.sqlite'))
  })

  it('refuses an id or file name that could leave the folder', () => {
    for (const [id, file] of [
      ['../x', 'app.sqlite'],
      ['acme/e1', 'app.sqlite'],
      ['ACME', 'app.sqlite'],
      ['acme-e1', '../app.sqlite'],
      ['acme-e1', 'sub/app.sqlite'],
      ['acme-e1', '.sqlite'],
      ['acme-e1', 'app.txt'],
      ['acme-e1', '/etc/passwd'],
      ['acme-e1', 'file:x']
    ])
      expect(() => t.sqliteTenantPath(id, file), `${id} ${file}`).toThrow(t.SqliteTenantError)
  })

  it('a pool path is checked again: only <root>/<id>/<file>', () => {
    expect(() => t.assertSqliteTenantPath('/tmp/app.sqlite')).toThrow(/outside/)
    expect(() => t.assertSqliteTenantPath(join(apps, 'a', 'b', 'app.sqlite'))).toThrow(/outside/)
    expect(() => t.assertSqliteTenantPath(`${apps}/a/../b/app.sqlite`)).toThrow(/outside/)
    expect(() => t.assertSqliteTenantPath(join(apps, 'a', 'app.sqlite'))).not.toThrow()
  })

  it('serves SQLite apps only on one process outside Nivaro Cloud, with the driver', () => {
    expect(t.sqliteTenantProblem({}, () => null)).toBeNull()
    expect(t.sqliteTenantProblem({ NIVARO_ROLE: 'web' }, () => null)).toMatch(/NIVARO_ROLE=web/)
    expect(t.sqliteTenantProblem({ CLOUD_META_DB_URL: 'x' }, () => null)).toMatch(/Cloud/)
    expect(t.sqliteTenantProblem({}, () => 'missing')).toMatch(/better-sqlite3/)
  })
})

describe('sqlite tenant: pools', () => {
  const a = t.sqliteTenantPath('lite-a', 'app.sqlite')
  const b = t.sqliteTenantPath('lite-b', 'app.sqlite')

  afterEach(async () => {
    await ctx.closeTenantPool(a)
    await ctx.closeTenantPool(b)
  })

  it('opens one pool per file, WAL, and takes the file lock', async () => {
    const k = ctx.getOrCreateTenantPool(a, 'sqlite', undefined, { create: true })
    expect(ctx.getOrCreateTenantPool(a, 'sqlite', undefined, { create: true })).toBe(k)
    await k.schema.createTable('x', (tb) => {
      tb.increments('id')
      tb.string('name', 20)
    })
    await k('x').insert({ name: 'one' })
    expect(existsSync(a)).toBe(true)
    expect(existsSync(`${a}.lock`)).toBe(true)
    const [mode] = (await k.raw('PRAGMA journal_mode')) as Array<{ journal_mode: string }>
    expect(mode.journal_mode).toBe('wal')
    // COLLATE NOCASE, as on a self-hosted SQLite (db/sqlite.ts point 8).
    expect((await k('x').where({ name: 'ONE' })).length).toBe(1)
    await ctx.closeTenantPool(a)
    expect(existsSync(`${a}.lock`)).toBe(false)
  })

  it('two apps never wait for each other: one write lock per file', async () => {
    const ka = ctx.getOrCreateTenantPool(a, 'sqlite', undefined, { create: true })
    const kb = ctx.getOrCreateTenantPool(b, 'sqlite', undefined, { create: true })
    for (const k of [ka, kb])
      await k.schema.createTableIfNotExists('y', (tb) => {
        tb.increments('id')
        tb.string('v', 20)
      })
    let release!: () => void
    const held = new Promise<void>((r) => {
      release = r
    })
    // App A holds its write lock in an open transaction ...
    const trx = ka.transaction(async (tx) => {
      await tx('y').insert({ v: 'a' })
      await held
    })
    await new Promise((r) => setTimeout(r, 20))
    // ... while app B writes at once (a process-wide lock would wait 60 s here).
    const started = Date.now()
    await kb('y').insert({ v: 'b' })
    expect(Date.now() - started).toBeLessThan(1_000)
    release()
    await trx
    expect((await ka('y').count({ n: '*' }))[0].n).toBe(1)
  })

  it('a file another process holds answers SQLITE_FILE_BUSY until it lets go', async () => {
    mkdirSync(join(apps, 'lite-b'), { recursive: true })
    writeFileSync(
      `${b}.lock`,
      JSON.stringify({ pid: 4242, host: 'another-container', started: new Date().toISOString() })
    )
    try {
      expect(() => ctx.getOrCreateTenantPool(b, 'sqlite', undefined, { create: true })).toThrow(
        expect.objectContaining({ code: 'SQLITE_FILE_BUSY' })
      )
    } finally {
      rmSync(`${b}.lock`, { force: true })
    }
    expect(() => ctx.getOrCreateTenantPool(b, 'sqlite', undefined, { create: true })).not.toThrow()
  })

  it('refuses a folder that links elsewhere', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'nvr-sqlite-elsewhere-'))
    try {
      symlinkSync(elsewhere, join(apps, 'lite-link'))
      expect(() =>
        ctx.getOrCreateTenantPool(
          t.sqliteTenantPath('lite-link', 'app.sqlite'),
          'sqlite',
          undefined,
          { create: true }
        )
      ).toThrow(/link elsewhere/)
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('refuses a path outside the app folders even if it reached the pool', () => {
    expect(() =>
      ctx.getOrCreateTenantPool(join(root, 'stray.sqlite'), 'sqlite', undefined, { create: true })
    ).toThrow(/outside/)
  })
})

describe('sqlite tenant: a missing file is never made again (H2)', () => {
  it('without the Hub saying NEW, a missing file is refused SQLITE_FILE_MISSING (no file made)', () => {
    const p = t.sqliteTenantPath('gone-e1', 'app.sqlite')
    expect(() => ctx.getOrCreateTenantPool(p, 'sqlite')).toThrow(
      expect.objectContaining({ code: 'SQLITE_FILE_MISSING' })
    )
    expect(existsSync(p)).toBe(false)
  })

  it('a NEW database is made once (with its marker); missing after that, it is refused even when NEW', async () => {
    const p = t.sqliteTenantPath('new-e2', 'app.sqlite')
    const k = ctx.getOrCreateTenantPool(p, 'sqlite', undefined, { create: true })
    await k.raw('SELECT 1')
    expect(existsSync(p)).toBe(true)
    expect(existsSync(join(apps, 'new-e2', t.SQLITE_CREATED_MARKER))).toBe(true)
    await ctx.closeTenantPool(p)
    rmSync(p)
    expect(() => ctx.getOrCreateTenantPool(p, 'sqlite', undefined, { create: true })).toThrow(
      expect.objectContaining({ code: 'SQLITE_FILE_MISSING' })
    )
    expect(existsSync(p)).toBe(false)
  })

  it('the folder is pinned, whatever STORAGE_LOCAL_ROOT says', () => {
    expect(t.sqliteAppsRoot({ STORAGE_LOCAL_ROOT: '/somewhere/else' })).toBe('/app/uploads/app-db')
  })
})

describe('sqlite tenant: every connection is judged, not only the first (review 4)', () => {
  /** A placed (not new) app's file with a table in it, made through a NEW pool and closed. */
  async function placedFile(id: string, record = 7): Promise<string> {
    const p = t.sqliteTenantPath(id, 'app.sqlite')
    const k = ctx.getOrCreateTenantPool(p, 'sqlite', undefined, { create: true, record })
    await k.schema.createTable('items', (tb) => tb.increments('id'))
    await ctx.closeTenantPool(p)
    return p
  }
  const dropIdle = (k: unknown) => {
    // tarn's idle connections: closed and dropped, as an idle reap does.
    const pool = (k as { client: { pool: { free: Array<{ resource: { close(): void } }> } } })
      .client.pool
    for (const f of pool.free.splice(0)) f.resource.close()
  }

  it('N1: the file removed while the app is served — the next connection is refused 503, no file is made', async () => {
    const p = await placedFile('reap-e1')
    const k = ctx.getOrCreateTenantPool(p, 'sqlite', undefined, { record: 7 })
    expect(await k('items').count({ n: '*' })).toEqual([{ n: 0 }])
    dropIdle(k)
    rmSync(p)
    await expect(k('items').count({ n: '*' })).rejects.toMatchObject({
      code: 'SQLITE_FILE_MISSING',
      statusCode: 503
    })
    expect(existsSync(p)).toBe(false)
    await ctx.closeTenantPool(p)
  })

  it('N1: a NEW pool makes its file once; removed afterwards, a reconnect never makes it again', async () => {
    const p = t.sqliteTenantPath('reap-e2', 'app.sqlite')
    const k = ctx.getOrCreateTenantPool(p, 'sqlite', undefined, { create: true, record: 8 })
    await k.raw('SELECT 1')
    dropIdle(k)
    rmSync(p)
    await expect(k.raw('SELECT 1')).rejects.toMatchObject({ code: 'SQLITE_FILE_MISSING' })
    expect(existsSync(p)).toBe(false)
    await ctx.closeTenantPool(p)
  })

  it('belt: a placed app whose file holds no table is refused, and an empty file it found goes', async () => {
    const p = t.sqliteTenantPath('empty-e1', 'app.sqlite')
    mkdirSync(join(apps, 'empty-e1'), { recursive: true })
    writeFileSync(p, '')
    const k = ctx.getOrCreateTenantPool(p, 'sqlite', undefined, { record: 9 })
    await expect(k.raw('SELECT 1')).rejects.toMatchObject({ code: 'SQLITE_FILE_MISSING' })
    expect(existsSync(p)).toBe(false)
    await ctx.closeTenantPool(p)
  })

  it('L2: the marker is written once the first connection made the file, with its record', async () => {
    const p = t.sqliteTenantPath('mark-e1', 'app.sqlite')
    const marker = join(apps, 'mark-e1', t.SQLITE_CREATED_MARKER)
    const k = ctx.getOrCreateTenantPool(p, 'sqlite', undefined, { create: true, record: 11 })
    expect(existsSync(marker)).toBe(false)
    await k.raw('SELECT 1')
    expect(statSync(p).isFile()).toBe(true)
    expect(JSON.parse(readFileSync(marker, 'utf8')).record).toBe(11)
    await ctx.closeTenantPool(p)
  })

  it("L7: a file another record made is refused SQLITE_FILE_STALE, never opened as this record's", async () => {
    const p = await placedFile('stale-e1', 21)
    for (const opts of [{ record: 22 }, { create: true, record: 22 }])
      expect(() => ctx.getOrCreateTenantPool(p, 'sqlite', undefined, opts)).toThrow(
        expect.objectContaining({ code: 'SQLITE_FILE_STALE' })
      )
    // Its own record opens it.
    const k = ctx.getOrCreateTenantPool(p, 'sqlite', undefined, { record: 21 })
    expect(await k('items').count({ n: '*' })).toEqual([{ n: 0 }])
    await ctx.closeTenantPool(p)
  })

  it('L7: a NEW record never takes a file it did not make (no marker)', () => {
    const p = t.sqliteTenantPath('stale-e2', 'app.sqlite')
    mkdirSync(join(apps, 'stale-e2'), { recursive: true })
    writeFileSync(p, 'old')
    expect(() =>
      ctx.getOrCreateTenantPool(p, 'sqlite', undefined, { create: true, record: 30 })
    ).toThrow(expect.objectContaining({ code: 'SQLITE_FILE_STALE' }))
  })
})

describe('sqlite tenant: the Hub list and the db-check', () => {
  const body = (tenants: unknown[]) => ({
    data: { deployment: 'shared-lite', generated_at: new Date().toISOString(), tenants }
  })
  const tenant = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    app_key: id.split('-e')[0],
    env_key: 'prod',
    name: id,
    status: 'active',
    hostnames: [`${id}.example.com`],
    db: { client: 'sqlite', connection: 'app.sqlite' },
    ...over
  })
  const here = { root: apps, problem: null }

  it('lists SQLite apps with their own file; two apps both named app.sqlite never clash', () => {
    const r = parseHubTenants(
      body([tenant('one-e1'), tenant('two-e2')]),
      'shared-lite',
      () => here
    )!
    expect(r.dropped).toEqual([])
    expect(r.tenants[0].dbCreate).toBeUndefined()
    expect(r.tenants.map((x) => [x.id, x.dbClient, x.dbConnection])).toEqual([
      ['one-e1', 'sqlite', join(apps, 'one-e1', 'app.sqlite')],
      ['two-e2', 'sqlite', join(apps, 'two-e2', 'app.sqlite')]
    ])
  })

  it('drops a SQLite app on a split process or with a file name that leaves its folder', () => {
    const split = parseHubTenants(body([tenant('one-e1')]), 'shared-lite', () => ({
      root: apps,
      problem: 'SQLite apps need a one-process shared deployment (size small)'
    }))!
    expect(split.tenants).toEqual([])
    expect(split.dropped[0].why).toMatch(/one-process/)
    const bad = parseHubTenants(
      body([tenant('one-e1', { db: { client: 'sqlite', connection: '../two-e2/app.sqlite' } })]),
      'shared-lite',
      () => here
    )!
    expect(bad.dropped).toEqual([{ id: 'one-e1', why: 'bad SQLite file name' }])
  })

  it('the db-check: no file yet = absent; a migrated file = present; never a write', async () => {
    const first = await checkSqliteDatabase('shared-lite', 'check-e1', 'app.sqlite')
    expect(first).toEqual({
      reachable: true,
      ledger: null,
      ledger_state: 'absent',
      db_identity: sqliteDbIdentity('shared-lite', 'check-e1', 'app.sqlite'),
      error: null
    })
    expect(existsSync(join(apps, 'check-e1', 'app.sqlite'))).toBe(false)
    const path = t.sqliteTenantPath('check-e1', 'app.sqlite')
    const k = ctx.getOrCreateTenantPool(path, 'sqlite', undefined, { create: true })
    await k.schema.createTable('nivaro_migrations', (tb) => {
      tb.increments('id')
      tb.string('name')
    })
    await k('nivaro_migrations').insert({ name: '001_init.ts' })
    const after = await checkSqliteDatabase('shared-lite', 'check-e1', 'app.sqlite')
    expect(after.ledger_state).toBe('present')
    expect(after.ledger).toEqual({ count: 1, latest: '001_init.ts' })
    await ctx.closeTenantPool(path)
    expect((await checkSqliteDatabase('shared-lite', '../x', 'app.sqlite')).reachable).toBe(false)
  })
})

beforeAll(() => {
  mkdirSync(apps, { recursive: true })
})
