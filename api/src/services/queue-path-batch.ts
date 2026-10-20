/**
 * #1224 — read sharing for ONE resolve of a queue source's extra columns.
 *
 * A queue source configures its extra columns as independent paths
 * (`name`, `project.project_id`, `purchase_orders.number`, …) and every path
 * used to issue its own statements: on the Workflows queue (25 paths, ~500
 * rows) that was ~95 of the read's ~160 round trips — the same relations
 * lookup 25 times over, and one `select id, <col> from workflows where id in
 * (…500 ids…)` per plain column. The database runs those concurrent IN-list
 * reads roughly one after another, so their cost added up.
 *
 * A batch lives for one resolve and is handed down every path:
 *   - `relations()`: one in-flight lookup per collection, shared;
 *   - `rows()`: requests for the same collection AND the same id list that
 *     arrive before the next macrotask become ONE select of the union of
 *     their columns;
 *   - `once()`: identical statements (same descriptor + ids) share one result.
 *
 * Results are shared, never copied: callers only read the rows. Nothing is
 * kept past the batch, so no read is ever older than the request asking it.
 */
import type { CMSRelation } from '../types.js'

export type BatchRow = Record<string, unknown>

/** Reads `keyColumn`, `id` and `columns` of `collection` where `keyColumn`
 *  is in `keys` (no column is ever named twice). */
export type RowFetcher = (
  collection: string,
  keys: string[],
  columns: string[],
  keyColumn: string
) => Promise<BatchRow[]>

interface Waiter {
  columns: string[]
  resolve: (rows: BatchRow[]) => void
  reject: (err: unknown) => void
}

interface PendingRows {
  collection: string
  keyColumn: string
  ids: string[]
  columns: Set<string>
  waiters: Waiter[]
}

export class PathReadBatch {
  private readonly memo = new Map<string, Promise<unknown>>()
  private readonly pending = new Map<string, PendingRows>()
  private readonly relationsInflight = new Map<string, Promise<CMSRelation[]>>()
  /** Statements actually issued through rows() — for tests and traces. */
  rowStatements = 0

  constructor(
    private readonly fetchRows: RowFetcher,
    private readonly loadRelations: (collection: string) => Promise<CMSRelation[]>
  ) {}

  /**
   * Relations for `collection`, through the caller's per-resolve cache. Paths
   * resolving concurrently used to each miss that cache and fetch the same
   * rows; now the first miss's promise is shared. A failed lookup is not
   * remembered, so a later caller retries exactly as before.
   */
  relations(collection: string, cache: Map<string, CMSRelation[]>): Promise<CMSRelation[]> {
    const hit = cache.get(collection)
    if (hit) return Promise.resolve(hit)
    let p = this.relationsInflight.get(collection)
    if (!p) {
      p = this.loadRelations(collection).then(
        (rels) => {
          cache.set(collection, rels)
          this.relationsInflight.delete(collection)
          return rels
        },
        (err) => {
          this.relationsInflight.delete(collection)
          throw err
        }
      )
      this.relationsInflight.set(collection, p)
    }
    return p
  }

  /** Same key → the same promise for the life of this batch. */
  once<T>(key: string, run: () => Promise<T>): Promise<T> {
    let p = this.memo.get(key) as Promise<T> | undefined
    if (!p) {
      p = run()
      this.memo.set(key, p)
    }
    return p
  }

  /**
   * Rows of `collection` whose `keyColumn` (default `id`) is in `ids`, each
   * carrying `keyColumn`, `id` and `columns` (possibly more: the union every
   * joined request asked for).
   *
   * If the shared select fails — one path naming a column that no longer
   * exists — every request falls back to its own select, so only the bad
   * path fails, which is what the one-select-per-path code did.
   */
  rows(
    collection: string,
    ids: string[],
    columns: string[],
    keyColumn = 'id'
  ): Promise<BatchRow[]> {
    const want = columns.filter((c) => c !== 'id' && c !== keyColumn)
    const key = `${collection}\u0000${keyColumn}\u0000${ids.join('\u0001')}`
    let entry = this.pending.get(key)
    if (!entry) {
      entry = { collection, keyColumn, ids, columns: new Set(), waiters: [] }
      this.pending.set(key, entry)
      setImmediate(() => void this.flush(key))
    }
    for (const c of want) entry.columns.add(c)
    const e = entry
    return new Promise<BatchRow[]>((resolve, reject) => {
      e.waiters.push({ columns: want, resolve, reject })
    })
  }

  private async flush(key: string): Promise<void> {
    const entry = this.pending.get(key)
    if (!entry) return
    this.pending.delete(key)
    const { collection, keyColumn, ids, waiters } = entry
    const solo = (w: Waiter) => {
      this.rowStatements++
      this.fetchRows(collection, ids, w.columns, keyColumn).then(w.resolve, w.reject)
    }
    if (waiters.length === 1) {
      solo(waiters[0])
      return
    }
    try {
      this.rowStatements++
      const rows = await this.fetchRows(collection, ids, [...entry.columns], keyColumn)
      for (const w of waiters) w.resolve(rows)
    } catch {
      for (const w of waiters) solo(w)
    }
  }
}
