import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import knex from 'knex'
import { config } from '../config.js'
import { attachChaosSeam } from './chaos-seam.js'
import { attachConfigEpoch } from './config-epoch.js'
import { attachMetadataQueryCache } from './metadata-query-cache.js'
import { recordEffects } from './migration-effects.js'
import { migrateFreeingStaleLock, underSessionAppLock } from './migration-lock.js'
import { inBackgroundPool } from './pool-context.js'
import { getTenantDb } from './tenant-context.js'

const cloudMode = !!process.env.CLOUD_META_DB_URL

export const migrationsDir = new URL('./migrations', import.meta.url).pathname

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
    const mod = await import(join(migrationsDir, file))
    const name = file.replace(/\.js$/, '.ts')
    // Record what each run changed — the ledger alone cannot tell a migration
    // that built things from one whose guards found everything already there.
    return {
      ...mod,
      up: recordEffects(name, 'up', mod.up),
      down: typeof mod.down === 'function' ? recordEffects(name, 'down', mod.down) : mod.down
    }
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

export function buildConnection(host: string, port: number) {
  if (config.DB_CLIENT === 'mssql') {
    return {
      server: host,
      port,
      database: config.DB_DATABASE,
      user: config.DB_USER,
      password: config.DB_PASSWORD,
      options: {
        encrypt: config.DB_ENCRYPT,
        trustServerCertificate: config.DB_TRUST_SERVER_CERT,
        // #423 — DB-side attribution: DBA tools (sp_who2, dm_exec_sessions
        // program_name) see WHICH app + instance holds a connection instead
        // of a generic driver name.
        appName: `nivaro-api${process.env.NIVARO_INSTANCE ? `@${process.env.NIVARO_INSTANCE}` : ''}`
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

export const writePort = config.DB_PORT ?? DEFAULT_PORTS[config.DB_CLIENT]

// The static Knex instance — used in self-hosted mode and for migration/lock calls
// that run outside of a request context (no ALS value set).
// In cloud mode DB_HOST is empty so we must not create a real pool (it crashes).
// The Proxy below always prefers getTenantDb() in cloud mode, so _staticDb is never queried.
export const _staticDb = process.env.CLOUD_META_DB_URL
  ? knex({
      client: 'pg',
      connection: { host: 'localhost', database: 'unused' },
      pool: { min: 0, max: 0 },
      migrations: { migrationSource, tableName: 'nivaro_migrations' }
    })
  : knex({
      client: config.DB_CLIENT,
      connection: buildConnection(config.DB_HOST, writePort),
      pool: { min: 2, max: config.DB_POOL_MAX },
      // A request that cannot get a connection in this long is answered 503
      // SERVER_BUSY (server.ts) instead of hanging into the proxy's 504.
      acquireConnectionTimeout: config.DB_ACQUIRE_TIMEOUT_MS,
      // disableMigrationsListValidation: the ledger can name migration files a
      // DIFFERENT deployment created (local dev + staging share one DB, and dev
      // auto-runs new migrations the moment tsx watch restarts). Without the
      // flag knex refuses to BOOT ("migration directory is corrupt") and the
      // deployed container crash-loops — the repeated staging outage. Our
      // migrations are hasTable/hasColumn-guarded and additive, so an image
      // missing a newer file safely serves against the newer schema and runs
      // the file when its release lands.
      migrations: {
        migrationSource,
        tableName: 'nivaro_migrations',
        disableMigrationsListValidation: true
      }
    })

// #1321 — the background pool: scheduled jobs, imports, cache warms and
// backfills borrow from it (db/pool-context.ts binds them), so an interactive
// request never waits for a connection background work is holding. Same
// server, credentials and database as the main pool; `min: 0` so a process
// that runs no background work opens no connection for it. Not created in
// cloud mode (background work there runs outside any tenant and resolves to
// nothing, see below) or when DB_POOL_BACKGROUND_MAX is 0 (shares the main
// pool, the behaviour before #1321).
const backgroundMax = Number(config.DB_POOL_BACKGROUND_MAX ?? 0) || 0
export const _backgroundDb: ReturnType<typeof knex> | null =
  !cloudMode && backgroundMax > 0
    ? knex({
        client: config.DB_CLIENT,
        connection: buildConnection(config.DB_HOST, writePort),
        pool: { min: 0, max: backgroundMax },
        migrations: {
          migrationSource,
          tableName: 'nivaro_migrations',
          disableMigrationsListValidation: true
        }
      })
    : null

/**
 * The database health probe's own connection (services/db-health.ts). The probe
 * used to borrow from the request pool, so a pool full of slow report queries made
 * three `SELECT 1`s time out waiting for a connection — the process then declared
 * the database unreachable, refused every request with 503 and was restarted by
 * its orchestrator while the database was fine (staging army test 2026-10-24: two
 * of three web replicas). One connection of its own answers "is the database
 * there", not "is the pool free". Same server and credentials; not in cloud mode.
 */
let probeKnex: ReturnType<typeof knex> | null = null
export function probeDb(): ReturnType<typeof knex> | null {
  if (cloudMode) return null
  probeKnex ??= knex({
    client: config.DB_CLIENT,
    connection: buildConnection(config.DB_HOST, writePort),
    pool: { min: 0, max: 1, acquireTimeoutMillis: 10_000 }
  })
  return probeKnex
}
// Built on first use. The chaos seam patches the driver prototype, so database
// drills reach the probe too (a failing database still trips the outage
// posture); a pool drill does not, by design.

/** The self-hosted knex the current async context runs on: the background
 *  pool inside bound background work (when it exists), else the main pool. */
function activeStaticDb(): typeof _staticDb {
  return _backgroundDb && inBackgroundPool() ? _backgroundDb : _staticDb
}

// #1773 — the database fault point (chaos drills); first, so cached config reads skip it.
if (!cloudMode) attachChaosSeam(_staticDb)
// Configuration reads (relations, fields, rules, layouts, column lists) are
// answered from a short-lived cache at the driver seam — see the module.
// (It patches the driver prototype, so the background pool is covered too.)
attachMetadataQueryCache(_staticDb)
// A configuration write moves one number that every other process polls.
attachConfigEpoch(_staticDb)

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
    apply() {
      return new Proxy({}, handler)
    }
  }
  return new Proxy({}, handler)
}

// In cloud mode, db is a Proxy that returns the per-request tenant Knex instance
// (set via AsyncLocalStorage by the tenant middleware). In self-hosted mode,
// getTenantDb() returns undefined and the Proxy falls back to _staticDb —
// behaviour is identical to before for self-hosted users.
//
// #1321 — self-hosted, the proxy also picks the POOL: work bound with
// runInBackgroundPool (crons, imports, warms) resolves to _backgroundDb.
// A tenant context always wins: a tenant's work stays on that tenant's pool.
export const db = new Proxy(_staticDb as any, {
  apply(_target, _thisArg, args) {
    const tenant = getTenantDb()
    if (tenant) return (tenant as any)(...args)
    if (cloudMode) return silentQueryBuilder()
    return (activeStaticDb() as any)(...args)
  },
  get(_target, prop) {
    const tenant = getTenantDb()
    const d = tenant ?? (cloudMode ? null : activeStaticDb())
    if (!d) {
      if (prop === 'destroy') return () => Promise.resolve()
      if (prop === 'raw') return () => silentQueryBuilder()
      if (prop === 'schema') return silentQueryBuilder()
      if (prop === 'transaction')
        return (fn: (trx: any) => any) =>
          fn(
            new Proxy(
              {},
              {
                get(_, p) {
                  return (..._a: unknown[]) => silentQueryBuilder()
                }
              }
            )
          )
      return (..._args: unknown[]) => silentQueryBuilder()
    }
    const value = (d as any)[prop]
    return typeof value === 'function' ? value.bind(d) : value
  }
}) as typeof _staticDb

/**
 * The concrete knex `db` resolves to right now — the tenant's in cloud mode,
 * else the background or main pool (#1321). For code that holds on to the
 * instance across calls (a pinned connection, driver internals) and must keep
 * borrowing from the pool it started on. Cloud mode outside a tenant returns
 * the proxy itself (its calls resolve to nothing, as before).
 */
export function resolveDb(): typeof _staticDb {
  const tenant = getTenantDb()
  if (tenant) return tenant as typeof _staticDb
  if (cloudMode) return db
  return activeStaticDb()
}

// ─── Read replica support ────────────────────────────────────────────────────
// When DB_READ_HOST is set, dbRead is a second knex instance pointed at the
// replica (same client/credentials/database). Otherwise it aliases db, so
// services can import dbRead unconditionally for GET-heavy queries.
// #1321 — self-hosted without a replica it IS the `db` proxy (it used to be
// _staticDb), so a list read inside background work (items readByQuery from a
// cron, a digest, a queue rebuild) takes the background pool like every other
// call. Cloud mode keeps the old alias, unchanged. With a replica, list reads
// share the replica's one pool whatever the context.
export const dbRead: Database = config.DB_READ_HOST
  ? knex({
      client: config.DB_CLIENT,
      connection: buildConnection(
        config.DB_READ_HOST,
        config.DB_READ_PORT ?? config.DB_PORT ?? DEFAULT_PORTS[config.DB_CLIENT]
      ),
      pool: { min: 2, max: config.DB_POOL_MAX },
      migrations: {
        migrationSource,
        tableName: 'nivaro_migrations'
      }
    })
  : cloudMode
    ? _staticDb
    : db

/** Graceful shutdown — destroys the static write pool, the background pool and, if separate, the read replica pool. */
export async function closeDb(): Promise<void> {
  await _staticDb.destroy()
  if (_backgroundDb) await _backgroundDb.destroy()
  if (probeKnex) await probeKnex.destroy()
  if (config.DB_READ_HOST) {
    await (dbRead as any).destroy()
  }
}

export const MIGRATION_LOCK_NAME = 'nivaro_migrations'
// Stable integer key for pg_advisory_lock, derived from the lock name
export const PG_LOCK_KEY = 793_416_204

// pg + mysql only: mssql takes its lock on a pinned session (runMigrationsSafely).
async function acquireMigrationLock(timeoutMs: number): Promise<boolean> {
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
    if (config.DB_CLIENT === 'pg') {
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
    return migrateLatestFreeingStaleLock()
  }
  if (config.DB_CLIENT === 'mssql') {
    // Take, hold and release the session lock on ONE pinned connection (underSessionAppLock).
    const { withLongConnection } = await import('../services/run-long.js')
    return withLongConnection((session) =>
      underSessionAppLock(
        session,
        { resource: MIGRATION_LOCK_NAME, timeoutMs: config.MIGRATION_LOCK_TIMEOUT_MS },
        migrateLatestFreeingStaleLock
      )
    )
  }
  const acquired = await acquireMigrationLock(config.MIGRATION_LOCK_TIMEOUT_MS)
  if (!acquired) {
    throw new Error(
      `Could not acquire the migration advisory lock within ${config.MIGRATION_LOCK_TIMEOUT_MS}ms — another instance may be stuck mid-migration.`
    )
  }
  try {
    return await migrateLatestFreeingStaleLock()
  } finally {
    await releaseMigrationLock()
  }
}

/**
 * knex takes a row lock in nivaro_migrations_lock for the batch and frees it
 * in a finally — which a SIGTERM/SIGKILL mid-migration never reaches. The
 * lock then outlives its process, and EVERY later boot of every instance on
 * that database dies "Migration table is already locked" until someone runs
 * migrate:unlock by hand (2026-09-22: dev API down for an hour, staging one
 * deploy away from the same). A genuine in-progress migration on another
 * instance is the only reason to wait, so wait MIGRATION_LOCK_STALE_MS for it,
 * then free the lock loudly and run. The migrations themselves are guarded
 * (hasTable / IF NOT EXISTS), so a second runner re-applies nothing.
 */
async function migrateLatestFreeingStaleLock(): Promise<[number, string[]]> {
  return (await migrateFreeingStaleLock({
    latest: () => db.migrate.latest(),
    forceFree: () => db.migrate.forceFreeMigrationsLock(),
    budgetMs: config.MIGRATION_LOCK_STALE_MS
  })) as [number, string[]]
}

export type Database = typeof db
