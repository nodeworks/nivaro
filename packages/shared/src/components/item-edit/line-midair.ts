/**
 * Mid-air collision for LINES (army4 a10-3 / H4 / M1).
 *
 * A child row's write carries the revision the person's view of that row was
 * based on (`_base_revision`); the server's mid-air check (services/items.ts)
 * then answers 409 MIDAIR_COLLISION when someone else's newer save touched
 * the same field, instead of silently writing over it.
 *
 * The base is the row's newest revision WHEN THE ROWS WERE READ — one
 * `GET /revisions/latest` per grid read (RowBaseBook), never at first edit
 * (a save by someone else between load and first edit would otherwise become
 * the base, and the stale value would win). When a base is unknown it is
 * fetched before the write, never skipped.
 */

import type { NivaroClient } from '@nivaro/sdk'
import type { QueryClient } from '@tanstack/react-query'
import { get, patch } from '../../lib/commands'
import { midairCollisionOf } from '../../lib/record-outbox'

/** A line's PATCH body with the revision the edit was based on. No known base
 *  (null, 0 = "row has no revision yet") = the body as before: the server only
 *  judges a base > 0. */
export function withRowBaseRevision(
  body: Record<string, unknown>,
  base: number | null | undefined
): Record<string, unknown> {
  if (typeof base !== 'number' || !Number.isFinite(base) || base <= 0) return body
  return { ...body, _base_revision: base }
}

/** One line whose write met someone else's newer save (409). */
export interface LineCollision {
  /** `<relatedCollection>.<manyField>` — the staging key. */
  key: string
  rowId: string
  /** "Line 3" — what the chooser calls it. */
  label: string
  conflicts: Array<{ field: string; current_value: unknown }>
  latest: number
  mine: Record<string, unknown>
}

/** The chooser's id for one field of one line (the header dialog keys by field). */
export function lineConflictKey(c: Pick<LineCollision, 'key' | 'rowId'>, field: string): string {
  return `${c.key}\u0000${c.rowId}\u0000${field}`
}

/** A line's edit after the person picked "Theirs" for some fields: those
 *  fields leave the edit (the line keeps the newer saved value), the rest
 *  stay. Null when nothing the person changed is left (the change reason and
 *  the early-flush marker alone are not an edit; staged grandchild ops are). */
export function resolveLineCollision(
  changes: Record<string, unknown>,
  theirs: Set<string>
): Record<string, unknown> | null {
  const next: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(changes)) if (!theirs.has(k)) next[k] = v
  const real = Object.keys(next).some((k) => k !== '_change_reason' && k !== '__flush_early')
  return real ? next : null
}

/** "Line 3" for a row: its line number when the grid's rows carry one, else
 *  its position, else its id. */
export function lineLabelOf(
  rows: Array<Record<string, unknown>>,
  rowId: string,
  orderField?: string | null
): string {
  const i = rows.findIndex((r) => String(r.id) === String(rowId))
  const row = i >= 0 ? rows[i] : undefined
  const n = row?.[orderField || 'line_number'] ?? row?.line_number
  if (n != null && n !== '') return `Line ${String(n)}`
  return i >= 0 ? `Line ${i + 1}` : `Row ${rowId}`
}

/** The ids one `GET /revisions/latest` may carry (the route's cap). */
export const LATEST_BATCH = 500

/** Whether an API error says the route does not exist (an older API). */
function isMissingRoute(err: unknown): boolean {
  const e = err as { status?: number; response?: { status?: number } } | null
  return (e?.status ?? e?.response?.status) === 404
}

/** Per record id, its newest revision id — null = readable, no revision yet.
 *  An id the caller cannot read (or a failed read) is absent from the map.
 *  One batched read per 500 ids; an API without `/revisions/latest` falls
 *  back to one `latest_only` read per id (at most 4 at once). */
