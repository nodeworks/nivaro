// ─── Where a context row came from ───────────────────────────────────────────
// buildContext / buildContextBatch / expandContextRows read rows for an action's `context`
// (and a payload template's lookups). A payload template's field map may read past what those
// reads loaded — `materials[].cifa_data.task.name`, where the expand loaded two columns of the
// CIFA and nothing of its task. The payload-template hop loader (payload-templates/hops.ts)
// fills such paths, and needs to know each row's collection and whether the row holds every
// column (a `select *` row) or only the listed ones (an expand / hop row).
//
// A WeakMap, not a property on the row: rows are rendered whole (Liquid `json`, a `json` field
// type), so nothing may be added to them; and a tag never outlives its row.

export type RowSource = {
  collection: string
  /** Only some columns were read (an expand's `fields`): a missing column may exist. */
  partial: boolean
}

const sources = new WeakMap<object, RowSource>()

/** Tag rows read from `collection` (objects only; anything else is ignored). */
export function tagRows(rows: unknown, collection: string, partial: boolean): void {
  const list = Array.isArray(rows) ? rows : [rows]
  for (const r of list) {
    if (r !== null && typeof r === 'object' && !Array.isArray(r)) {
      sources.set(r, { collection, partial })
    }
  }
}

/** The collection a context row was read from, when a context read tagged it. */
export function rowSource(row: unknown): RowSource | null {
  return row !== null && typeof row === 'object' ? (sources.get(row) ?? null) : null
}
