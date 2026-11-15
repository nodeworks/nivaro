/**
 * A live feed of what changed across a set of related records (realtime program 2026-11-14,
 * idea 21: the Project 360 activity stream).
 *
 * The caller names WHERE to look — sources (a collection plus a filter, "the workflows of
 * project 12") and single records ("project 12 itself") — never which activity rows. The server
 * resolves every source to record ids AS THE CALLER (their read policy, row filter and User
 * Scopes, the same read a list makes), reads the activity of exactly those records, and strips
 * what a non-administrator may not see (services route: forNonAdmin). A record the caller
 * cannot open contributes nothing, so the feed never confirms it exists.
 */

export const FEED_SOURCES_MAX = 8
export const FEED_RECORDS_MAX = 50
export const FEED_IDS_PER_SOURCE = 200
/** How long one viewer's resolved record ids are reused (the stream refetches on live events). */
export const FEED_SCOPE_TTL_MS = 60_000
export const FEED_LIMIT_DEFAULT = 30
export const FEED_LIMIT_MAX = 50

const IDENT = /^[A-Za-z][A-Za-z0-9_]{0,127}$/
/** Collections no feed ever reads: system tables and chat (per-room visibility). */
const REFUSED = /^(nivaro_|directus_|chat_)/i

export interface FeedSource {
  collection: string
  filter?: Record<string, unknown>
}
export interface FeedRecord {
  collection: string
  id: string
}
export interface FeedRequest {
  sources: FeedSource[]
  records: FeedRecord[]
  /** Only these collections (the type filter). Empty = every type. */
  collections: string[]
  /** Activity id cursor: rows older than this id. */
  before: number | null
  limit: number
}

export type ParsedFeed = { ok: true; value: FeedRequest } | { ok: false; error: string }

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** Validate a feed body (pure). Never throws. */
export function parseFeedBody(body: unknown): ParsedFeed {
  if (!isObject(body)) return { ok: false, error: 'A feed request is an object' }
  const sources: FeedSource[] = []
  for (const s of Array.isArray(body.sources) ? body.sources : []) {
    if (!isObject(s) || typeof s.collection !== 'string' || !IDENT.test(s.collection))
      return { ok: false, error: 'Each source needs a collection' }
    if (s.filter !== undefined && s.filter !== null && !isObject(s.filter))
      return { ok: false, error: 'A source filter is an object' }
    sources.push({
      collection: s.collection,
      ...(isObject(s.filter) ? { filter: s.filter } : {})
    })
  }
  if (sources.length > FEED_SOURCES_MAX)
    return { ok: false, error: `At most ${FEED_SOURCES_MAX} sources` }
  const records: FeedRecord[] = []
  for (const r of Array.isArray(body.records) ? body.records : []) {
    if (!isObject(r) || typeof r.collection !== 'string' || !IDENT.test(r.collection))
      return { ok: false, error: 'Each record needs a collection and an id' }
    const id = String(r.id ?? '').trim()
    if (!id || id.length > 100)
      return { ok: false, error: 'Each record needs a collection and an id' }
    records.push({ collection: r.collection, id })
  }
  if (records.length > FEED_RECORDS_MAX)
    return { ok: false, error: `At most ${FEED_RECORDS_MAX} records` }
  if (sources.length + records.length === 0)
    return { ok: false, error: 'Name at least one source or record' }
  const collections = (Array.isArray(body.collections) ? body.collections : [])
    .filter((c): c is string => typeof c === 'string' && IDENT.test(c))
    .slice(0, 40)
  const beforeN = Math.floor(Number(body.before))
  const asked = Math.floor(Number(body.limit))
  return {
    ok: true,
    value: {
      sources,
      records,
      collections,
      before: Number.isFinite(beforeN) && beforeN > 0 ? beforeN : null,
      limit:
        Number.isFinite(asked) && asked > 0 ? Math.min(asked, FEED_LIMIT_MAX) : FEED_LIMIT_DEFAULT
    }
  }
}

