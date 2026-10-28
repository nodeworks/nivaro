/**
 * An in-memory stand-in for `db` (db/index.js) for the managed-procedure tests: the two config
 * tables plus import definitions, enough of knex's builder for the store and the owner answer.
 *
 * Use it from a test with
 *   vi.mock('../../../../db/index.js', async () => ({ db: (await import('./fake-store.js')).fakeDb }))
 * and `resetFakeStore()` in beforeEach. Rules it keeps, as SQL Server would:
 *   - string comparisons in where() are case-insensitive (default collation);
 *   - `increments` ids are assigned on insert and never supplied;
 *   - unique keys (name; procedure_id + version) refuse a duplicate with error number 2627;
 *   - update()/del() resolve to the affected row count;
 *   - db.transaction() undoes its own writes when its callback throws (rows other writers added
 *     meanwhile survive; identity values are not reused, as in SQL Server).
 * Any db.raw() the fake does not know throws, so a test sees unexpected SQL.
 */

type Row = Record<string, unknown>

const MANAGED = 'nivaro_managed_procedures'
const VERSIONS = 'nivaro_managed_procedure_versions'
const IMPORTS = 'nivaro_import_definitions'

const UNIQUE: Record<string, string[][]> = {
  [MANAGED]: [['name']],
  [VERSIONS]: [['procedure_id', 'version']]
}

export const fakeStore = {
  tables: new Map<string, Row[]>(),
  nextId: new Map<string, number>(),
  /** Every raw() call, for assertions. */
  raw: [] as Array<{ sql: string; bindings: unknown[] }>,
  /** Called before each update() runs — lets a test interleave a concurrent writer. */
  beforeUpdate: null as null | ((table: string) => void)
}

export function resetFakeStore(): void {
  fakeStore.tables = new Map([
    [MANAGED, []],
    [VERSIONS, []],
    [IMPORTS, []]
  ])
  fakeStore.nextId = new Map()
  fakeStore.raw = []
  fakeStore.beforeUpdate = null
}
resetFakeStore()

/** The live rows of a table (mutable — tests may seed or inspect them). */
export function rowsOf(table: string): Row[] {
  let rows = fakeStore.tables.get(table)
  if (!rows) {
    rows = []
    fakeStore.tables.set(table, rows)
  }
  return rows
}

/** Insert a row directly (assigns an id when the row has none). */
export function seedRow(table: string, row: Row): Row {
  const full = { ...row }
  if (full.id == null) full.id = takeId(table)
  rowsOf(table).push(full)
  return full
}

function takeId(table: string): number {
  const used = rowsOf(table).reduce((m, r) => Math.max(m, Number(r.id) || 0), 0)
  const n = Math.max(fakeStore.nextId.get(table) ?? 1, used + 1)
  fakeStore.nextId.set(table, n + 1)
  return n
}

const same = (a: unknown, b: unknown) =>
  typeof a === 'string' && typeof b === 'string'
    ? a.toLowerCase() === b.toLowerCase()
    : a instanceof Date && b instanceof Date
      ? a.getTime() === b.getTime()
      : a === b

function uniqueViolation(table: string, candidate: Row, ignore?: Row): void {
  for (const cols of UNIQUE[table] ?? []) {
    const clash = rowsOf(table).some(
      (r) => r !== ignore && r !== candidate && cols.every((c) => same(r[c], candidate[c]))
    )
    if (clash) {
      const e = new Error(
        `Violation of UNIQUE KEY constraint on ${table} (${cols.join(', ')})`
      ) as Error & { number: number }
      e.number = 2627
      throw e
    }
  }
}

type Pred = (r: Row) => boolean

/** What one transaction changed, undone in reverse on rollback (other writers' rows survive). */
type Undo = Array<() => void>

