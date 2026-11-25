import { AsyncLocalStorage } from 'node:async_hooks'
import { isAbsolute } from 'node:path'
import knex, { type Knex } from 'knex'
import { tenantSource } from '../services/deployment-mode.js'
import { normaliseSslMode } from './connection-url.js'
import { mssqlUrlConnection } from './mssql-url-connection.js'
import { mysqlFlavorConfig } from './mysql-flavor.js'
import { MYSQL_SESSION_SQL, mysqlTypeCast } from './mysql-session.js'
import { openSqliteTenantKnex, releaseSqliteTenantFile } from './sqlite-tenant.js'
import { sqlSslOption } from './tls-options.js'

// Per-request tenant store — populated by the tenant middleware in cloud mode.
// Self-hosted: store is never written; getTenantDb() returns undefined; db falls back to static.
export interface TenantStore {
  db: Knex
  slug: string
  tenantId: string // immutable UUID — used as R2 prefix so slug changes never cause collisions
  /** The tenant's VERIFIED origin (verifiedTenantOrigin): its own subdomain host or active
   *  custom domain when the request came on one, else its canonical origin. What
   *  `tenantOrigin()` answers; unset for work entered without a request (then: canonical). */
  origin?: string
}

const store = new AsyncLocalStorage<TenantStore>()

// Shared pool map — one Knex instance per connection string, never recreated.
const pools = new Map<string, Knex>()

/** Connections per tenant pool. The heavy-read gate (services/read-gate.ts)
 *  sizes a tenant's limit from it. */
export const TENANT_POOL_MAX = 5

/** `max` (a tenant's own pool size) defaults to TENANT_POOL_MAX; it applies when the pool is
 *  first created for the connection string. */
export function getOrCreateTenantPool(
  connectionString: string,
  client = 'pg',
  max: number = TENANT_POOL_MAX
): Knex {
  // SQLite is one file owned by one process (db/sqlite.ts): never a Nivaro Cloud tenant's
  // database. A Hub shared deployment of one process serves SQLite apps, each its own file in its
  // own folder (db/sqlite-tenant.ts; the path is checked again when the pool opens).
  if (/sqlite/i.test(client)) {
    if (tenantSource() !== 'hub')
      throw new Error('A cloud tenant cannot use SQLite: provision SQL Server, Postgres or MySQL.')
    let pool = pools.get(connectionString)
    if (!pool) {
      pool = openSqliteTenantKnex(connectionString, max)
      pools.set(connectionString, pool)
    }
    return pool
  }
  // A MariaDB tenant ('mariadb') runs on knex's mysql2 client, marked (db/mysql-flavor.ts).
  const mariadb = client === 'mariadb'
  if (mariadb) client = 'mysql2'
  if (!pools.has(connectionString)) {
    pools.set(
      connectionString,
      /mysql/i.test(client)
        ? // MySQL tenants read and write DATETIME as UTC and read booleans as true / false,
          // like db/index.ts's own pools.
          knex({
            client,
            ...mysqlFlavorConfig(mariadb),
            connection: {
              ...mysqlTenantTls(connectionString),
              timezone: 'Z',
              typeCast: mysqlTypeCast
            } as never,
            pool: {
              min: 0,
              max,
              afterCreate: (
                conn: { query: (sql: string, cb: (err: Error | null) => void) => void },
                done: (err: Error | null, c: unknown) => void
              ) => conn.query(MYSQL_SESSION_SQL, (err) => done(err, conn))
            }
          })
        : knex({
            client,
            // A SQL Server URL with options as an object: as a string its options reach tedious
            // as text (encrypt=false → "false", refused). db/mssql-url-connection.ts.
            connection:
              (/mssql/i.test(client) ? mssqlUrlConnection(connectionString) : null) ??
              connectionString,
            pool: { min: 0, max }
          })
    )
  }
  return pools.get(connectionString)!
}

/**
 * Close the pool of one connection string and forget it (a SQLite app's database file a move
 * replaces: db/sqlite-tenant.ts). The next use opens a new pool. A SQLite file's lock is released
 * once the pool is destroyed.
 */
export async function closeTenantPool(connectionString: string): Promise<void> {
  const pool = pools.get(connectionString)
  pools.delete(connectionString)
  try {
    if (pool) await pool.destroy()
  } finally {
    if (isAbsolute(connectionString) && /\.(sqlite|sqlite3|db)$/.test(connectionString))
      releaseSqliteTenantFile(connectionString)
  }
}

/**
 * mysql2 reads `?ssl=<json>` from a URI but silently ignores libpq/MySQL-style `sslmode=` /
 * `ssl-mode=` — a tenant URL carrying one connected in plain text. Those two parameters are
 * taken out and turned into mysql2's `ssl` option (db/tls-options.ts). A URL without them is
 * passed through exactly as before.
 */
export function mysqlTenantTls(connectionString: string): { uri: string; ssl?: unknown } {
  let u: URL
  try {
    u = new URL(connectionString)
  } catch {
    return { uri: connectionString }
  }
  const key = ['sslmode', 'ssl-mode', 'ssl_mode'].find((k) => u.searchParams.has(k))
  if (!key) return { uri: connectionString }
  const { mode } = normaliseSslMode(u.searchParams.get(key) ?? '')
  for (const k of ['sslmode', 'ssl-mode', 'ssl_mode']) u.searchParams.delete(k)
  const ca = u.searchParams.get('ssl-ca') ?? u.searchParams.get('sslrootcert') ?? undefined
  u.searchParams.delete('ssl-ca')
  u.searchParams.delete('sslrootcert')
  if (!mode) return { uri: u.toString() }
  return { uri: u.toString(), ssl: sqlSslOption('mysql2', { DB_SSL_MODE: mode, DB_SSL_CA: ca }) }
}