export interface FeedDeps {
  /** Ids the caller may read in `collection` matching `filter`; null = the collection is closed to them. */
  sourceIds(
    collection: string,
    filter: Record<string, unknown> | undefined
  ): Promise<{ ids: string[]; truncated: boolean } | null>
  /** Whether the caller may open this one record. */
  recordVisible(collection: string, id: string): Promise<boolean>
}

export interface FeedType {
  collection: string
  /** Records of this type the caller can see in the feed's scope. */
  records: number
  /** More records matched than the feed follows (the newest are kept). */
  truncated: boolean
  /** The record ids the feed follows (viewer-visible only) — the client refetches on writes to them. */
  ids: string[]
}

export interface FeedScope {
  /** collection → record ids the feed reads. */
  groups: Map<string, string[]>
  types: FeedType[]
}

/**
 * Resolve sources and records to the ids the caller may see (deduped). The type filter
 * (`collections`) is NOT applied here: the answer always lists every type so the chips stay put
 * while one is chosen; `narrowToTypes` cuts the groups the activity read uses.
 */
export async function resolveFeedScope(req: FeedRequest, deps: FeedDeps): Promise<FeedScope> {
  const sets = new Map<string, Set<string>>()
  const truncated = new Set<string>()
  const add = (collection: string, ids: Iterable<string>) => {
    const s = sets.get(collection) ?? new Set<string>()
    sets.set(collection, s)
    for (const id of ids) s.add(String(id))
  }
  await Promise.all([
    ...req.sources.map(async (s) => {
      if (REFUSED.test(s.collection)) return
      const res = await deps.sourceIds(s.collection, s.filter)
      if (!res) return
      add(s.collection, res.ids)
      if (res.truncated) truncated.add(s.collection)
    }),
    ...req.records.map(async (r) => {
      if (REFUSED.test(r.collection)) return
      if (await deps.recordVisible(r.collection, r.id)) add(r.collection, [r.id])
    })
  ])
  const groups = new Map<string, string[]>()
  const types: FeedType[] = []
  for (const [collection, ids] of sets) {
    if (ids.size === 0) continue
    groups.set(collection, [...ids])
    types.push({
      collection,
      records: ids.size,
      truncated: truncated.has(collection),
      ids: [...ids]
    })
  }
  types.sort((a, b) => b.records - a.records || a.collection.localeCompare(b.collection))
  return { groups, types }
}

/** The groups the activity read covers: all of them, or only the chosen types. */
export function narrowToTypes(
  groups: Map<string, string[]>,
  collections: readonly string[]
): Map<string, string[]> {
  if (collections.length === 0) return groups
  const keep = new Set(collections)
  return new Map([...groups].filter(([c]) => keep.has(c)))
}

// ── Per-viewer scope cache ─────────────────────────────────────────────────

interface CacheEntry {
  at: number
  scope: Promise<FeedScope>
}
const scopeCache = new Map<string, CacheEntry>()
const SCOPE_CACHE_MAX = 500

/**
 * One viewer's resolved scope, reused for FEED_SCOPE_TTL_MS and shared by concurrent callers
 * (single flight). The key is the tenant + the person (their read policy, row filter and User
 * Scopes decide the ids, so nobody ever reuses another person's) + the request's sources/records.
 * A failed resolution is never kept.
 */
export function cachedFeedScope(
  key: string,
  load: () => Promise<FeedScope>,
  now = Date.now()
): Promise<FeedScope> {
  const hit = scopeCache.get(key)
  if (hit && now - hit.at < FEED_SCOPE_TTL_MS) return hit.scope
  if (scopeCache.size >= SCOPE_CACHE_MAX) {
    for (const [k, v] of scopeCache) if (now - v.at >= FEED_SCOPE_TTL_MS) scopeCache.delete(k)
    if (scopeCache.size >= SCOPE_CACHE_MAX) scopeCache.clear()
  }
  const scope = load()
  scopeCache.set(key, { at: now, scope })
  scope.catch(() => {
    if (scopeCache.get(key)?.scope === scope) scopeCache.delete(key)
  })
  return scope
}

export function _resetFeedScopeCacheForTests(): void {
  scopeCache.clear()
}
