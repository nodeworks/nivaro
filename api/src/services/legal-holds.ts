import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Legal holds (migration 235, nivaro_legal_holds) as every purge reads them (#17).
 *
 * A record hold names collection + item_id; while released_at is NULL nothing a purge does may
 * remove that record's history: activity rows, revisions, trash rows, expired files linked to
 * it. Purges call `whereNotHeld` (one NOT EXISTS, no extra round trip) or `activeRecordHolds`.
 * A user hold (column `user`) exempts the person from user retention policies (retention.ts).
 */
export const HOLDS = 'nivaro_legal_holds'

const ready = new Map<string, { ok: boolean; at: number }>()
const heldCache = new Map<string, { at: number; set: Set<string> }>()
const HELD_TTL_MS = 30_000

export async function legalHoldsReady(): Promise<boolean> {
  const key = currentTenantKey()
  const hit = ready.get(key)
  if (hit && (hit.ok || Date.now() - hit.at < 60_000)) return hit.ok
  const ok = await db.schema.hasTable(HOLDS).catch(() => false)
  ready.set(key, { ok, at: Date.now() })
  return ok
}

/**
 * Narrow a purge query to records with no active hold. `collectionRef` / `itemRef` are the
 * OUTER query's column references (e.g. 'nivaro_activity.collection') — identifiers, never
 * request input. No-op when the holds table does not exist (pass `enabled` from
 * legalHoldsReady()).
 */
export function whereNotHeld(
  q: Knex.QueryBuilder,
  collectionRef: string,
  itemRef: string,
  enabled = true
): Knex.QueryBuilder {
  if (!enabled) return q
  return q.whereNotExists(function (this: Knex.QueryBuilder) {
    void this.select(db.raw('1'))
      .from(`${HOLDS} as lh`)
      .whereRaw('lh.collection = ??', [collectionRef])
      .whereRaw('lh.item_id = ??', [itemRef])
      .whereNull('lh.released_at')
  })
}

export interface RecordHold {
  collection: string
  item_id: string
}

/** Every active record hold (a purge that loops per record checks against this). */
export async function activeRecordHolds(): Promise<RecordHold[]> {
  if (!(await legalHoldsReady())) return []
  const rows = (await db(HOLDS)
    .whereNull('released_at')
    .whereNotNull('collection')
    .whereNotNull('item_id')
    .select('collection', 'item_id')) as RecordHold[]
  return rows.map((r) => ({ collection: String(r.collection), item_id: String(r.item_id) }))
}

/** Lookup key for a held record. Case-insensitive, as SQL Server compares the ids. */
export const holdKey = (collection: string, item: string | number): string =>
  `${collection.toLowerCase()}\u0000${String(item).toLowerCase()}`

/** Active holds as a lookup set of holdKey(collection, item). */
export async function heldRecordKeys(): Promise<Set<string>> {
  return new Set((await activeRecordHolds()).map((h) => holdKey(h.collection, h.item_id)))
}

/** Collections with at least one active record hold (cached 30 s per tenant). */
export async function heldCollections(): Promise<Set<string>> {
  const key = currentTenantKey()
  const hit = heldCache.get(key)
  if (hit && Date.now() - hit.at < HELD_TTL_MS) return hit.set
  const set = new Set((await activeRecordHolds()).map((h) => h.collection))
  heldCache.set(key, { at: Date.now(), set })
  return set
}

/** A hold was placed or released in this process — the next check reads fresh. */
export function forgetHeldCollections(): void {
  heldCache.delete(currentTenantKey())
}

/** The active hold on one record, or null. */
export async function recordHold(
  collection: string,
  item: string
): Promise<{ id: number; reason: string; created_at: Date | string } | null> {
  if (!(await legalHoldsReady())) return null
  if (!(await heldCollections()).has(collection)) return null
  const row = (await db(HOLDS)
    .where({ collection, item_id: item })
    .whereNull('released_at')
    .first('id', 'reason', 'created_at')) as
    | { id: number; reason: string; created_at: Date | string }
    | undefined
  return row ?? null
}
