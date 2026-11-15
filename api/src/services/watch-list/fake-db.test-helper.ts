/**
 * A tiny stand-in for knex in watch-list tests: `db(table)` returns a chain where every builder
 * method returns the chain, and awaiting it yields that table's rows (after an optional
 * filter the test supplies). Records which tables were read and with what `where` arguments.
 */
export type Rows = Array<Record<string, unknown>>

export function fakeDb(
  tables: Record<string, Rows | ((calls: unknown[][]) => Rows)>,
  log: Array<{ table: string; calls: unknown[][] }> = []
) {
  const make = (table: string) => {
    const calls: unknown[][] = []
    log.push({ table, calls })
    const chain: Record<string, unknown> = {}
    const methods = [
      'where',
      'whereIn',
      'whereNot',
      'whereNull',
      'whereNotNull',
      'whereRaw',
      'orderBy',
      'limit',
      'select',
      'distinct',
      'groupBy',
      'max',
      'as',
      'update',
      'andWhere'
    ]
    for (const m of methods)
      chain[m] = (...a: unknown[]) => {
        calls.push([m, ...a])
        return chain
      }
    chain.client = { config: { client: 'mssql' } }
    const rows = () => {
      const t = tables[table]
      return typeof t === 'function' ? t(calls) : (t ?? [])
    }
    chain.first = async () => rows()[0]
    chain.catch = (fn: (e: unknown) => unknown) => Promise.resolve(rows()).catch(fn)
    // biome-ignore lint/suspicious/noThenProperty: the fake must be awaitable like a knex builder
    chain.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
      Promise.resolve(rows()).then(ok, bad)
    return chain
  }
  const db = Object.assign((t: string) => make(t.split(' ')[0]), {
    raw: async () => [],
    from: () => make('__from__')
  })
  return db
}

/** The value a fake `where(col, value)` or `where({col: value})` call named. */
export function whereValue(calls: unknown[][], col: string): unknown {
  for (const c of calls) {
    if (c[0] !== 'where') continue
    if (typeof c[1] === 'object' && c[1] && col in (c[1] as object))
      return (c[1] as Record<string, unknown>)[col]
    if (c[1] === col) return c[2]
  }
  return undefined
}
