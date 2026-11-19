/**
 * A tiny in-memory stand-in for the knex calls the collection importer makes: `db(table)` with
 * where (object / column, value), whereIn, whereNull, orderBy, limit, select, first, update,
 * insert (+ returning) and delete. Every builder is a thenable, so `await db(t).where(...)` reads
 * rows like knex does. Rows are plain objects held per table; Dates compare by instant.
 *
 * `hooks.beforeInsert(table, row)` may throw (a refused row) or change state mid-run;
 * `writes` keeps every update / insert / delete for assertions.
 */
type Row = Record<string, unknown>
type Pred = (r: Row) => boolean

export interface MemoryDb {
  (table: string): Builder
  tables: Map<string, Row[]>
  writes: Array<{ table: string; op: 'update' | 'insert' | 'delete'; data: Row; count: number }>
  hooks: { beforeInsert?: (table: string, row: Row) => void }
  rows(table: string): Row[]
  reset(): void
}

const same = (a: unknown, b: unknown): boolean => {
  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : new Date(a as string).getTime()
    const tb = b instanceof Date ? b.getTime() : new Date(b as string).getTime()
    return ta === tb
  }
  return a === b || (a != null && b != null && String(a) === String(b))
}

class Builder implements PromiseLike<unknown> {
  private preds: Pred[] = []
  private order: Array<[string, 'asc' | 'desc']> = []
  private max: number | null = null
  private cols: string[] | null = null
  private mode: 'many' | 'first' = 'many'

  constructor(
    private readonly mem: MemoryDb,
    private readonly table: string
  ) {}

  private all(): Row[] {
    let t = this.mem.tables.get(this.table)
    if (!t) {
      t = []
      this.mem.tables.set(this.table, t)
    }
    return t
  }

  where(a: string | Row, b?: unknown): this {
    if (typeof a === 'string') this.preds.push((r) => same(r[a], b))
    else for (const [k, v] of Object.entries(a)) this.preds.push((r) => same(r[k], v))
    return this
  }
  whereIn(col: string, vals: unknown[]): this {
    this.preds.push((r) => vals.some((v) => same(r[col], v)))
    return this
  }
  whereNull(col: string): this {
    this.preds.push((r) => r[col] == null)
    return this
  }
  orderBy(col: string, dir: 'asc' | 'desc' = 'asc'): this {
    this.order.push([col, dir])
    return this
  }
  limit(n: number): this {
    this.max = n
    return this
  }
  select(...cols: Array<string | string[]>): this {
    const flat = cols.flat()
    this.cols = flat.length && !flat.includes('*') ? flat : null
    return this
  }
  first(...cols: string[]): this {
    this.mode = 'first'
    if (cols.length) this.cols = cols
    return this
  }

  private matched(): Row[] {
    return this.all().filter((r) => this.preds.every((p) => p(r)))
  }

  private read(): unknown {
    let rows = this.matched()
    for (const [col, dir] of [...this.order].reverse()) {
      rows = [...rows].sort((a, b) => {
        const x = a[col] instanceof Date ? (a[col] as Date).getTime() : (a[col] as number)
        const y = b[col] instanceof Date ? (b[col] as Date).getTime() : (b[col] as number)
        return (x > y ? 1 : x < y ? -1 : 0) * (dir === 'desc' ? -1 : 1)
      })
    }
    if (this.max != null) rows = rows.slice(0, this.max)
    const pick = (r: Row) =>
      this.cols ? Object.fromEntries(this.cols.map((c) => [c, r[c]])) : { ...r }
    return this.mode === 'first' ? (rows[0] ? pick(rows[0]) : undefined) : rows.map(pick)
  }

  async update(patch: Row): Promise<number> {
    const rows = this.matched()
    for (const r of rows) Object.assign(r, patch)
    this.mem.writes.push({ table: this.table, op: 'update', data: patch, count: rows.length })
    return rows.length
  }

  async delete(): Promise<number> {
    const t = this.all()
    const rows = this.matched()
    for (const r of rows) t.splice(t.indexOf(r), 1)
    this.mem.writes.push({ table: this.table, op: 'delete', data: {}, count: rows.length })
    return rows.length
  }
  del(): Promise<number> {
    return this.delete()
  }

  insert(row: Row | Row[]): InsertChain {
    return new InsertChain(this.mem, this.table, this.all(), Array.isArray(row) ? row : [row])
  }

  // biome-ignore lint/suspicious/noThenProperty: a knex builder is awaited like a promise
  then<A = unknown, B = never>(
    ok?: ((v: unknown) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null
  ): PromiseLike<A | B> {
    return Promise.resolve()
      .then(() => this.read())
      .then(ok, bad)
  }
  catch<B = never>(bad: (e: unknown) => B | PromiseLike<B>): Promise<unknown> {
    return Promise.resolve(this.then(undefined, bad))
  }
}

class InsertChain implements PromiseLike<unknown> {
  constructor(
    private readonly mem: MemoryDb,
    private readonly table: string,
    private readonly target: Row[],
    private readonly rows: Row[]
  ) {}
  private ret: string | null = null
  returning(col: string): this {
    this.ret = col
    return this
  }
  private run(): unknown {
    const out: Row[] = []
    for (const r of this.rows) {
      this.mem.hooks.beforeInsert?.(this.table, r)
      const row = { ...r }
      if (row.id == null) row.id = this.target.length + 1
      this.target.push(row)
      out.push(row)
    }
    this.mem.writes.push({
      table: this.table,
      op: 'insert',
      data: this.rows[0] ?? {},
      count: this.rows.length
    })
    return this.ret ? out.map((r) => ({ [this.ret as string]: r[this.ret as string] })) : [1]
  }
  // biome-ignore lint/suspicious/noThenProperty: a knex builder is awaited like a promise
  then<A = unknown, B = never>(
    ok?: ((v: unknown) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null
  ): PromiseLike<A | B> {
    return Promise.resolve()
      .then(() => this.run())
      .then(ok, bad)
  }
}

export function makeMemoryDb(): MemoryDb {
  const mem = ((table: string) => new Builder(mem, table)) as MemoryDb
  mem.tables = new Map()
  mem.writes = []
  mem.hooks = {}
  mem.rows = (table) => {
    let t = mem.tables.get(table)
    if (!t) {
      t = []
      mem.tables.set(table, t)
    }
    return t
  }
  mem.reset = () => {
    mem.tables.clear()
    mem.writes.length = 0
    mem.hooks = {}
  }
  return mem
}
