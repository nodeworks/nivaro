/**
 * Which connection pool the current async work borrows from (#1321).
 *
 * Interactive requests and background work (scheduled jobs, imports, cache
 * warms, backfills, digests) used to share ONE knex pool. A burst of crons or
 * the boot warm then held connections a person's dashboard was waiting for:
 * six dashboard calls after a deploy all read an identical ~3.3 s. Background
 * work now runs on its own pool (DB_POOL_BACKGROUND_MAX, default 10) so a
 * request never queues behind it.
 *
 * The switch is an AsyncLocalStorage flag, not a second import: `db` (the
 * proxy in db/index.ts) resolves the active knex on every call, so the
 * hundreds of services that `import { db }` route correctly without change.
 * Everything a background job awaits, including timers and promises it starts,
 * inherits the flag. A knex transaction is bound to the instance that opened
 * it, so it keeps one connection however the context changes inside it.
 *
 * Leaf module: no imports from db/index.ts (which imports this).
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export type PoolName = 'main' | 'background'

const store = new AsyncLocalStorage<PoolName>()

/** Run `fn` with every `db` call it makes on the background pool. */
export function runInBackgroundPool<T>(fn: () => T): T {
  if (store.getStore() === 'background') return fn()
  return store.run('background', fn)
}

/** Run `fn` on the main (interactive) pool even inside background work. */
export function runInMainPool<T>(fn: () => T): T {
  if (store.getStore() !== 'background') return fn()
  return store.run('main', fn)
}

/** The pool the current async context asked for ('main' outside any binding). */
export function requestedPool(): PoolName {
  return store.getStore() ?? 'main'
}

/** True inside work bound to the background pool. */
export function inBackgroundPool(): boolean {
  return store.getStore() === 'background'
}
