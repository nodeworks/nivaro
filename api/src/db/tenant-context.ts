import { AsyncLocalStorage } from 'node:async_hooks'
import knex, { type Knex } from 'knex'

// Per-request tenant store — populated by the tenant middleware in cloud mode.
// Self-hosted: store is never written; getTenantDb() returns undefined; db falls back to static.
export interface TenantStore {
  db: Knex
  slug: string
  tenantId: string  // immutable UUID — used as R2 prefix so slug changes never cause collisions
}

const store = new AsyncLocalStorage<TenantStore>()

// Shared pool map — one Knex instance per connection string, never recreated.
const pools = new Map<string, Knex>()

export function getOrCreateTenantPool(connectionString: string, client = 'pg'): Knex {
  if (!pools.has(connectionString)) {
    pools.set(
      connectionString,
      knex({ client, connection: connectionString, pool: { min: 0, max: 5 } })
    )
  }
  return pools.get(connectionString)!
}

/** Run `done` (Fastify lifecycle callback) within the ALS context for this tenant.
 *  All async operations initiated from `done` inherit the context automatically. */
export function runWithTenantDb(tenantDb: Knex, slug: string, done: () => void, tenantId = ''): void {
  store.run({ db: tenantDb, slug, tenantId }, done)
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
  return store.getStore()?.tenantId || store.getStore()?.slug  // fallback to slug for backwards compat
}
