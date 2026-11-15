import { serverClockOffset } from './server-clock'

/**
 * "This record changed since you opened it, and you have not seen it" (rt3 #14) — the client
 * half. Live events on a record page all end the same way: the surface re-reads its data
 * (the record's fields, a grid's lines, a file list). So "what this page has shown" is the log
 * of those reads: each successful read of a record surface marks everything that surface holds
 * as seen up to the moment the read STARTED (server time).
 *
 * At a move press the page asks the server what others changed since it first read the record
 * (`GET /records/:c/:id/unseen`), and drops every change a later read of the same surface
 * already brought on screen. What is left — a live event that never arrived, a procedure that
 * wrote without announcing, a collapsed grid that never refreshed — is listed in the confirm.
 */

/** Which surface a change (or a read) belongs to. */
export type SeenScope = 'field' | `lines:${string}` | `files:${string}`

export interface SeenMark {
  scope: SeenScope
  /** Server epoch ms the read started. */
  at: number
}

export interface UnseenChange {
  kind: 'field' | 'lines' | 'files'
  scope: SeenScope
  at: string
  by: string
  field?: string
  label: string
  from?: string | null
  to?: string | null
  text?: string
}

/** Reads within this of a change still count as having shown it (clock jitter). */
export const SEEN_SKEW_MS = 1000

/** The surface a record-page query reads, or null when it is not one of this record's. */
export function scopeOfQueryKey(
  key: readonly unknown[],
  collection: string,
  itemId: string
): SeenScope | null {
  if (!Array.isArray(key) || key.length < 3) return null
  const head = key[0]
  if ((head === 'item' || head === 'rrv-record') && key[1] === collection)
    return String(key[2]) === itemId ? 'field' : null
  if (head === 'o2m-rows' && typeof key[1] === 'string' && String(key[3]) === itemId)
    return `lines:${key[1]}`
  if (head === 'm2m-items' && typeof key[1] === 'string' && String(key[3]) === itemId)
    return `files:${key[1]}`
  return null
}

/** The changes no later read of their surface brought on screen (newest first, as given). */
export function filterUnseen(
  changes: UnseenChange[],
  marks: SeenMark[],
  skewMs = SEEN_SKEW_MS
): UnseenChange[] {
  return changes.filter((c) => {
    const at = Date.parse(c.at)
    if (!Number.isFinite(at)) return true
    return !marks.some((m) => m.scope === c.scope && m.at >= at - skewMs)
  })
}

/** Server time for a client epoch ms. */
export const toServerTime = (clientMs: number) => clientMs + serverClockOffset()

/**
 * One record page's read log. `observe` is fed every query-cache event; `seed` takes the
 * surfaces already in the cache when the log starts (their last read time, less a second —
 * a finished read started a little before it ended).
 */
export class SeenLog {
  private starts = new Map<string, number>()
  private marks: SeenMark[] = []
  private first: number | null = null

  constructor(
    readonly collection: string,
    readonly itemId: string
  ) {}

  seed(queries: Array<{ queryKey: readonly unknown[]; dataUpdatedAt: number }>): void {
    for (const q of queries) {
      const scope = scopeOfQueryKey(q.queryKey, this.collection, this.itemId)
      if (!scope || !q.dataUpdatedAt) continue
      this.mark(scope, toServerTime(q.dataUpdatedAt) - 1000)
    }
  }

  /** A read of `hash` started (client ms). */
  started(hash: string, clientMs = Date.now()): void {
    this.starts.set(hash, toServerTime(clientMs))
  }

  /** A read of `hash` (for `queryKey`) finished well. */
  succeeded(hash: string, queryKey: readonly unknown[], clientMs = Date.now()): void {
    const scope = scopeOfQueryKey(queryKey, this.collection, this.itemId)
    const at = this.starts.get(hash) ?? toServerTime(clientMs) - 1000
    this.starts.delete(hash)
    if (scope) this.mark(scope, at)
  }

  mark(scope: SeenScope, at: number): void {
    if (this.first == null || at < this.first) this.first = at
    this.marks.push({ scope, at })
    // Keep the newest read per surface — older ones never decide anything the newest does not.
    const newest = new Map<SeenScope, SeenMark>()
    for (const m of this.marks) {
      const cur = newest.get(m.scope)
      if (!cur || m.at > cur.at) newest.set(m.scope, m)
    }
    this.marks = [...newest.values()]
  }

  /** When the page first read the record (server ms), or null before any read. */
  since(): number | null {
    return this.first
  }

  /** The newest read of the record's own fields (server ms). */
  fieldsSince(): number | null {
    return this.marks.find((m) => m.scope === 'field')?.at ?? null
  }

  all(): SeenMark[] {
    return [...this.marks]
  }
}
