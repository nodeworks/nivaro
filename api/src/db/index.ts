import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import knex from 'knex'
import { config } from '../config.js'
import { getTenantDb } from './tenant-context.js'

const cloudMode = !!process.env.CLOUD_META_DB_URL

const migrationsDir = new URL('./migrations', import.meta.url).pathname

// Custom source so .js compiled files are tracked with .ts names, keeping
// the migration table consistent whether running via tsx (dev) or node (prod).
export const migrationSource = {
  async getMigrations() {
    const files = await readdir(migrationsDir)
    return files
      .filter((f) => (f.endsWith('.ts') && !f.endsWith('.d.ts')) || f.endsWith('.js'))
      .sort()
  },
  getMigrationName(file: string) {
    return file.replace(/\.js$/, '.ts')
  },
  async getMigration(file: string) {
    return import(join(migrationsDir, file))
  }
}

// ─── Multi-database support ──────────────────────────────────────────────────
// DB_CLIENT selects the knex dialect: 'mssql' (default) | 'pg' | 'mysql2'.
// pg / mysql2 drivers are NOT bundled — install them when used. Knex
// lazy-requires drivers, so mssql-only installs keep working without them.

const DEFAULT_PORTS: Record<typeof config.DB_CLIENT, number> = {
  mssql: 1433,
  pg: 5432,
  mysql2: 3306
}

/** The active knex client name ('mssql' | 'pg' | 'mysql2'). */
export const dbClient = config.DB_CLIENT

/** True when running against MSSQL — lets services branch on dialect (recursive CTEs etc.). */
export function isMssql(): boolean {
  return config.DB_CLIENT === 'mssql'
}

function buildConnection(host: string, port: number) {
  if (config.DB_CLIENT === 'mssql') {
    return {
      server: host,
      port,
      database: config.DB_DATABASE,
      user: config.DB_USER,
      password: config.DB_PASSWORD,
      options: {
        encrypt: config.DB_ENCRYPT,
        trustServerCertificate: config.DB_TRUST_SERVER_CERT
      }
    }
  }
  // pg / mysql2 share the same connection shape
  return {
    host,
    port,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    database: config.DB_DATABASE,
    ssl: config.DB_ENCRYPT ? { rejectUnauthorized: !config.DB_TRUST_SERVER_CERT } : false
  }
}

const writePort = config.DB_PORT ?? DEFAULT_PORTS[config.DB_CLIENT]

// The static Knex instance — used in self-hosted mode and for migration/lock calls
// that run outside of a request context (no ALS value set).
// In cloud mode DB_HOST is empty so we must not create a real pool (it crashes).
// The Proxy below always prefers getTenantDb() in cloud mode, so _staticDb is never queried.
export const _staticDb = process.env.CLOUD_META_DB_URL
  ? knex({ client: 'pg', connection: { host: 'localhost', database: 'unused' }, pool: { min: 0, max: 0 }, migrations: { migrationSource, tableName: 'nivaro_migrations' } })
  : knex({
      client: config.DB_CLIENT,
      connection: buildConnection(config.DB_HOST, writePort),
      pool: { min: 2, max: 10 },
      migrations: { migrationSource, tableName: 'nivaro_migrations' }
    })

// In cloud mode, background tasks (crons, timers) run outside request context
// and getTenantDb() returns undefined. Rather than crashing with a pool error,
// these queries silently resolve to undefined — correct behaviour since they're
// all self-hosted-only features (logs, digests, retention) that don't apply
// per-tenant. Request-scoped code always runs with a tenant DB from the ALS context.
function silentQueryBuilder(): any {
  const resolved = Promise.resolve(undefined)
  const handler: ProxyHandler<object> = {
    get(_, prop) {
      if (prop === 'then') return resolved.then.bind(resolved)
      if (prop === 'catch') return resolved.catch.bind(resolved)
      if (prop === 'finally') return resolved.finally.bind(resolved)
      return (..._args: unknown[]) => new Proxy({}, handler)
    },
    apply() { return new Proxy({}, handler) }
  }
  return new Proxy({}, handler)
}

// In cloud mode, db is a Proxy that returns the per-request tenant Knex instance
// (set via AsyncLocalStorage by the tenant middleware). In self-hosted mode,
// getTenantDb() returns undefined and the Proxy falls back to _staticDb —
// behaviour is identical to before for self-hosted users.
export const db = new Proxy(_staticDb as any, {
  apply(_target, _thisArg, args) {
    const tenant = getTenantDb()
    if (tenant) return (tenant as any)(...args)
    if (cloudMode) return silentQueryBuilder()
    return (_staticDb as any)(...args)
  },
  get(_target, prop) {
    const tenant = getTenantDb()
    const d = tenant ?? (cloudMode ? null : _staticDb)
    if (!d) {
      if (prop === 'destroy') return () => Promise.resolve()
      if (prop === 'raw') return () => silentQueryBuilder()
      if (prop === 'schema') return silentQueryBuilder()
      if (prop === 'transaction') return (fn: (trx: any) => any) => fn(new Proxy({}, {
        get(_, p) { return (..._a: unknown[]) => silentQueryBuilder() }
      }))
      return (..._args: unknown[]) => silentQueryBuilder()
    }
    const value = (d as any)[prop]
    return typeof value === 'function' ? value.bind(d) : value
  }
}) as typeof _staticDb

