/**
 * "Changed by others" (realtime program 2026-11-14, items 10 + 11): a list filter that keeps
 * the records someone OTHER than the reader created, edited or moved through a pipeline in a
 * time window, and the per-person "last opened" time of each saved view that the view pill's
 * "N changed since you last opened this view" count is measured from.
 *
 * Filter, on the collection browser's `conditions` surface:
 *   {path: ['$changed'], op: '_eq', value: {window: '24h'}}             last 24 hours, rolling
 *   {path: ['$changed'], op: '_eq', value: {since: ISO, until?: ISO}}   a fixed range
 *   {path: ['$changed'], op: '_neq', value: …}                          NOT changed by others
 * `others: false` counts the reader's own writes too (default true).
 *
 * The read is the activity log, led by its (collection, action, timestamp) index (migration
 * 159, item + user included): ONE bounded range read of the window answers the changed record
 * ids (at most CHANGED_ID_CAP), which the list then reads by primary key, as the reader, with
 * every other gate in place. A window with more changed records than the cap falls back to a
 * per-row EXISTS on the (collection, item, timestamp) index (migration 321). A collection whose
 * audit level is "none" logs nothing, so nothing in it ever reads as changed.
 *
 * Leaf module: the database handle and the field metadata, nothing from the items service.
 */

import type { Knex } from 'knex'
import { idText } from '../db/dialect/items-query.js'
import { db } from '../db/index.js'
import { getFields } from './collections.js'
import { whereInList } from './db-batch.js'

type QB = Knex.QueryBuilder

export const CHANGED_FIELD = '$changed'

/** The activity actions that mean "this record changed" to a person reading a list. */
export const CHANGED_ACTIONS = ['create', 'update', 'pipeline-transition'] as const

/** The picker's rolling windows, in hours. */
export const CHANGED_WINDOWS: Record<string, number> = {
  '1h': 1,
  '24h': 24,
  '2d': 48,
  '5d': 120,
  '7d': 168
}

/** A custom range never reads more than this much of the log. */
export const CHANGED_MAX_SPAN_MS = 31 * 86_400_000

/** Most changed record ids the window read answers before the EXISTS fallback. */
export const CHANGED_ID_CAP = 5000

export interface ChangedFilter {
  /** true = changed in the window; false = not changed in it. */
  include: boolean
  since: Date
  until: Date | null
  /** Leave out the reader's own writes. */
  others: boolean
}