export async function fetchLatestRevisions(
  client: Pick<NivaroClient, 'request'>,
  collection: string,
  ids: Array<string | number>
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>()
  const list = [...new Set(ids.map(String))].filter(
    (id) => id && id !== 'new' && !id.startsWith('pending:')
  )
  for (let i = 0; i < list.length; i += LATEST_BATCH) {
    const chunk = list.slice(i, i + LATEST_BATCH)
    try {
      const r = await client.request<{ data: Record<string, number | null> }>(
        get('/revisions/latest', { collection, items: chunk.join(',') })
      )
      for (const [id, latest] of Object.entries(r?.data ?? {})) {
        out.set(id, typeof latest === 'number' && Number.isFinite(latest) ? latest : null)
      }
    } catch (err) {
      if (!isMissingRoute(err)) continue
      let next = 0
      const worker = async () => {
        while (next < chunk.length) {
          const id = chunk[next++]
          try {
            const r = await client.request<{ data: { latest: number | null } }>(
              get('/revisions', { collection, item: id, latest_only: '1' })
            )
            const latest = r?.data?.latest
            out.set(id, typeof latest === 'number' && Number.isFinite(latest) ? latest : null)
          } catch {
            /* unreadable / failed: absent */
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, chunk.length) }, worker))
    }
  }
  return out
}

/** A stable text for "the row as read" — a changed row needs a new base. */
function rowSignature(row: Record<string, unknown>): string {
  try {
    return JSON.stringify(row)
  } catch {
    return String(Math.random())
  }
}

type Fetcher = (ids: string[]) => Promise<Map<string, number | null>>

/**
 * The bases of one grid's saved rows, taken when the rows were READ. Each
 * read hands its rows to `noteRows`; a row read before with the same content
 * keeps its base (what the person sees is still that revision), a new or
 * changed row gets a fresh one — every such row of one read in ONE batched
 * request. `baseOf` answers the base for a write: the read-time one, or —
 * when none is known — one fetched now, before the write (never skipped).
 */
export class RowBaseBook {
  private entries = new Map<
    string,
    { sig: string; base: Promise<number | null>; settled?: number | null }
  >()
  constructor(private fetcher: Fetcher) {}

  private put(id: string, sig: string, base: Promise<number | null>): void {
    const entry: { sig: string; base: Promise<number | null>; settled?: number | null } = {
      sig,
      base
    }
    this.entries.set(id, entry)
    void base.then((b) => {
      entry.settled = b
    })
  }

  /** Record a read of these rows. */
  noteRows(rows: Array<Record<string, unknown>>): void {
    const fresh: Array<{ id: string; sig: string }> = []
    for (const r of rows) {
      const id = r?.id == null ? '' : String(r.id)
      if (!id || id === 'new' || id.startsWith('pending:')) continue
      const sig = rowSignature(r)
      if (this.entries.get(id)?.sig === sig) continue
      fresh.push({ id, sig })
    }
    if (fresh.length === 0) return
    const batch = this.fetcher(fresh.map((f) => f.id)).catch(() => new Map<string, number | null>())
    for (const f of fresh) {
      this.put(
        f.id,
        f.sig,
        batch.then((m) => (m.has(f.id) ? (m.get(f.id) ?? null) : null))
      )
    }
  }

  /** The base for a write to this row — read-time when known, else fetched
   *  now. Null = the row has no revision (or could not be read). */
  async baseOf(id: string): Promise<number | null> {
    const known = this.entries.get(id)
    if (known) {
      const b = await known.base
      if (b != null) return b
    }
    const m = await this.fetcher([id]).catch(() => new Map<string, number | null>())
    const b = m.get(id) ?? null
    if (b != null) this.set(id, b)
    return b
  }

  /** The read-time base of a row, if a read noted it (undefined = never read). */
  peek(id: string): Promise<number | null> | undefined {
    return this.entries.get(id)?.base
  }

  /** The read-time base once its read answered (sync; undefined = not yet). */
  settled(id: string): number | null | undefined {
    return this.entries.get(id)?.settled
  }

  /** After a 409: the person's next write is a choice made against `latest`. */
  set(id: string, base: number): void {
    const sig = this.entries.get(id)?.sig ?? ''
    const entry = { sig, base: Promise.resolve(base), settled: base as number | null }
    this.entries.set(id, entry)
  }

  /** After the person's own write: the next read brings the new base. */
  forget(id: string): void {
    this.entries.delete(id)
  }
}

const books = new WeakMap<object, Map<string, RowBaseBook>>()

