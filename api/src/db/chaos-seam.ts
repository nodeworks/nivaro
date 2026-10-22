/**
 * The database fault point (#1773): the ONE place every statement passes — the driver
 * prototype's `_query`, which the main pool, the background pool and every transaction share.
 * While no database fault is armed this is a single null check per statement.
 *
 * Attached BEFORE the metadata read cache (db/metadata-query-cache.ts), so a configuration read
 * the cache answers never reaches the database and is never slowed or failed — exactly like a
 * slow or failing server, which only the statements that go there feel.
 *
 * The fault logic loads lazily (services/chaos/db-point.ts imports the registry and the request
 * trace, which must not load while db/index.ts is still initialising); nothing can be armed
 * before it has loaded.
 */

type QueryObj = { sql?: string }
type Driver = { _query: (connection: unknown, query: QueryObj) => Promise<QueryObj> }
type DbChaosFn = (sql: string) => { delay_ms: number; error: Error | null } | null

const PATCHED = Symbol.for('nivaro.chaosSeam')

let dbChaos: DbChaosFn | null = null

/** Tests: set the decision directly (null = none). */
export function _setDbChaosForTests(fn: DbChaosFn | null): void {
  dbChaos = fn
}

function load(): void {
  import('../services/chaos/db-point.js')
    .then((m) => {
      dbChaos = m.dbChaos
    })
    .catch(() => {
      /* chaos stays off */
    })
}

export function attachChaosSeam(
  knexInstance: { client?: unknown },
  opts: { lazy?: boolean } = {}
): void {
  const client = knexInstance.client as Driver | undefined
  if (!client) return
  const proto = Object.getPrototypeOf(client) as Driver & { [PATCHED]?: boolean }
  if (!proto || proto[PATCHED] || typeof proto._query !== 'function') return
  proto[PATCHED] = true
  const original = proto._query
  proto._query = function chaosQuery(this: Driver, connection: unknown, query: QueryObj) {
    const decide = dbChaos
    if (decide === null) return original.call(this, connection, query)
    const c = decide(typeof query?.sql === 'string' ? query.sql : '')
    if (!c) return original.call(this, connection, query)
    const run = () => (c.error ? Promise.reject(c.error) : original.call(this, connection, query))
    if (c.delay_ms <= 0) return run()
    return new Promise<void>((r) => setTimeout(r, c.delay_ms)).then(run)
  }
  if (opts.lazy !== false) load()
}
