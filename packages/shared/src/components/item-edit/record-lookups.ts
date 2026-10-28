// Which per-record lookups (the viewer's role, the record's pipeline state)
// the last opened record of each collection needed. The record form asks for
// those at entry, in parallel with the layout read, instead of after the
// layout says it needs them (one round trip less on the record-page
// waterfall). Per tab; a wrong guess costs one cached read, never a wrong form.

export type RecordLookups = { role: boolean; state: boolean }

const MAX_COLLECTIONS = 200
const needs = new Map<string, RecordLookups>()

export function rememberRecordLookups(collection: string, want: RecordLookups): void {
  needs.delete(collection)
  needs.set(collection, { role: want.role, state: want.state })
  if (needs.size > MAX_COLLECTIONS) {
    const oldest = needs.keys().next().value
    if (oldest !== undefined) needs.delete(oldest)
  }
}

export function recordLookupsFor(collection: string): RecordLookups | null {
  const got = needs.get(collection)
  return got && (got.role || got.state) ? got : null
}

/** Tests only. */
export function resetRecordLookups(): void {
  needs.clear()
}