/** The ONE book per (client, child collection): the record form (fed by
 *  every `['o2m-rows', …]` read of its lines) and each grid share it, so a
 *  read is batched once and every write path — staged or immediate — judges
 *  a line against the same read-time base. Entries are per row id; a read of
 *  a subset (a filtered grid) never evicts other rows. */
export function rowBaseBookFor(
  client: Pick<NivaroClient, 'request'>,
  collection: string
): RowBaseBook {
  let byCollection = books.get(client)
  if (!byCollection) {
    byCollection = new Map()
    books.set(client, byCollection)
  }
  let book = byCollection.get(collection)
  if (!book) {
    book = new RowBaseBook((ids) => fetchLatestRevisions(client, collection, ids))
    byCollection.set(collection, book)
  }
  return book
}

/** A line write that met someone else's newer save, with where it went. */
export type LineConflict = LineCollision & { url: string }

/** Write one saved line NOW against its read-time base (H4). `ok` = written;
 *  otherwise the 409 as a line collision (the book then holds the newer
 *  revision, so a "Mine" re-save is a choice made against it). Any other
 *  error is thrown. */
export async function writeLineGuarded(
  client: Pick<NivaroClient, 'request'>,
  book: RowBaseBook,
  url: string,
  rowId: string,
  body: Record<string, unknown>,
  meta: { key: string; label: string }
): Promise<{ ok: true } | { ok: false; conflict: LineConflict }> {
  const base = await book.baseOf(rowId)
  try {
    await client.request(patch(url, withRowBaseRevision(body, base)))
  } catch (err) {
    const coll = midairCollisionOf(err)
    if (!coll) throw err
    if (coll.latest > 0) book.set(rowId, coll.latest)
    return {
      ok: false,
      conflict: {
        key: meta.key,
        rowId,
        label: meta.label,
        conflicts: coll.conflicts,
        latest: coll.latest,
        mine: body,
        url
      }
    }
  }
  book.forget(rowId)
  return { ok: true }
}

/** Add `delta` to a number field of one record, conflict-safe (H4: the
 *  auto-allocate increment). The base revision is read BEFORE the value, so
 *  any save landing after the value read is a 409 — then both are read again,
 *  up to `tries` times. False = it kept changing (or is gone): nothing was
 *  written. Never a blind read-modify-write. */
export async function incrementGuarded(
  client: Pick<NivaroClient, 'request'>,
  collection: string,
  id: string,
  field: string,
  delta: number,
  tries = 3
): Promise<boolean> {
  for (let attempt = 0; attempt < tries; attempt++) {
    const bases = await fetchLatestRevisions(client, collection, [id])
    const fresh = await client
      .request<{ data: Record<string, unknown> | null }>(
        get(`/items/${collection}/${id}`, { fields: `id,${field}` })
      )
      .then((r) => r?.data ?? null)
    if (!fresh) return false
    try {
      await client.request(
        patch(
          `/items/${collection}/${id}`,
          withRowBaseRevision({ [field]: (Number(fresh[field]) || 0) + delta }, bases.get(id))
        )
      )
      return true
    } catch (err) {
      if (!midairCollisionOf(err)) throw err
    }
  }
  return false
}

/** Feed every read of one record's lines (`['o2m-rows', rc, mf, parentId,
 *  …]` — any grid kind) into the shared book (M1): the bases are those of
 *  the rows as READ. Notes what is cached now, then every successful read.
 *  Returns the unsubscribe. */
export function noteLineReads(
  qc: QueryClient,
  client: Pick<NivaroClient, 'request'>,
  parentId: string
): () => void {
  const note = (key: readonly unknown[], data: unknown) => {
    if (key[0] !== 'o2m-rows' || String(key[3]) !== parentId || typeof key[1] !== 'string') return
    if (!Array.isArray(data)) return
    rowBaseBookFor(client, key[1]).noteRows(data as Array<Record<string, unknown>>)
  }
  const cache = qc.getQueryCache()
  for (const q of cache.findAll({ queryKey: ['o2m-rows'] })) note(q.queryKey, q.state.data)
  return cache.subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success') return
    note(event.query.queryKey, event.query.state.data)
  })
}