// ─── Read replica support ────────────────────────────────────────────────────
// When DB_READ_HOST is set, dbRead is a second knex instance pointed at the
// replica (same client/credentials/database). Otherwise it aliases db, so
// services can import dbRead unconditionally for GET-heavy queries.
export const dbRead: Database = config.DB_READ_HOST
  ? knex({
      client: config.DB_CLIENT,
      connection: buildConnection(
        config.DB_READ_HOST,
        config.DB_READ_PORT ?? config.DB_PORT ?? DEFAULT_PORTS[config.DB_CLIENT]
      ),
      pool: { min: 2, max: 10 },
      migrations: {
        migrationSource,
        tableName: 'nivaro_migrations'
      }
    })
  : _staticDb

/** Graceful shutdown — destroys the static write pool and, if separate, the read replica pool. */
export async function closeDb(): Promise<void> {
  await _staticDb.destroy()
  if (dbRead !== _staticDb) {
    await (dbRead as any).destroy()
  }
}

const MIGRATION_LOCK_NAME = 'nivaro_migrations'
// Stable integer key for pg_advisory_lock, derived from the lock name
const PG_LOCK_KEY = 793_416_204

async function acquireMigrationLock(timeoutMs: number): Promise<boolean> {
  if (config.DB_CLIENT === 'mssql') {
    const res = await db.raw(
      `DECLARE @r INT;
       EXEC @r = sp_getapplock @Resource = ?, @LockMode = 'Exclusive', @LockOwner = 'Session', @LockTimeout = ?;
       SELECT @r AS result;`,
      [MIGRATION_LOCK_NAME, timeoutMs]
    )
    const row = Array.isArray(res) ? res[0] : res
    return (row?.result ?? row?.[0]?.result ?? -999) >= 0
  }
  if (config.DB_CLIENT === 'pg') {
    // pg_advisory_lock blocks until acquired; emulate the timeout with lock_timeout
    await db.raw(`SET lock_timeout = ${Math.max(1, Math.floor(timeoutMs))}`)
    try {
      await db.raw('SELECT pg_advisory_lock(?)', [PG_LOCK_KEY])
      return true
    } catch {
      return false
    }
  }
  // mysql2
  const res = await db.raw('SELECT GET_LOCK(?, ?) AS result', [
    MIGRATION_LOCK_NAME,
    Math.ceil(timeoutMs / 1000)
  ])
  const rows = Array.isArray(res) ? res[0] : res
  return (Array.isArray(rows) ? rows[0]?.result : rows?.result) === 1
}

async function releaseMigrationLock(): Promise<void> {
  try {
    if (config.DB_CLIENT === 'mssql') {
      await db.raw(`EXEC sp_releaseapplock @Resource = ?, @LockOwner = 'Session'`, [
        MIGRATION_LOCK_NAME
      ])
    } else if (config.DB_CLIENT === 'pg') {
      await db.raw('SELECT pg_advisory_unlock(?)', [PG_LOCK_KEY])
    } else {
      await db.raw('SELECT RELEASE_LOCK(?)', [MIGRATION_LOCK_NAME])
    }
  } catch {
    // Lock is session-scoped — released automatically when the connection closes.
  }
}

/**
 * Run pending migrations, optionally guarded by a database advisory lock so
 * multiple instances starting in a rolling deploy never run migrations
 * concurrently (MIGRATION_SAFE_MODE=true). The instance that loses the race
 * waits for the winner, then sees an empty pending list and continues.
 */
export async function runMigrationsSafely(): Promise<[number, string[]]> {
  if (!config.MIGRATION_SAFE_MODE) {
    return db.migrate.latest() as Promise<[number, string[]]>
  }
  const acquired = await acquireMigrationLock(config.MIGRATION_LOCK_TIMEOUT_MS)
  if (!acquired) {
    throw new Error(
      `Could not acquire the migration advisory lock within ${config.MIGRATION_LOCK_TIMEOUT_MS}ms — another instance may be stuck mid-migration.`
    )
  }
  try {
    return (await db.migrate.latest()) as [number, string[]]
  } finally {
    await releaseMigrationLock()
  }
}

export type Database = typeof db