function when(v: unknown): Date | null {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Read a `$changed` value. Returns null when no usable window was named (the caller narrows
 * to nothing — a filter that fails to read must never answer every row).
 */
export function parseChangedFilter(
  value: unknown,
  op?: string,
  now: Date = new Date()
): ChangedFilter | null {
  let include = true
  if (op === '_neq' || op === '_nin') include = false
  else if (op && op !== '_eq' && op !== '_in') return null

  let v: Record<string, unknown>
  if (typeof value === 'string') v = { window: value }
  else if (value && typeof value === 'object' && !Array.isArray(value))
    v = value as Record<string, unknown>
  else return null
  if (v.include === false) include = !include

  let since: Date | null = null
  let until: Date | null = null
  const windowHours =
    typeof v.window === 'string' ? CHANGED_WINDOWS[v.window] : Number(v.hours ?? Number.NaN)
  if (Number.isFinite(windowHours) && windowHours > 0) {
    since = new Date(now.getTime() - Math.min(windowHours, 24 * 31) * 3_600_000)
  } else {
    since = when(v.since)
    until = when(v.until)
  }
  if (!since) return null
  if (since.getTime() > now.getTime()) since = now
  if (until && until.getTime() < since.getTime()) return null
  // Bound the read: a custom range keeps its newest 31 days.
  const end = until ?? now
  if (end.getTime() - since.getTime() > CHANGED_MAX_SPAN_MS)
    since = new Date(end.getTime() - CHANGED_MAX_SPAN_MS)

  return { include, since, until, others: v.others !== false }
}

/** The bounded window read (exported for tests: the SQL it compiles). */
export function changedIdsQuery(
  knex: Knex,
  collection: string,
  f: ChangedFilter,
  userId: string | null,
  cap = CHANGED_ID_CAP
): QB {
  const q = knex('nivaro_activity as ca')
    .distinct('ca.item')
    .where('ca.collection', collection)
    .whereIn('ca.action', [...CHANGED_ACTIONS])
    .where('ca.timestamp', '>=', f.since)
    .whereNotNull('ca.item')
  if (f.until) q.where('ca.timestamp', '<=', f.until)
  if (f.others && userId) q.where((b) => b.whereNull('ca.user').orWhereNot('ca.user', userId))
  return q.limit(cap + 1)
}

/** Keep only ids the primary key can hold, so the IN list never fails a conversion. */
export function idsForKey(ids: string[], keyType: string | null | undefined): string[] {
  const t = String(keyType ?? '').toLowerCase()
  if (t === 'integer' || t === 'biginteger' || t === 'int' || t === 'bigint')
    return ids.filter((i) => /^-?\d{1,18}$/.test(i))
  if (t === 'uuid' || t === 'uniqueidentifier')
    return ids.filter((i) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(i)
    )
  return ids
}

/**
 * The changed record ids in the window, or null when there are more than `cap` of them (the
 * caller compiles the per-row EXISTS instead).
 */
export async function changedItemIds(
  collection: string,
  f: ChangedFilter,
  userId: string | null,
  cap = CHANGED_ID_CAP
): Promise<string[] | null> {
  const rows = (await changedIdsQuery(db, collection, f, userId, cap)) as Array<{ item: unknown }>
  if (rows.length > cap) return null
  const ids = rows.map((r) => String(r.item)).filter(Boolean)
  let keyType: string | null = null
  try {
    keyType = (await getFields(collection)).find((x) => x.field === 'id')?.type ?? null
  } catch {
    keyType = null
  }
  return idsForKey(ids, keyType)
}

/** Narrow `q` (a read of `collection`, aliased by its own name) to the window's records. */
export function applyChangedFilter(
  q: QB,
  collection: string,
  f: ChangedFilter | null,
  userId: string | null,
  ids: string[] | null
): void {
  if (!f) {
    q.whereRaw('1 = 0')
    return
  }
  if (ids) {
    if (ids.length === 0) {
      if (f.include) q.whereRaw('1 = 0')
      return
    }
    if (f.include) whereInList(q, `${collection}.id`, ids)
    else q.whereNot((b) => whereInList(b, `${collection}.id`, ids))
    return
  }
  const exists = function (this: QB) {
    this.select(db.raw('1'))
      .from('nivaro_activity as ca')
      .where('ca.collection', collection)
      .whereRaw(`ca.item = ${idText(undefined, '??.??')}`, [collection, 'id'])
      .whereIn('ca.action', [...CHANGED_ACTIONS])
      .where('ca.timestamp', '>=', f.since)
    if (f.until) this.where('ca.timestamp', '<=', f.until)
    if (f.others && userId) this.where((b) => b.whereNull('ca.user').orWhereNot('ca.user', userId))
  }
  if (f.include) q.whereExists(exists)
  else q.whereNotExists(exists)
}

/**
 * The page and its total compile the same condition object: read the window once for both.
 * Keyed on the condition object itself, so nothing outlives the request.
 */
const resolved = new WeakMap<object, Promise<{ f: ChangedFilter | null; ids: string[] | null }>>()

export async function resolveChangedCondition(
  cond: { op?: string; value?: unknown },
  collection: string,
  userId: string | null
): Promise<{ f: ChangedFilter | null; ids: string[] | null }> {
  let hit = resolved.get(cond)
  if (!hit) {
    const f = parseChangedFilter(cond.value, cond.op)
    hit = f
      ? changedItemIds(collection, f, userId).then((ids) => ({ f, ids }))
      : Promise.resolve({ f: null, ids: null })
    resolved.set(cond, hit)
  }
  return hit
}

// ── Saved views: when this person last opened each one ─────────────────────

/** nivaro_users.preferences key: {[viewId]: ISO}. */
export const VIEW_OPENED_KEY = 'view_opened'
/** Views remembered per person (newest kept). */
export const VIEW_OPENED_MAX = 300

export function parseViewOpened(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d+$/.test(k) || typeof v !== 'string') continue
    if (Number.isNaN(new Date(v).getTime())) continue
    out[k] = v
  }
  return out
}

/** The map with `viewId` stamped at `at` (newest last, capped). */
export function stampViewOpened(
  current: Record<string, string>,
  viewId: number,
  at: Date
): Record<string, string> {
  const entries = Object.entries(current).filter(([k]) => k !== String(viewId))
  entries.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  entries.push([String(viewId), at.toISOString()])
  return Object.fromEntries(entries.slice(-VIEW_OPENED_MAX))
}

function parsePreferences(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

export async function readViewOpened(userId: string): Promise<Record<string, string>> {
  const row = (await db('nivaro_users').where({ id: userId }).first('preferences')) as
    | { preferences?: unknown }
    | undefined
  return parseViewOpened(parsePreferences(row?.preferences)[VIEW_OPENED_KEY])
}

/** Stamp the view as opened now; answers the time it was opened before (null = never). */
export async function markViewOpened(
  userId: string,
  viewId: number,
  at: Date = new Date()
): Promise<string | null> {
  const row = (await db('nivaro_users').where({ id: userId }).first('preferences')) as
    | { preferences?: unknown }
    | undefined
  const all = parsePreferences(row?.preferences)
  const current = parseViewOpened(all[VIEW_OPENED_KEY])
  const previous = current[String(viewId)] ?? null
  const next = stampViewOpened(current, viewId, at)
  await db('nivaro_users')
    .where({ id: userId })
    .update({ preferences: JSON.stringify({ ...all, [VIEW_OPENED_KEY]: next }) })
  return previous
}
