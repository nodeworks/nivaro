/**
 * Record-grid editor saves that never write over someone else (realtime gaps
 * R1, 2026-11-17). The grid showed "Beth is editing" but never her saved
 * values, its save overwrote them with no warning, and the row total was
 * summed from the months it had loaded — so a save after hers stored a wrong
 * total. Now:
 *
 * - the rows are live (the grid's queries carry `liveQueryMeta`), the draft
 *   overlay stays on top;
 * - a row's PATCH carries only the cells the person changed, plus the
 *   revision that row was at when they started editing it (`_base_revision`,
 *   pinned at the first edit — a live refresh moving the read-time base
 *   forward must not let a stale cell through);
 * - the server answers 409 per conflicting cell; those cells stay in the
 *   draft, marked with the value someone else saved, until the person keeps
 *   theirs (saves again, now against the newer revision) or takes the other;
 * - the total is summed by the server (`_sum_into`) from the row as stored.
 */

import type { NivaroClient } from '@nivaro/sdk'
import { type RowBaseBook, rowBaseBookFor, writeLineGuarded } from './item-edit/line-midair'

/** Someone else's saved value per conflicting cell: rowKey → field → their value. */
export type GridConflicts = Record<string, Record<string, unknown>>

/** The PATCH body for one saved row: only the cells that differ from the row
 *  as shown (a typed-then-reverted cell is no edit — sending it would collide
 *  with a newer save of that cell for nothing), numbers as numbers, and the
 *  total left to the server. Null = nothing to write. */
export function gridRowPatch(
  draft: Record<string, string>,
  record: Record<string, unknown>,
  writable: (field: string) => boolean,
  total?: { field: string; of: string[] } | null
): Record<string, unknown> | null {
  const body: Record<string, unknown> = {}
  for (const [f, v] of Object.entries(draft)) {
    if (!writable(f)) continue
    const was = record[f] == null ? '' : String(record[f])
    if (v === was) continue
    if (v !== '' && was !== '' && Number(v) === Number(was)) continue
    body[f] = v === '' ? null : Number.isNaN(Number(v)) ? v : Number(v)
  }
  if (Object.keys(body).length === 0) return null
  if (total && total.of.length > 0) body._sum_into = { field: total.field, of: total.of }
  return body
}

/** What a row's draft keeps after a 409: only the conflicting cells' edits
 *  are judged by the person — the whole row's write was refused, so every
 *  cell of it stays unsaved. */
export function conflictsOf(
  rowKey: string,
  conflicts: Array<{ field: string; current_value: unknown }>
): GridConflicts {
  const cells: Record<string, unknown> = {}
  for (const c of conflicts) cells[c.field] = c.current_value
  return { [rowKey]: cells }
}

/** "Take theirs": the conflicting cells leave the draft (the row shows the
 *  newer saved value); the rest of the row's edit stays. */
export function takeTheirs(
  draft: Record<string, Record<string, string>>,
  conflicts: GridConflicts
): Record<string, Record<string, string>> {
  const next = { ...draft }
  for (const [rowKey, cells] of Object.entries(conflicts)) {
    const row = { ...(next[rowKey] ?? {}) }
    for (const f of Object.keys(cells)) delete row[f]
    if (Object.keys(row).length === 0) delete next[rowKey]
    else next[rowKey] = row
  }
  return next
}

/**
 * One grid's guarded writes. `pin` the row's base at the person's first edit
 * of it; `write` PATCHes it against that base (or the read-time one); a 409
 * re-pins to the newer revision, so the next Save is a choice made against it.
 */
export class GridRowGuard {
  private pins = new Map<string, Promise<number | null> | number>()
  private book: RowBaseBook
  constructor(
    private client: Pick<NivaroClient, 'request'>,
    private collection: string
  ) {
    this.book = rowBaseBookFor(client, collection)
  }

  /** Every read of the rows: their read-time bases (one batched read). */
  noteRows(rows: Array<Record<string, unknown>>): void {
    this.book.noteRows(rows)
  }

  /** The person started editing this row: its base is the row they see now. */
  pin(rowId: string): void {
    if (!rowId || this.pins.has(rowId)) return
    this.pins.set(rowId, this.book.baseOf(rowId))
  }

  /** Drop pins (after a save that landed, a discard or a scope change). */
  release(rowIds?: Iterable<string>): void {
    if (!rowIds) this.pins.clear()
    else for (const id of rowIds) this.pins.delete(id)
  }

  async write(
    rowId: string,
    body: Record<string, unknown>
  ): Promise<
    { ok: true } | { ok: false; conflicts: Array<{ field: string; current_value: unknown }> }
  > {
    const r = await writeLineGuarded(
      this.client,
      this.book,
      `/items/${this.collection}/${rowId}`,
      rowId,
      body,
      { key: this.collection, label: `#${rowId}`, base: this.pins.get(rowId) }
    )
    if (r.ok) {
      this.pins.delete(rowId)
      return { ok: true }
    }
    if (r.conflict.latest > 0) this.pins.set(rowId, r.conflict.latest)
    return { ok: false, conflicts: r.conflict.conflicts }
  }
}