/** Run `done` (Fastify lifecycle callback) within the ALS context for this tenant.
 *  All async operations initiated from `done` inherit the context automatically. */
export function runWithTenantDb(
  tenantDb: Knex,
  slug: string,
  done: () => void,
  tenantId = '',
  origin?: string
): void {
  store.run({ db: tenantDb, slug, tenantId, ...(origin ? { origin } : {}) }, done)
}

/** Run `fn` as a tenant (its pool, slug, id and optional verified origin) outside a request:
 *  crons, flows and the Hub's per-app jobs. The context ends when `fn` settles. */
export function withTenant<T>(
  t: { id: string; slug: string; dbClient: string; dbConnection: string; poolMax: number | null },
  fn: () => Promise<T>,
  origin?: string
): Promise<T> {
  const db = getOrCreateTenantPool(t.dbConnection, t.dbClient, t.poolMax ?? undefined)
  return store.run({ db, slug: t.slug, tenantId: t.id, ...(origin ? { origin } : {}) }, fn)
}

/** Returns the tenant Knex instance for the current request, or undefined in self-hosted mode. */
export function getTenantDb(): Knex | undefined {
  return store.getStore()?.db
}

/** Returns the tenant slug for the current request, or undefined in self-hosted mode. */
export function getTenantSlug(): string | undefined {
  return store.getStore()?.slug
}

/** Returns the tenant UUID for the current request — used as R2 key prefix (immutable, slug-change-safe). */
export function getTenantId(): string | undefined {
  return store.getStore()?.tenantId || store.getStore()?.slug // fallback to slug for backwards compat
}

/** The verified origin the current tenant's request carries (cloud), or undefined. */
export function getTenantOrigin(): string | undefined {
  return store.getStore()?.origin
}

/**
 * A request's tenant host as the tenant middleware reads it (X-Tenant-Host, X-Forwarded-Host,
 * Host — any of them may be a list): the first entry, lower case, a bare host name with an
 * optional port. Anything else is null.
 */
export function cleanTenantHost(raw: string | string[] | undefined | null): string | null {
  const v = (Array.isArray(raw) ? raw[0] : raw)?.split(',')[0]?.trim().toLowerCase()
  if (!v || v.length > 255) return null
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/.test(v)
    ? v
    : null
}

/** A local development host: served over plain http. */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9.-]+\.localhost)(:\d+)?$/

/** The domain tenant subdomains live under (`<subdomain>.<base>`): CLOUD_BASE_DOMAIN, default
 *  nivaro.dev. */
export function cloudBaseDomain(): string {
  return (process.env.CLOUD_BASE_DOMAIN || 'nivaro.dev').trim().toLowerCase().replace(/^\.+/, '')
}

const originOf = (host: string) => `${LOCAL_HOST.test(host) ? 'http' : 'https'}://${host}`

/** A tenant's canonical origin: `https://<subdomain>.<CLOUD_BASE_DOMAIN>`. */
export function canonicalTenantOrigin(subdomain: string): string {
  return originOf(`${subdomain.toLowerCase()}.${cloudBaseDomain()}`)
}

/**
 * The origin to name for a tenant a request resolved: the tenant's own `<subdomain>.<base>` when
 * the request came on it, or its ACTIVE custom domain (meta row) when the cloud worker named it
 * in X-Tenant-Custom-Host (`customHost`; the caller passes it only beside X-Tenant-Host), else
 * the canonical origin. A made-up host that happens to resolve to the tenant
 * (`acme.attacker.example`), a pending or another domain, is never echoed.
 */
export function verifiedTenantOrigin(
  rawHost: string | string[] | undefined | null,
  row: {
    slug: string
    subdomain?: string | null
    custom_domain?: string | null
    custom_domain_status?: string | null
  },
  customHost?: string | string[] | null
): string {
  const sub = String(row.subdomain || row.slug)
  const canonical = canonicalTenantOrigin(sub)
  const custom = cleanTenantHost(customHost)
  const registered = cleanTenantHost(row.custom_domain)
  if (custom && registered && row.custom_domain_status === 'active' && custom === registered)
    return originOf(custom)
  const host = cleanTenantHost(rawHost)
  if (host && host === `${sub.toLowerCase()}.${cloudBaseDomain()}`) return originOf(host)
  return canonical
}

/**
 * The origin the current tenant is served on — its verified origin, else (work outside a
 * request: crons, flows, timers) its canonical origin from the slug — or null outside any
 * tenant. Cloud code that names "this instance" uses this, never PUBLIC_URL (the shared
 * process's own).
 *
 * A Hub shared deployment (Hub phase 6) has no canonical origin: `<slug>.<CLOUD_BASE_DOMAIN>` is
 * a Nivaro Cloud host, never the app's. A context opened there without an origin (a captured
 * context re-entered later: catalog-impact, raw-write-announcer, related-announce) answers null,
 * and callers fall back to the configured address. Nivaro Cloud is unchanged.
 */
export function tenantOrigin(): string | null {
  const st = store.getStore()
  if (!st) return null
  if (st.origin) return st.origin
  if (tenantSource() === 'hub') return null
  return st.slug ? canonicalTenantOrigin(st.slug) : null
}

/** Run `fn` outside any tenant context — work flushed from a timer an earlier
 *  tenant's request armed must not inherit that tenant (#1875). */
export function runWithoutTenant<T>(fn: () => T): T {
  return store.exit(fn)
}
