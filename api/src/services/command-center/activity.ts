import { db } from '../../db/index.js'
import type { User } from '../../types.js'
import type { ActivityEntryInput, ActivityLabels } from '../activity-sentence.js'
import { can } from '../permissions.js'
import { recordIdsInRegion } from './regions.js'
import type { CcScope } from './scope.js'

/**
 * Command Center live feed (CC-4): recent business writes the caller can read, each with its
 * readable sentence (the shared activity-sentence twin, labels read AS THE CALLER).
 *
 * What is shown: creates / updates / deletes and pipeline transitions on business collections
 * (never nivaro_* tables, never routine reads). An entry is kept only when the caller may read
 * its collection AND can see the record (User Scopes, row filters) — a delete keeps its line
 * (its collection is readable) but loses the record link, since there is nothing left to open.
 *
 * Paging: newest first; `before` = an activity id cursor; `at` (rewind) = entries at or before
 * that instant. Live updates: administrators' boards refetch on the activity pulse socket,
 * everyone else polls.
 */

export type FeedFilter = 'all' | 'records' | 'transitions' | 'team'

export const FEED_ACTIONS: Record<Exclude<FeedFilter, 'team'>, string[]> = {
  all: ['create', 'update', 'delete', 'pipeline-transition', 'transition'],
  records: ['create', 'update', 'delete'],
  transitions: ['pipeline-transition', 'transition']
}

export interface FeedRow {
  id: number
  action: string
  collection: string | null
  /** The collection's readable name ("Purchase Orders"). */
  collection_label?: string | null
  item: string | null
  comment: string | null
  timestamp: string
  user_name: string | null
  sentence?: string | null
  lat?: number | null
  lng?: number | null
}

export function parseFeedFilter(v: unknown): FeedFilter {
  return v === 'records' || v === 'transitions' || v === 'team' ? v : 'all'
}

/**
 * Which entries the caller keeps, given the labels read as them (pure — the test seam).
 * `readable` = collections the caller may read; `labels.records[c:id] === null` = a record they
 * cannot see. Returns the kept rows; a delete keeps its line but drops the record id.
 */
export function keepVisible<
  T extends { action: string; collection: string | null; item: string | null }
>(rows: T[], readable: Set<string>, labels: Pick<ActivityLabels, 'records'>): T[] {
  const out: T[] = []
  for (const r of rows) {
    const c = r.collection ?? ''
    if (!c || c.startsWith('nivaro_') || !readable.has(c)) continue
    const key = `${c}:${r.item ?? ''}`
    const hidden = r.item != null && labels.records != null && labels.records[key] === null
    if (hidden) {
      if (r.action !== 'delete') continue
      out.push({ ...r, item: null })
      continue
    }
    out.push(r)
  }
  return out
}

/**
 * Drop changed fields the reader may not read (field permissions) from an entry, so its
 * sentence never names or shows them. `allowed` null = every field. Pure.
 */
export function limitChangedFields<T extends Record<string, unknown>>(
  row: T,
  allowed: string[] | null
): T {
  if (allowed == null || allowed.includes('*')) return row
  const ok = new Set(allowed)
  const out: Record<string, unknown> = { ...row }
  if (row.delta && typeof row.delta === 'object' && !Array.isArray(row.delta))
    out.delta = Object.fromEntries(
      Object.entries(row.delta as Record<string, unknown>).filter(([k]) => ok.has(k))
    )
  if (Array.isArray(row.changes))
    out.changes = (row.changes as Array<{ field?: string }>).filter((c) => ok.has(String(c.field)))
  if (Array.isArray(row.changed_fields))
    out.changed_fields = (row.changed_fields as string[]).filter((f) => ok.has(f))
  return out as T
}

const userName = (r: Record<string, unknown>): string | null => {
  const n = `${String(r.first_name ?? '').trim()} ${String(r.last_name ?? '').trim()}`.trim()
  return n || null
}

const iso = (v: unknown): string => {
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString()
}

export interface FeedAsk {
  filter?: FeedFilter
  /** Activity id cursor: entries older than this one. */
  before?: number | null
  limit?: number
  /** Only entries at or after this instant (the brief's last hour). */
  since?: Date | null
}

export interface FeedAnswer {
  entries: FeedRow[]
  region_applies: boolean
  /** The id to pass as `before` for the next page; null = no more. */
  next_before: number | null
}

/**
 * The newest readable feed entries for `user`. Over-fetches (permission and region filters
 * drop rows), then renders sentences for what is kept.
 */
