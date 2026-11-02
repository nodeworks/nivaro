import { AsyncLocalStorage } from 'node:async_hooks'
import knex, { type Knex } from 'knex'

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

export function getOrCreateTenantPool(connectionString: string, client = 'pg'): Knex {
  if (!pools.has(connectionString)) {
    pools.set(
      connectionString,
      knex({ client, connection: connectionString, pool: { min: 0, max: TENANT_POOL_MAX } })
    )
  }
  return pools.get(connectionString)!
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
 * The origin to name for a tenant a request resolved: the request host only when it is the
 * tenant's own `<subdomain>.<base>` or its ACTIVE custom domain (meta row), else the canonical
 * origin. A made-up host that happens to resolve to the tenant (`acme.attacker.example`) is
 * never echoed.
 */
export function verifiedTenantOrigin(
  rawHost: string | string[] | undefined | null,
  row: {
    slug: string
    subdomain?: string | null
    custom_domain?: string | null
    custom_domain_status?: string | null
  }
): string {
  const sub = String(row.subdomain || row.slug)
  const canonical = canonicalTenantOrigin(sub)
  const host = cleanTenantHost(rawHost)
  if (!host) return canonical
  if (host === `${sub.toLowerCase()}.${cloudBaseDomain()}`) return originOf(host)
  const custom = cleanTenantHost(row.custom_domain)
  if (custom && row.custom_domain_status === 'active' && host === custom) return originOf(host)
  return canonical
}

/**
 * The origin the current tenant is served on — its verified origin, else (work outside a
 * request: crons, flows, timers) its canonical origin from the slug — or null outside any
 * tenant. Cloud code that names "this instance" uses this, never PUBLIC_URL (the shared
 * process's own).
 */
export function tenantOrigin(): string | null {
  const st = store.getStore()
  if (!st) return null
  if (st.origin) return st.origin
  return st.slug ? canonicalTenantOrigin(st.slug) : null
}

/** Run `fn` outside any tenant context — work flushed from a timer an earlier
 *  tenant's request armed must not inherit that tenant (#1875). */
export function runWithoutTenant<T>(fn: () => T): T {
  return store.exit(fn)
}
