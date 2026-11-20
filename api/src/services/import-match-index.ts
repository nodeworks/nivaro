import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { sqlDialect } from '../db/sql-dialect.js'
import { whereInList } from './db-batch.js'
import { type MatchKind, matchCellKey, matchKeyOf, matchUsable } from './import-match.js'
import { onMssql, textKindOf } from './search-like.js'

/**
 * Existing records a collection import matches against, read in batches instead of one
 * `SELECT * WHERE field = @value` per row (86k statements for the EFP warehouse_inventory file).
 *
 * The run prefetches the candidates of each ~500-row chunk (`prefetch`), keyed in memory by the
 * shared rule (import-match.ts matchKeyOf), and tells the index about every record it creates or
 * updates (`note`), so a later row of the same file finds a record an earlier row made. The
 * preview and row repair use the same index, so all three agree on what matches.
 *
 * Reads select only `id` and the match fields. A chunk is read by its most varied match field
 * (`IN` list, one OPENJSON parameter from 50 values on SQL Server, cast to varchar for a varchar
 * column so the column keeps its index); tuples blank in that field are read by the next field
 * with that field blank — `IS NULL OR = ''` for text — and so on.
 */

/** Values per `IN` list. */
export const MATCH_PREFETCH_CHUNK = 500

type Row = Record<string, unknown>

export class ImportMatchIndex {
  private readonly byKey = new Map<string, Set<string>>()
  /** Tuple keys already asked of the database (their answer is in byKey). */
  private readonly asked = new Set<string>()
  /** Keys a record with an unreadable id was written under: looked up in the database again. */
  private readonly unsure = new Set<string>()

  private constructor(
    private readonly collection: string,
    readonly fields: string[],
    readonly kinds: MatchKind[],
    private readonly ansi: ReadonlySet<string>
  ) {}

  /** The index for one collection's match fields; `kinds` from matchKindOf, one per field. */
  static async open(
    collection: string,
    fields: string[],
    kinds: MatchKind[]
  ): Promise<ImportMatchIndex> {
    const ansi = new Set<string>()
    if (onMssql() && fields.some((_f, i) => kinds[i] === 'text')) {
      try {
        const info = (await db(collection).columnInfo()) as Record<string, { type?: string }>
        for (const [col, meta] of Object.entries(info ?? {}))
          if (textKindOf(meta?.type) === 'ansi') ansi.add(col.toLowerCase())
      } catch {
        /* unknown column types: the plain IN list */
      }
    }
    return new ImportMatchIndex(collection, fields, kinds, ansi)
  }

  keyOf(values: unknown[]): string {
    return matchKeyOf(values, this.kinds)
  }

  usable(values: unknown[]): boolean {
    return this.fields.length > 0 && matchUsable(values, this.kinds)
  }

  /** Record ids whose match fields equal these values (0, 1, or 2+ = ambiguous). */
  async lookup(values: unknown[]): Promise<string[]> {
    const key = this.keyOf(values)
    if (!this.asked.has(key) || this.unsure.has(key)) {
      this.unsure.delete(key)
      await this.prefetch([values], true)
    }
    return [...(this.byKey.get(key) ?? [])]
  }

  /** A record this run created or updated now carries these values. */
  note(id: unknown, values: unknown[]): void {
    const key = this.keyOf(values)
    if (id == null) {
      this.unsure.add(key)
      return
    }
    this.add(key, String(id))
  }

  private add(key: string, id: string): void {
    const set = this.byKey.get(key) ?? new Set<string>()
    set.add(id)
    this.byKey.set(key, set)
  }

  /** Read the candidates of these tuples (the ones not asked yet) into the index. */
  async prefetch(tuples: unknown[][], force = false): Promise<void> {
    const todo: unknown[][] = []
    const seen = new Set<string>()
    for (const t of tuples) {
      if (!this.usable(t)) continue
      const key = this.keyOf(t)
      if (seen.has(key) || (!force && this.asked.has(key))) continue
      seen.add(key)
      todo.push(t)
    }
    if (todo.length === 0) return
    for (const t of todo) this.asked.add(this.keyOf(t))
    // Most varied field first: the narrowest IN list per tuple.
    const order = this.fields
      .map((f, i) => ({
        f,
        i,
        n: new Set(todo.map((t) => matchCellKey(t[i], this.kinds[i]))).size
      }))
      .sort((a, b) => b.n - a.n)
    const cols = [...new Set(['id', ...this.fields])]
    const walk = async (depth: number, subset: unknown[][], blanks: number[]): Promise<void> => {
      if (depth >= order.length || subset.length === 0) return
      const { f, i } = order[depth]
      const kind = this.kinds[i]
      const byCell = new Map<string, unknown>()
      for (const t of subset) {
        const k = matchCellKey(t[i], kind)
        if (k != null && !byCell.has(k)) byCell.set(k, t[i])
      }
      const values = [...byCell.values()]
      for (let at = 0; at < values.length; at += MATCH_PREFETCH_CHUNK) {
        const q = db(this.collection)
        this.inList(q, f, kind, values.slice(at, at + MATCH_PREFETCH_CHUNK))
        for (const b of blanks) this.blank(q, this.fields[b], this.kinds[b])
        const rows = (await q.select(cols)) as Row[]
        for (const r of rows) {
          if (r.id == null) continue
          this.add(this.keyOf(this.fields.map((g) => r[g])), String(r.id))
        }
      }
      await walk(
        depth + 1,
        subset.filter((t) => matchCellKey(t[i], kind) == null),
        [...blanks, i]
      )
    }
    await walk(0, todo, [])
  }

  private inList(q: Knex.QueryBuilder, col: string, kind: MatchKind, values: unknown[]): void {
    const mssql = onMssql()
    const list = values.map((v) =>
      v instanceof Date
        ? v.toISOString()
        : typeof v === 'boolean'
          ? mssql
            ? v
              ? 1
              : 0
            : v // a Postgres boolean column never equals 1 / 0
          : v
    ) as Array<string | number>
    // Postgres compares text case-sensitively; SQL Server's collation (and MySQL's) does not,
    // and the index keys text lower-cased — so Postgres matches on lower() both sides.
    if (kind === 'text' && !mssql && sqlDialect(db as unknown as Knex) === 'pg') {
      const lowered = list.map((v) => String(v).toLowerCase())
      q.whereRaw(`lower(??) IN (${lowered.map(() => '?').join(', ')})`, [col, ...lowered])
      return
    }
    // A varchar column against nvarchar values converts the column on every row (no seek).
    if (kind === 'text' && this.ansi.has(col.toLowerCase()) && onMssql()) {
      q.whereRaw('?? IN (SELECT CAST([value] AS varchar(8000)) FROM OPENJSON(?))', [
        col,
        JSON.stringify(list.map(String))
      ])
      return
    }
    whereInList(q, col, list)
  }

  /** The field is blank: NULL, and for text also '' (what the importer writes for a blank cell). */
  private blank(q: Knex.QueryBuilder, col: string, kind: MatchKind): void {
    if (kind === 'text') q.where((w) => w.whereNull(col).orWhere(col, ''))
    else q.whereNull(col)
  }
}
