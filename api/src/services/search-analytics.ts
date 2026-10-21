import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'

/**
 * Search analytics (#1581). A search typed into Cmd+K or a collection browser
 * is logged with its query text, result count, how long it took and — once the
 * person picks one — what kind of thing they opened (a collection and id, never
 * a label or any result content). Personal data: only administrators read it
 * (routes/search-analytics.ts) and rows are pruned by SEARCH_LOG_RETENTION_DAYS.
 */

export const SURFACES = ['palette', 'collection'] as const
export type Surface = (typeof SURFACES)[number]
export const OPENED_TYPES = ['record', 'page', 'action', 'similar'] as const
export type OpenedType = (typeof OPENED_TYPES)[number]

export const SLOW_MS = 1000
const ROW_CAP = 50_000

const tableReady = () => hasColumn('nivaro_search_log', 'id')

export function retentionDays(): number {
  const n = Number(process.env.SEARCH_LOG_RETENTION_DAYS)
  return Number.isFinite(n) && n >= 1 ? Math.min(3650, Math.trunc(n)) : 60
}

export function cleanQuery(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const q = v.replace(/\s+/g, ' ').trim().slice(0, 200)
  return q.length >= 2 ? q : null
}

export async function logSearch(
  userId: string | null,
  b: {
    surface?: unknown
    collection?: unknown
    query?: unknown
    result_count?: unknown
    duration_ms?: unknown
  }
): Promise<number | null> {
  if (!(await tableReady())) return null
  const query = cleanQuery(b.query)
  if (!query || !SURFACES.includes(b.surface as Surface)) return null
  const count = Math.trunc(Number(b.result_count))
  const ms = Math.trunc(Number(b.duration_ms))
  const [row] = (await db('nivaro_search_log')
    .insert({
      user: userId,
      surface: b.surface,
      collection: typeof b.collection === 'string' ? b.collection.slice(0, 100) : null,
      query,
      result_count: Number.isFinite(count) && count >= 0 ? Math.min(count, 1_000_000) : 0,
      duration_ms: Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 600_000) : null,
      created_at: new Date()
    })
    .returning('id')) as Array<{ id: number } | number>
  return Number(typeof row === 'object' ? row.id : row)
}

/** Only the person who ran the search may say what they opened from it. */
export async function markOpened(
  id: number,
  userId: string,
  b: { type?: unknown; collection?: unknown; item?: unknown }
): Promise<boolean> {
  if (!(await tableReady()) || !Number.isFinite(id)) return false
  if (!OPENED_TYPES.includes(b.type as OpenedType)) return false
  const n = await db('nivaro_search_log')
    .where({ id, user: userId })
    .update({
      opened_type: b.type,
      opened_collection: typeof b.collection === 'string' ? b.collection.slice(0, 100) : null,
      opened_item: b.item != null ? String(b.item).slice(0, 100) : null,
      opened_at: new Date()
    })
  return n > 0
}

export async function pruneSearchLog(): Promise<void> {
  if (!(await tableReady())) return
  const cutoff = new Date(Date.now() - retentionDays() * 86_400_000)
  await db('nivaro_search_log').where('created_at', '<', cutoff).delete()
}

export interface SearchRow {
  user: string | null
  surface: string
  collection: string | null
  query: string
  result_count: number
  duration_ms: number | null
  opened_type: string | null
}

interface Agg {
  query: string
  collection: string | null
  searches: number
  people: Set<string>
  zero: number
  unopened: number
  opened: number
  results: number
  ms: number[]
}

const p75 = (v: number[]) => {
  if (!v.length) return null
  const s = [...v].sort((a, z) => a - z)
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.75))]
}

/** Fold log rows into the four lists the Search analytics page shows. */
export function summarizeSearches(rows: SearchRow[], topN = 25) {
  const by = new Map<string, Agg>()
  for (const r of rows) {
    // The same words in another collection are a different search to fix.
    const key = `${r.surface}\u0000${r.collection ?? ''}\u0000${r.query.toLowerCase()}`
    let a = by.get(key)
    if (!a) {
      a = {
        query: r.query,
        collection: r.surface === 'collection' ? r.collection : null,
        searches: 0,
        people: new Set(),
        zero: 0,
        unopened: 0,
        opened: 0,
        results: 0,
        ms: []
      }
      by.set(key, a)
    }
    a.searches++
    if (r.user) a.people.add(r.user)
    a.results += r.result_count
    if (r.result_count === 0) a.zero++
    else if (r.opened_type) a.opened++
    else a.unopened++
    if (r.duration_ms != null) a.ms.push(r.duration_ms)
  }
  const line = (a: Agg) => ({
    query: a.query,
    collection: a.collection,
    searches: a.searches,
    people: a.people.size,
    zero_results: a.zero,
    unopened: a.unopened,
    avg_results: a.searches ? Math.round(a.results / a.searches) : 0,
    p75_ms: p75(a.ms)
  })
  const all = [...by.values()]
  const top = (list: Agg[], metric: (a: Agg) => number) =>
    list
      .filter((a) => metric(a) > 0)
      .sort((a, z) => metric(z) - metric(a) || z.searches - a.searches)
      .slice(0, topN)
      .map(line)
  const withResults = rows.filter((r) => r.result_count > 0)
  return {
    totals: {
      searches: rows.length,
      people: new Set(rows.map((r) => r.user).filter(Boolean)).size,
      zero_result_rate: rows.length
        ? rows.filter((r) => r.result_count === 0).length / rows.length
        : null,
      open_rate: withResults.length
        ? withResults.filter((r) => r.opened_type).length / withResults.length
        : null,
      p75_ms: p75(rows.map((r) => r.duration_ms).filter((v): v is number => v != null))
    },
    top: all
      .sort((a, z) => z.searches - a.searches)
      .slice(0, topN)
      .map(line),
    zero_results: top(all, (a) => a.zero),
    unopened: top(all, (a) => a.unopened),
    slow: all
      .filter((a) => (p75(a.ms) ?? 0) >= SLOW_MS)
      .sort((a, z) => (p75(z.ms) ?? 0) - (p75(a.ms) ?? 0))
      .slice(0, topN)
      .map(line)
  }
}

export async function searchSummary(days: number) {
  if (!(await tableReady())) return { ready: false as const }
  const since = new Date(Date.now() - days * 86_400_000)
  const rows = (await db('nivaro_search_log')
    .where('created_at', '>=', since)
    .orderBy('created_at', 'desc')
    .limit(ROW_CAP)
    .select(
      'user',
      'surface',
      'collection',
      'query',
      'result_count',
      'duration_ms',
      'opened_type'
    )) as SearchRow[]
  return {
    ready: true as const,
    window: { days, retention_days: retentionDays(), truncated: rows.length >= ROW_CAP },
    ...summarizeSearches(rows)
  }
}
