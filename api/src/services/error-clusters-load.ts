/**
 * Error clusters (#20) — the reads behind error-clusters.ts: issues seen in the window
 * (nivaro_issues, server + client) and their stored occurrences (nivaro_issue_occurrences, the
 * last 50 / 30 days per issue). One answer per tenant + window is reused for 60 s, so an admin
 * flipping between the list and a cluster does not re-read thousands of issues.
 *
 * Request ids for a server cluster come from the API log: a 5xx row of the same person within a
 * few seconds of a stored occurrence (issues keep no request id of their own).
 */
import { db } from '../db/index.js'
import { selectInChunks } from './db-batch.js'
import {
  buildClusters,
  type ClusterIssue,
  type ClusterOccurrence,
  type ErrorCluster
} from './error-clusters.js'
import { currentTenantKey } from './tenant-rooms.js'

const ISSUE_CAP = 3000
const CACHE_MS = 60_000
const MATCH_WINDOW_MS = 3000

const iso = (v: unknown): string | null => {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

interface Loaded {
  at: number
  clusters: ErrorCluster[]
  occurrences: ClusterOccurrence[]
  truncated: boolean
  window: { since: string; until: string; buckets: number; bucket_ms: number }
}

/** Tenant-keyed (cloud tenants share module state). */
const cache = new Map<string, Loaded>()

export async function loadErrorClusters(opts: {
  days: number
  source?: 'server' | 'client' | null
}): Promise<Loaded> {
  const days = Math.min(30, Math.max(1, Math.round(opts.days)))
  const key = `${currentTenantKey() || '-'}|${days}|${opts.source ?? ''}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit

  const until = Date.now()
  const since = until - days * 86_400_000
  const buckets = days <= 1 ? 24 : days
  const rows = (await db('nivaro_issues')
    .whereIn('source', opts.source ? [opts.source] : ['server', 'client'])
    .where((w) => {
      void w
        .where('last_seen_at', '>=', new Date(since))
        .orWhere((x) => void x.whereNull('last_seen_at').where('created_at', '>=', new Date(since)))
    })
    .orderBy('last_seen_at', 'desc')
    .limit(ISSUE_CAP + 1)
    .select(
      'id',
      'source',
      'title',
      'status',
      'severity',
      'occurrence_count',
      'created_at',
      'last_seen_at',
      'raised_by',
      'recording_id',
      'recording_offset_ms',
      // The stack is all a cluster needs from details — never the whole text.
      db.raw('SUBSTRING(details, 1, 2000) as details')
    )) as Array<Record<string, unknown>>
  const truncated = rows.length > ISSUE_CAP
  const issues: ClusterIssue[] = rows.slice(0, ISSUE_CAP).map((r) => ({
    id: Number(r.id),
    source: String(r.source ?? 'server'),
    title: String(r.title ?? ''),
    details: r.details == null ? null : String(r.details),
    status: String(r.status ?? 'open'),
    severity: r.severity == null ? null : String(r.severity),
    occurrence_count: Number(r.occurrence_count ?? 1),
    created_at: iso(r.created_at),
    last_seen_at: iso(r.last_seen_at),
    raised_by: r.raised_by == null ? null : String(r.raised_by),
    recording_id: r.recording_id == null ? null : String(r.recording_id),
    recording_offset_ms: r.recording_offset_ms == null ? null : Number(r.recording_offset_ms)
  }))

  let occurrences: ClusterOccurrence[] = []
  try {
    if (issues.length && (await db.schema.hasTable('nivaro_issue_occurrences'))) {
      const occ = (await selectInChunks(
        issues.map((i) => i.id),
        1000,
        (chunk) =>
          db('nivaro_issue_occurrences')
            .whereIn('issue', chunk)
            .where('occurred_at', '>=', new Date(since))
            .select('issue', 'occurred_at', 'user_id', 'route', 'build')
      )) as Array<Record<string, unknown>>
      occurrences = occ.map((o) => ({
        issue: Number(o.issue),
        occurred_at: iso(o.occurred_at) ?? new Date(0).toISOString(),
        user_id: o.user_id == null ? null : String(o.user_id),
        route: o.route == null ? null : String(o.route),
        build: o.build == null ? null : String(o.build)
      }))
    }
  } catch {
    /* the trend falls back to last-seen buckets */
  }

  const clusters = buildClusters(issues, occurrences, { since, until, buckets })
  const out: Loaded = {
    at: Date.now(),
    clusters,
    occurrences,
    truncated,
    window: {
      since: new Date(since).toISOString(),
      until: new Date(until).toISOString(),
      buckets,
      bucket_ms: Math.round((until - since) / buckets)
    }
  }
  cache.set(key, out)
  if (cache.size > 50) cache.delete(cache.keys().next().value as string)
  return out
}

/** The API log's request ids for a server cluster's most recent occurrences (≤ 8). */
export async function requestIdsForCluster(
  cluster: ErrorCluster,
  occurrences: ClusterOccurrence[]
): Promise<Array<{ request_id: string; at: string; path: string; status: number }>> {
  if (cluster.source !== 'server') return []
  const mine = new Set(cluster.issue_ids)
  const recent = occurrences
    .filter((o) => mine.has(o.issue))
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
    .slice(0, 8)
  const out: Array<{ request_id: string; at: string; path: string; status: number }> = []
  const seen = new Set<string>()
  for (const o of recent) {
    try {
      const t = Date.parse(o.occurred_at)
      let q = db('nivaro_api_logs')
        .whereBetween('created_at', [new Date(t - MATCH_WINDOW_MS), new Date(t + MATCH_WINDOW_MS)])
        .where('status', '>=', 500)
        .whereNotNull('request_id')
      q = o.user_id ? q.where('user', o.user_id) : q.whereNull('user')
      const row = (await q
        .orderBy('id', 'desc')
        .first('request_id', 'created_at', 'path', 'status')) as Record<string, unknown> | undefined
      const rid = row?.request_id ? String(row.request_id).toLowerCase() : null
      if (!rid || seen.has(rid)) continue
      seen.add(rid)
      out.push({
        request_id: rid,
        at: iso(row?.created_at) ?? o.occurred_at,
        path: String(row?.path ?? '').split('?')[0],
        status: Number(row?.status ?? 500)
      })
    } catch {
      /* a log that cannot be read leaves the link out */
    }
  }
  return out
}

export function resetErrorClusterCache(): void {
  cache.clear()
}