function builder(table: string, undo?: Undo) {
  const preds: Pred[] = []
  let order: Array<{ col: string; dir: 'asc' | 'desc' }> = []
  let cols: string[] | null = null
  let lim: number | null = null

  const pick = (r: Row): Row => {
    if (!cols || cols.length === 0 || cols.includes('*')) return { ...r }
    const o: Row = {}
    for (const c of cols) o[c] = r[c]
    return o
  }
  const matching = () => rowsOf(table).filter((r) => preds.every((p) => p(r)))
  const result = () => {
    let rows = matching()
    if (order.length) {
      rows = [...rows].sort((a, b) => {
        for (const { col, dir } of order) {
          const x = a[col] as any
          const y = b[col] as any
          if (x === y) continue
          const c = x < y ? -1 : 1
          return dir === 'desc' ? -c : c
        }
        return 0
      })
    }
    if (lim != null) rows = rows.slice(0, lim)
    return rows.map(pick)
  }

  const q: any = {
    where(a: unknown, b?: unknown, c?: unknown) {
      if (typeof a === 'object' && a) {
        const obj = a as Row
        preds.push((r) => Object.entries(obj).every(([k, v]) => same(r[k], v)))
      } else if (c !== undefined) {
        const col = String(a)
        const op = String(b)
        preds.push((r) => {
          if (op === '=') return same(r[col], c)
          if (op === '!=' || op === '<>') return !same(r[col], c)
          if (op === '<') return (r[col] as any) < (c as any)
          if (op === '>') return (r[col] as any) > (c as any)
          throw new Error(`fake-store: operator ${op} not supported`)
        })
      } else {
        const col = String(a)
        preds.push((r) => same(r[col], b))
      }
      return q
    },
    andWhere(...args: unknown[]) {
      return (q.where as (...x: unknown[]) => unknown)(...args)
    },
    whereNull(col: string) {
      preds.push((r) => r[col] == null)
      return q
    },
    whereNotNull(col: string) {
      preds.push((r) => r[col] != null)
      return q
    },
    whereIn(col: string, vals: unknown[]) {
      preds.push((r) => vals.some((v) => same(r[col], v)))
      return q
    },
    orderBy(col: string | Array<{ column: string; order?: string }>, dir?: string) {
      if (Array.isArray(col)) {
        order = col.map((x) => ({
          col: x.column,
          dir: x.order === 'desc' ? 'desc' : 'asc'
        }))
      } else order.push({ col, dir: dir === 'desc' ? 'desc' : 'asc' })
      return q
    },
    select(...c: Array<string | string[]>) {
      cols = c.flat()
      return q
    },
    limit(n: number) {
      lim = n
      return q
    },
    forUpdate() {
      return q
    },
    first(...c: string[]) {
      if (c.length) cols = c
      return Promise.resolve(result()[0])
    },
    insert(input: Row | Row[]) {
      return Promise.resolve().then(() => {
        const list = Array.isArray(input) ? input : [input]
        const added: Row[] = []
        try {
          for (const r of list) {
            if (r.id != null) throw new Error(`fake-store: id supplied for ${table}`)
            const row = { ...r, id: takeId(table) }
            uniqueViolation(table, row)
            rowsOf(table).push(row)
            added.push(row)
            undo?.push(() => {
              const rows = rowsOf(table)
              const i = rows.indexOf(row)
              if (i >= 0) rows.splice(i, 1)
            })
          }
        } catch (e) {
          const rows = rowsOf(table)
          for (const a of added) rows.splice(rows.indexOf(a), 1)
          throw e
        }
        return added.map((a) => a.id)
      })
    },
    update(patch: Row) {
      return Promise.resolve().then(() => {
        fakeStore.beforeUpdate?.(table)
        const hits = matching()
        for (const r of hits) uniqueViolation(table, { ...r, ...patch }, r)
        for (const r of hits) {
          const prior = { ...r }
          Object.assign(r, patch)
          undo?.push(() => {
            for (const k of Object.keys(r)) delete r[k]
            Object.assign(r, prior)
          })
        }
        return hits.length
      })
    },
    del() {
      return Promise.resolve().then(() => {
        const hits = new Set(matching())
        const rows = rowsOf(table)
        const kept = rows.filter((r) => !hits.has(r))
        rows.splice(0, rows.length, ...kept)
        undo?.push(() => rowsOf(table).push(...hits))
        return hits.size
      })
    },
    // biome-ignore lint/suspicious/noThenProperty: a knex query builder is thenable
    then(res: (v: Row[]) => unknown, rej?: (e: unknown) => unknown) {
      return Promise.resolve()
        .then(() => result())
        .then(res, rej)
    }
  }
  q.delete = q.del
  return q
}

/** The `db` stand-in. */
export const fakeDb: any = (table: string) => builder(table)
fakeDb.schema = {
  hasTable: async (t: string) => fakeStore.tables.has(t)
}
fakeDb.raw = async (sql: string, bindings: unknown[] = []) => {
  fakeStore.raw.push({ sql, bindings })
  throw new Error(`fake-store: unexpected raw SQL: ${sql.slice(0, 80)}`)
}
fakeDb.transaction = async <T>(fn: (trx: any) => Promise<T>): Promise<T> => {
  const undo: Undo = []
  const trx: any = (table: string) => builder(table, undo)
  trx.schema = fakeDb.schema
  trx.raw = fakeDb.raw
  try {
    return await fn(trx)
  } catch (e) {
    for (const u of undo.reverse()) u()
    throw e
  }
}
