// ─── How a staged child line is named in the record's change list ────────────
// The record's "N changes" review names a staged line edit by its line number;
// a grid whose rows have none (a PlanGrid's year rows) used to fall back to the
// row id ("row 7917890" — army 9 b03 N4, Rob's no-internal-ids rule). A grid
// that knows how people name its rows registers a labeler for its child
// collection while it is mounted; the change list asks `stagedRowLabel` and
// only falls back to a plain "a line" — never an id.

type Labeler = (rowId: string) => string | null

const labelers = new Map<string, Set<Labeler>>()

/** Register `fn` for `collection` (the grid's child collection). Returns the
 *  unregister call for the grid's effect cleanup. */
export function registerStagedRowLabel(collection: string, fn: Labeler): () => void {
  const set = labelers.get(collection) ?? new Set<Labeler>()
  set.add(fn)
  labelers.set(collection, set)
  return () => {
    set.delete(fn)
    if (set.size === 0) labelers.delete(collection)
  }
}

/** The name a mounted grid gives this row, or null when none knows it. */
export function stagedRowLabel(collection: string, rowId: string): string | null {
  for (const fn of labelers.get(collection) ?? []) {
    const label = fn(rowId)
    if (label?.trim()) return label
  }
  return null
}
