/**
 * A knex-shaped fake for the session replay clip / share route tests.
 *
 * Every `db(table)` call is a fresh chain that records its builder calls in
 * `log`; awaiting it answers by what it did — `insert` → `inserted[table]`,
 * `update` / `del` / `delete` → 1, anything else → `rows[table]`. `.first()`
 * answers `first[table]` (a value, or a function of the chain's calls).
 * `db.transaction(fn)` runs fn with the same fake.
 */

export type Call = [string, unknown[]]
export interface ChainLog {
  table: string
  calls: Call[]
}

export interface FakeTables {
  rows?: Record<string, unknown[] | ((calls: Call[]) => unknown[])>
  first?: Record<string, unknown | ((calls: Call[]) => unknown)>
  inserted?: Record<string, unknown[]>
}

export function fakeDb(tables: FakeTables) {
  const log: ChainLog[] = []
  const resolveRows = (table: string, calls: Call[]): unknown => {
    const did = (m: string) => calls.some(([c]) => c === m)
    if (did('insert')) return tables.inserted?.[table] ?? []
    if (did('update') || did('del') || did('delete')) return 1
    const r = tables.rows?.[table]
    return typeof r === 'function' ? r(calls) : (r ?? [])
  }
  const dbFn = (table: string) => {
    const entry: ChainLog = { table, calls: [] }
    log.push(entry)
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === 'then') {
            const p = Promise.resolve(resolveRows(table, entry.calls))
            return p.then.bind(p)
          }
          if (prop === 'first') {
            return (...a: unknown[]) => {
              entry.calls.push(['first', a])
              const f = tables.first?.[table]
              return Promise.resolve(typeof f === 'function' ? f(entry.calls) : f)
            }
          }
          return (...a: unknown[]) => {
            entry.calls.push([prop, a])
            return proxy
          }
        }
      }
    )
    return proxy
  }
  const transaction = async (fn: (trx: typeof dbFn) => Promise<unknown>) => fn(dbFn)
  /** Arguments of the first call to `method` on chains of `table`, in order. */
  const callsOf = (table: string, method: string): unknown[][] =>
    log
      .filter((l) => l.table === table)
      .flatMap((l) => l.calls.filter(([m]) => m === method).map(([, a]) => a))
  return { dbFn, transaction, log, callsOf }
}

/** `where({ x: v })` / `where('x', v)` value on a chain's calls. */
export function whereValue(calls: Call[], key: string): unknown {
  for (const [m, a] of calls) {
    if (m !== 'where' && m !== 'andWhere') continue
    if (a[0] && typeof a[0] === 'object' && key in (a[0] as object)) {
      return (a[0] as Record<string, unknown>)[key]
    }
    if (a[0] === key) return a.length === 3 ? a[2] : a[1]
  }
  return undefined
}