export async function readFeed(
  user: User,
  isAdmin: boolean,
  scope: CcScope,
  ask: FeedAsk = {}
): Promise<FeedAnswer> {
  const filter = ask.filter ?? 'all'
  const limit = Math.max(1, Math.min(ask.limit ?? 40, 100))
  const fetch = Math.min(limit * 3, 150)
  let team: string[] | null = null
  if (filter === 'team') {
    const { reportsOf } = await import('../team.js')
    const reports = await reportsOf(String(user.id)).catch(() => [])
    team = [String(user.id), ...reports.map((r) => String(r.id))]
  }
  // Ids first by the narrow (timestamp, id) sort (migration 502 index), then the rows.
  const q = db('nivaro_activity as a')
    .whereNotNull('a.collection')
    .whereNot('a.collection', 'like', 'nivaro\\_%')
    .whereIn('a.action', FEED_ACTIONS[filter === 'team' ? 'all' : filter])
  if (team) q.whereIn('a.user', team)
  if (scope.at) q.where('a.timestamp', '<=', scope.at)
  if (ask.since) q.where('a.timestamp', '>=', ask.since)
  if (ask.before != null && Number.isFinite(ask.before)) q.where('a.id', '<', ask.before)
  const idRows = (await q
    .orderBy([
      { column: 'a.timestamp', order: 'desc' },
      { column: 'a.id', order: 'desc' }
    ])
    .limit(fetch)
    .select('a.id')) as Array<{ id: number }>
  const ids = idRows.map((r) => Number(r.id))
  if (ids.length === 0) return { entries: [], region_applies: !!scope.region, next_before: null }
  const { activityPageRows } = await import('../../routes/activity.js')
  const rows = (await activityPageRows(ids)) as Array<Record<string, unknown>>
  type Row = Record<string, unknown> & {
    action: string
    collection: string | null
    item: string | null
  }
  const base: Row[] = rows.map((r) => ({
    ...r,
    action: String(r.action ?? ''),
    collection: r.collection == null ? null : String(r.collection),
    item: r.item == null ? null : String(r.item)
  }))

  const collections = [...new Set(base.map((r) => r.collection).filter(Boolean) as string[])]
  const readable = new Set<string>()
  for (const c of collections)
    if (isAdmin || (await can(user, 'read', c).catch(() => false))) readable.add(c)

  const { activityLabelRefs } = await import('../activity-sentence.js')
  const { activityLabelsFor } = await import('../activity-readable.js')
  let pre = base.filter((r) => r.collection && readable.has(r.collection))
  if (!isAdmin) {
    const { getAllowedFields } = await import('../permissions.js')
    const allowed = new Map<string, string[] | null>()
    for (const c of readable)
      allowed.set(c, await getAllowedFields(user, 'read', c).catch(() => [] as string[]))
    pre = pre.map((r) => limitChangedFields(r, allowed.get(r.collection as string) ?? []))
  }
  const labels = await activityLabelsFor(
    user,
    activityLabelRefs(pre as unknown as ActivityEntryInput[]),
    { isAdmin }
  ).catch(() => ({ records: {} }) as ActivityLabels)
  let kept = keepVisible(pre, readable, labels)

  // Region lens: keep entries on records placed in the region (where the collection can be).
  let regionApplies = !!scope.region
  if (scope.region) {
    const placed = new Map<string, Set<string> | null>()
    for (const c of new Set(kept.map((r) => r.collection as string)))
      placed.set(c, await recordIdsInRegion(c, scope.region).catch(() => null))
    if ([...placed.values()].some((s) => s == null)) regionApplies = false
    kept = kept.filter((r) => {
      const set = placed.get(r.collection as string)
      return set == null || (r.item != null && set.has(String(r.item)))
    })
  }

  const { collectionNouns, renderActivitySentence } = await import('../activity-sentence.js')
  const page = kept.slice(0, limit)
  const entries: FeedRow[] = page.map((r) => ({
    id: Number(r.id),
    action: r.action,
    collection: r.collection,
    collection_label: r.collection ? collectionNouns(r.collection, labels).plural : null,
    item: r.item,
    comment: r.comment == null ? null : String(r.comment).slice(0, 200),
    timestamp: iso(r.timestamp),
    user_name: userName(r),
    sentence: renderActivitySentence(r as unknown as ActivityEntryInput, labels)
  }))
  const oldest = ids[ids.length - 1]
  return {
    entries,
    region_applies: regionApplies,
    next_before:
      kept.length > limit
        ? (entries[entries.length - 1]?.id ?? null)
        : ids.length < fetch
          ? null
          : (oldest ?? null)
  }
}

/** The /snapshot feed seed (one call from routes/command-center.ts): 25 newest, as the caller. */
export async function snapshotFeed(req: {
  user?: User | null
  isAdmin?: boolean
  query?: unknown
}): Promise<FeedRow[]> {
  const { readCcScope } = await import('./scope.js')
  const feed = await readFeed(req.user as User, !!req.isAdmin, readCcScope(req.query), {
    limit: 25
  })
  return feed.entries
}
