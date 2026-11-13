/**
 * Record change notices, in process.
 *
 * Every change the API tells open pages about passes broadcastCollectionUpdate
 * (services/realtime.ts): a write through the items service, a record aspect
 * (`$state` when a pipeline moves, `$addendums`, …), an announced raw write
 * (a procedure, an import, a rollup recalc — `source: 'raw'`, `item: '*'` when
 * it names no record). A hook on the items service sees only the first kind,
 * so a cache an extension keeps over records went stale on the others until
 * its TTL ran out.
 *
 * Listeners here hear the same value-free notice (ids and field NAMES, never
 * values) in the process that made the change, in that request's context. Each
 * change is announced once, by its writer — other replicas do not repeat it —
 * so a listener that drops shared (Redis) entries runs once per change.
 *
 * A notice is a hint to drop or refresh, not a record of the write: it carries
 * no row, and a deleted record cannot be read back from it.
 *
 * Leaf module: imports nothing of the app.
 */

export interface RecordChangeNotice {
  collection: string
  /** The record id, or '*' for "records in this collection changed". */
  item: string | number
  /** Set for a write; absent for a record aspect. */
  action?: 'create' | 'update' | 'delete'
  /** Field names, or `$`-named aspects (`$state`, `$addendums`, `$comments`, `$tasks`, `$lock`…). */
  changed_fields?: string[]
  /** 'raw' = written outside the items service (no hooks ran); 'import' = a staged import
   *  writing through it. */
  source?: 'raw' | 'import'
  /** With item '*': how many records the write touched. */
  bulk?: number
}

export type RecordChangeListener = (notice: RecordChangeNotice) => unknown

interface Entry {
  fn: RecordChangeListener
  owner?: string
  disabled?: boolean
}

let entries: Entry[] = []

/** Hear every notice. `owner` (an extension id) lets it be paused and forgotten with its owner. */
export function onRecordChangeNotice(fn: RecordChangeListener, owner?: string): () => void {
  const entry: Entry = { fn, owner }
  entries.push(entry)
  return () => {
    entries = entries.filter((e) => e !== entry)
  }
}

export function setRecordChangeOwnerEnabled(owner: string, enabled: boolean): void {
  for (const e of entries) if (e.owner === owner) e.disabled = !enabled
}

export function forgetRecordChangeListeners(owner: string): void {
  entries = entries.filter((e) => e.owner !== owner)
}

/** How many listeners there are — the broadcast builds no notice for nobody. */
export function recordChangeListenerCount(): number {
  return entries.length
}

/** A listener that throws or rejects never reaches the write that announced the change. */
export function emitRecordChangeNotice(notice: RecordChangeNotice): void {
  for (const e of entries) {
    if (e.disabled) continue
    try {
      const r = e.fn(notice)
      if (r && typeof (r as Promise<unknown>).catch === 'function')
        (r as Promise<unknown>).catch(() => undefined)
    } catch {
      /* a listener never breaks the broadcast */
    }
  }
}

/** Tests only. */
export function _resetRecordChangeListeners(): void {
  entries = []
}
