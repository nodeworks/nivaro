import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { cleanQuery, logSearch, markOpened } from './search-analytics.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Ranking signals for global search (search program 2026-10-28, items 5/6), all
 * read from tables that already exist — no migration:
 *
 *  - learned: which records DIFFERENT people opened from the same normalised query
 *    (nivaro_search_log, #1581). Counted by distinct person so one person
 *    clicking a record a hundred times cannot push it up for everyone.
 *  - recent: what this person opened from search lately.
 *  - owned: records where this person is a manual pipeline owner, or a resolved
 *    owner on a materialized queue row (nivaro_queue_item_owners) — both an
 *    indexed lookup over the candidate ids, never the seconds-long owner resolver.
 *
 * Boosts only ever reorder hits the caller already read through readItems; a
 * signal can never add a record to the answer. Caches are per tenant, 60 s.
 */

const TTL_MS = 60_000
const LEARNED_DAYS = 90
const RECENT_DAYS = 30
const CACHE_MAX = 500

const learnedCache = new Map<string, { at: number; value: Promise<Map<string, number>> }>()
const recentCache = new Map<string, { at: number; value: Promise<Set<string>> }>()

export const hitKey = (collection: string, id: unknown) => `${collection}:${String(id)}`

/** The query as the log stores it, lower-cased for matching (null = too short). */
export function normalizeQuery(q: string): string | null {
  return cleanQuery(q)?.toLowerCase() ?? null
}

function remember<T>(
  cache: Map<string, { at: number; value: Promise<T> }>,
  key: string,
  load: () => Promise<T>,
  fallback: T
): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  if (cache.size >= CACHE_MAX) cache.clear()
  const value = load().catch(() => fallback)
  cache.set(key, { at: Date.now(), value })
  return value
}

const tableReady = () => hasColumn('nivaro_search_log', 'opened_item')

/** `collection:id` → how many different people opened it from this query. */
export function learnedOpens(q: string): Promise<Map<string, number>> {
  const nq = normalizeQuery(q)
  if (!nq) return Promise.resolve(new Map())
  return remember(
    learnedCache,
    `${currentTenantKey()}\u0000${nq}`,
    async () => {
      if (!(await tableReady())) return new Map()
      const rows = (await db('nivaro_search_log')
        .where('query', nq)
        .where('opened_type', 'record')
        .whereNotNull('opened_item')
        .whereNotNull('opened_collection')
        .where('created_at', '>', new Date(Date.now() - LEARNED_DAYS * 86_400_000))
        .groupBy('opened_collection', 'opened_item')
        .select('opened_collection', 'opened_item')
        .countDistinct({ people: 'user' })
        .orderBy('people', 'desc')
        .limit(50)) as Array<{ opened_collection: string; opened_item: string; people: number }>
      return new Map(
        rows.map((r) => [hitKey(r.opened_collection, r.opened_item), Number(r.people)])
      )
    },
    new Map()
  )
}

/** `collection:id` keys this person opened from search in the last 30 days. */
export function recentOpens(userId: string): Promise<Set<string>> {
  return remember(
    recentCache,
    `${currentTenantKey()}\u0000${userId}`,
    async () => {
      if (!(await tableReady())) return new Set()
      const rows = (await db('nivaro_search_log')
        .where('user', userId)
        .where('opened_type', 'record')
        .whereNotNull('opened_item')
        .whereNotNull('opened_collection')
        .where('opened_at', '>', new Date(Date.now() - RECENT_DAYS * 86_400_000))
        .orderBy('opened_at', 'desc')
        .limit(200)
        .select('opened_collection', 'opened_item')) as Array<{
        opened_collection: string
        opened_item: string
      }>
      return new Set(rows.map((r) => hitKey(r.opened_collection, r.opened_item)))
    },
    new Set()
  )
}

/** Forget cached signals after a click, so the person's next search reflects it. */
export function forgetSignals(userId: string, q?: string): void {
  recentCache.delete(`${currentTenantKey()}\u0000${userId}`)
  const nq = q ? normalizeQuery(q) : null
  if (nq) learnedCache.delete(`${currentTenantKey()}\u0000${nq}`)
}

/**
 * Of the candidate records, the ones this person owns: manual pipeline owners on
 * the record's instance, plus resolved owners mirrored on materialized queue rows.
 * Two indexed reads in all, whatever the number of collections. Any failure =
 * nobody owns anything (a boost, never a gate).
 */
export async function ownedAmong(
  userId: string,
  byCollection: Map<string, string[]>
): Promise<Set<string>> {
  const out = new Set<string>()
  const entries = [...byCollection.entries()].filter(([, ids]) => ids.length > 0)
  if (entries.length === 0) return out
  const scoped = (qb: import('knex').Knex.QueryBuilder, colCol: string, itemCol: string) =>
    qb.where((w) => {
      for (const [collection, ids] of entries) {
        w.orWhere((x) => void x.where(colCol, collection).whereIn(itemCol, ids.slice(0, 100)))
      }
    })
  const [manual, queued] = await Promise.all([
    scoped(
      db('nivaro_pipeline_instance_owners as io')
        .join('nivaro_workflow_instances as i', 'i.id', 'io.instance')
        .where('io.user', userId)
        .whereNull('i.completed_at')
        .select('i.collection as c', 'i.item as item'),
      'i.collection',
      'i.item'
    ).catch(() => [] as Array<{ c: string; item: string }>),
    scoped(
      db('nivaro_queue_item_owners as qio')
        .join('nivaro_queue_items as qi', 'qi.id', 'qio.queue_item_id')
        .where('qio.user_id', userId)
        .distinct('qi.collection as c', 'qi.item_id as item'),
      'qi.collection',
      'qi.item_id'
    ).catch(() => [] as Array<{ c: string; item: string }>)
  ])
  // Instance item mirrors are written in both casings for uuid ids (record-state.ts).
  const want = new Map<string, string>()
  for (const [collection, ids] of entries)
    for (const id of ids) want.set(hitKey(collection, id).toLowerCase(), hitKey(collection, id))
  for (const r of [
    ...(manual as Array<{ c: string; item: string }>),
    ...(queued as Array<{ c: string; item: string }>)
  ]) {
    const k = want.get(hitKey(r.c, r.item).toLowerCase())
    if (k) out.add(k)
  }
  return out
}

/**
 * POST /global-search/click: what was opened, for learned ranking. With the log id
 * the palette already has, it marks that search's open (#1581); without one it
 * logs the search first. `position` is 0-based: the search had at least
 * position + 1 results, which is what the log records (never zero — that would
 * read as an empty search in Search analytics).
 */
export async function recordClick(
  userId: string,
  b: { q?: unknown; collection?: unknown; id?: unknown; position?: unknown; log_id?: unknown }
): Promise<{ ok: boolean; log_id: number | null }> {
  const collection = typeof b.collection === 'string' ? b.collection.trim() : ''
  const id = b.id == null ? '' : String(b.id).trim()
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(collection) || !id || id.length > 100)
    return { ok: false, log_id: null }
  const q = typeof b.q === 'string' ? b.q : ''
  let logId = Number(b.log_id)
  if (!Number.isFinite(logId) || logId <= 0) {
    const pos = Math.max(0, Math.trunc(Number(b.position) || 0))
    const made = await logSearch(userId, {
      surface: 'palette',
      query: normalizeQuery(q) ?? undefined,
      result_count: pos + 1
    })
    if (made == null) return { ok: false, log_id: null }
    logId = made
  }
  const ok = await markOpened(logId, userId, { type: 'record', collection, item: id })
  forgetSignals(userId, q)
  return { ok, log_id: logId }
}
