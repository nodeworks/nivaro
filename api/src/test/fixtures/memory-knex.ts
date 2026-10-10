/**
 * A tiny in-memory stand-in for the knex query builder, for route tests that
 * want real reads-after-writes without a database. It covers what the session
 * replay routes use: where (object / column-value / column-op-value), whereIn,
 * whereNull, orderBy (column or list), limit, select, first, insert, update,
 * del / delete, count — and `db.schema.hasTable`. Joins are not supported.
 */
type Row = Record<string, unknown>

export interface MemoryKnex {
  (table: string): Builder
  tables: Record<string, Row[]>
  schema: { hasTable: (t: string) => Promise<boolean> }
  raw: (sql: string, binds?: unknown[]) => { sql: string; binds?: unknown[] }
  fn: { now: () => Date }
}

type Pred = (r: Row) => boolean

const norm = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : v)
const eq = (a: unknown, b: unknown) =>
  a instanceof Date || b instanceof Date
    ? new Date(a as never).getTime() === new Date(b as never).getTime()
    : norm(a) === norm(b) || (a != null && b != null && String(a) === String(b))

class Builder implements PromiseLike<unknown> {
  private preds: Pred[] = []
  private order: Array<{ column: string; order: 'asc' | 'desc' }> = []
  private max: number | null = null
  private cols: string[] | null = null
  private op: 'select' | 'first' = 'select'

  constructor(
    private readonly db: MemoryKnex,
    private readonly table: string
  ) {}

  private rows(): Row[] {
    this.db.tables[this.table] ??= []
    return this.db.tables[this.table]
  }

  where(a: unknown, b?: unknown, c?: unknown): this {
    if (typeof a === 'function') {
      ;(a as (q: this) => void)(this)
    } else if (a && typeof a === 'object') {
      for (const [k, v] of Object.entries(a as Row)) this.preds.push((r) => eq(r[k], v))
    } else if (c === undefined) {
      this.preds.push((r) => eq(r[String(a)], b))
    } else {
      const col = String(a)
      const op = String(b)
      this.preds.push((r) => {
        const x = r[col] as number
        const y = c as number
        if (op === '>') return x > y
        if (op === '>=') return x >= y
        if (op === '<') return x < y
        if (op === '<=') return x <= y
        if (op === '!=' || op === '<>') return !eq(x, y)
        return eq(x, y)
      })
    }
    return this
  }
  andWhere(a: unknown, b?: unknown, c?: unknown): this {
    return this.where(a, b, c)
  }
  whereIn(col: string, vals: unknown[]): this {
    this.preds.push((r) => vals.some((v) => eq(r[col], v)))
    return this
  }
  whereNull(col: string): this {
    this.preds.push((r) => r[col] == null)
    return this
  }
  whereNotNull(col: string): this {
    this.preds.push((r) => r[col] != null)
    return this
  }
  orderBy(
    col: string | Array<{ column: string; order?: 'asc' | 'desc' }>,
    dir: 'asc' | 'desc' = 'asc'
  ): this {
    if (Array.isArray(col))
      for (const c of col) this.order.push({ column: c.column, order: c.order ?? 'asc' })
    else this.order.push({ column: col, order: dir })
    return this
  }
  limit(n: number): this {
    this.max = n
    return this
  }
  modify(fn: (q: this) => void): this {
    fn(this)
    return this
  }
  select(...cols: Array<string | string[]>): this {
    const flat = cols.flat().filter((c) => typeof c === 'string') as string[]
    this.cols = flat.length > 0 ? flat : null
    return this
  }
  first(...cols: Array<string | string[]>): Promise<Row | undefined> {
    this.select(...cols)
    this.op = 'first'
    return this.run() as Promise<Row | undefined>
  }

  private matching(): Row[] {
    let out = this.rows().filter((r) => this.preds.every((p) => p(r)))
    if (this.order.length > 0) {
      out = [...out].sort((a, b) => {
        for (const o of this.order) {
          const x = a[o.column] as number
          const y = b[o.column] as number
          if (x === y) continue
          const c = x < y ? -1 : 1
          return o.order === 'desc' ? -c : c
        }
        return 0
      })
    }
    if (this.max != null) out = out.slice(0, this.max)
    return out
  }

  private project(r: Row): Row {
    if (!this.cols) return { ...r }
    const out: Row = {}
    for (const c of this.cols) {
      const [src, alias] = c.split(/\s+as\s+/i)
      const key = src.includes('.') ? src.split('.').pop()! : src
      out[alias ?? key] = r[key]
    }
    return out
  }

  private async run(): Promise<unknown> {
    const rows = this.matching().map((r) => this.project(r))
    return this.op === 'first' ? rows[0] : rows
  }

  async insert(row: Row | Row[]): Promise<unknown[]> {
    const list = Array.isArray(row) ? row : [row]
    const ids: unknown[] = []
    for (const r of list) {
      const copy = { ...r }
      if (copy.id === undefined) copy.id = this.rows().length + 1
      this.rows().push(copy)
      ids.push({ id: copy.id })
    }
    return ids
  }
  returning(): this {
    return this
  }
  async update(patch: Row): Promise<number> {
    const hit = this.rows().filter((r) => this.preds.every((p) => p(r)))
    for (const r of hit) Object.assign(r, patch)
    return hit.length
  }
  async del(): Promise<number> {
    const all = this.rows()
    const keep = all.filter((r) => !this.preds.every((p) => p(r)))
    const n = all.length - keep.length
    this.db.tables[this.table] = keep
    return n
  }
  delete(): Promise<number> {
    return this.del()
  }

  // biome-ignore lint/suspicious/noThenProperty: a knex builder is awaited directly, so this one is too
  then<A, B>(
    ok?: ((v: unknown) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null
  ): Promise<A | B> {
    return this.run().then(ok, bad)
  }
}

export function memoryKnex(tables: Record<string, Row[]> = {}): MemoryKnex {
  const db = ((table: string) =>
    new Builder(db, table.split(/\s+as\s+/i)[0].trim())) as unknown as MemoryKnex
  db.tables = tables
  db.schema = { hasTable: async (t: string) => t in db.tables }
  db.raw = (sql: string, binds?: unknown[]) => ({ sql, binds })
  db.fn = { now: () => new Date() }
  return db
}
