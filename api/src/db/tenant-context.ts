import { AsyncLocalStorage } from 'node:async_hooks'
import knex, { type Knex } from 'knex'

// Per-request tenant DB store — populated by the tenant middleware in cloud mode.
// Self-hosted: store is never written, getTenantDb() returns undefined, db falls back to static.
const store = new AsyncLocalStorage<Knex>()

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

/** Run `done` (Fastify lifecycle callback) within the ALS context for this tenant's DB.
 *  All async operations initiated from `done` inherit the context automatically. */
export function runWithTenantDb(tenantDb: Knex, done: () => void): void {
  store.run(tenantDb, done)
}

/** Returns the tenant DB for the current request, or undefined in self-hosted mode. */
export function getTenantDb(): Knex | undefined {
  return store.getStore()
}
