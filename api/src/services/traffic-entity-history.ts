// api/src/services/traffic-entity-history.ts
/**
 * The Traffic Map's per-node reads that used to live inline in routes/traffic-map.ts, moved here
 * so the investigation panel (services/traffic-inspect/entities*.ts) can answer from exactly the
 * same logic as the inspector:
 *
 *  - entityTapDetails  — every tap's `entityDetail` for one entity (GET /entity-detail);
 *  - entityHistory     — 1h/6h/24h of one entity from the API log + open issues + slow traces
 *                        (GET /entity/:lane/:entity);
 *  - downNodeHistory   — 1h/6h/24h of one down node (GET /down/:id).
 *
 * Parameter validation stays in the route (and in the inspect sources); these trust their input.
 * A failed log read throws `HistoryUnavailableError` — "could not read" must never look like
 * "no traffic".
 */
import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { extensionRoutes } from '../extensions/loader.js'
import { hasColumn } from '../lib/column-probe.js'
import { listTraces } from './request-trace.js'
import { downHistoryFor } from './traffic-down-history.js'
import { pathTemplate, type TrafficLane } from './traffic-entities.js'
import {
  HISTORY_ROW_CAP,
  type HistoryNarrowing,
  type HistoryRow,
  historyNarrowing,
  issueMatch,
  issueRouteLikes,
  summarizeHistory,
  traceBelongsTo
} from './traffic-history.js'
import { currentTrafficSec, matchExtensionRoute } from './traffic-map.js'
import { trafficTaps } from './traffic-taps.js'

/** A history read failed (the log could not be read) — the route answers 503. */
export class HistoryUnavailableError extends Error {
  constructor(message = 'Traffic history could not be read right now') {
    super(message)
    this.name = 'HistoryUnavailableError'
  }
}

type Warn = (obj: Record<string, unknown>, msg: string) => void

/** Every tap's `entityDetail` for `key` (`<lane>/<entity>`) over the window, by tap id. */
export async function entityTapDetails(
  key: string,
  windowS: number,
  warn?: Warn
): Promise<Record<string, unknown>> {
  const sec = currentTrafficSec()
  const data: Record<string, unknown> = {}
  await Promise.all(
    trafficTaps()
      .filter((t) => t.entityDetail)
      .map(async (t) => {
        try {
          const v = await t.entityDetail?.(key, windowS, sec)
          if (v !== undefined) data[t.id] = v
        } catch (err) {
          warn?.({ err, tap: t.id }, 'traffic-map tap entity detail failed')
        }
      })
  )
  return data
}

/**
 * Narrow an `nivaro_api_logs` query to one entity's requests (the narrowing from
 * `historyNarrowing`). The LIKE patterns are already escaped there.
 */
export function applyHistoryNarrowing(q: Knex.QueryBuilder, n: HistoryNarrowing): void {
  q.where((b) => {
    if (n.column) {
      b.where((g) => {
        if (n.equals === null) g.whereNull(n.column as string)
        else g.where(n.column as string, n.equals as string)
        if (n.pathIn) g.whereIn('path', n.pathIn)
      })
    }
    for (const l of n.like ?? []) b.orWhereRaw("path LIKE ? ESCAPE '\\'", [l])
  })
}

/** One entity's history from the API log (+ open issues and kept slow traces). */
export async function entityHistory(
  lane: TrafficLane,
  entity: string,
  hours: 1 | 6 | 24,
  warn?: Warn
): Promise<Record<string, unknown>> {
  const extUrls = lane === 'extension' ? (extensionRoutes.get(entity) ?? []).map((r) => r.url) : []
  const since = new Date(Date.now() - hours * 3600_000)
  const n = historyNarrowing(lane, entity, extUrls)
  const q = db('nivaro_api_logs')
    .where('created_at', '>=', since)
    .orderBy('created_at', 'desc')
    .limit(HISTORY_ROW_CAP)
    .select(
      'method',
      'path',
      'status',
      'latency_ms',
      'auth',
      'api_key_id',
      'user',
      'graphql_operation',
      'graphql_kind',
      'created_at'
    )
  // #1139: the query string tells a dry run apart (a tenant behind migration 357 has none).
  if (await hasColumn('nivaro_api_logs', 'query').catch(() => false)) q.select('query')
  if (lane === 'extension' && !n.like?.length) {
    return summarizeHistory([], lane, entity, hours) as unknown as Record<string, unknown>
  }
  applyHistoryNarrowing(q, n)
  let logRows: HistoryRow[]
  try {
    logRows = (await q) as HistoryRow[]
  } catch (err) {
    warn?.({ err }, 'traffic-map entity history read failed')
    throw new HistoryUnavailableError()
  }
  const body = summarizeHistory(logRows, lane, entity, hours, new Date(), matchExtensionRoute)
  // #1102: by the issue's stored route (+ request URL for per-entity lanes), not its title.
  const im = issueMatch(lane, entity, extUrls)
  let issues: Array<Record<string, unknown>> = []
  if (im.routePrefixes.length) {
    const iq = db('nivaro_issues')
      .where('source', 'server')
      .whereNot('status', 'resolved')
      .where((b) => {
        for (const p of im.routePrefixes)
          for (const l of issueRouteLikes(p)) b.orWhereRaw("details LIKE ? ESCAPE '\\'", [l])
      })
    const urls = im.urlLike
    if (urls?.length) {
      iq.where((b) => {
        for (const l of urls) b.orWhereRaw("details LIKE ? ESCAPE '\\'", [l])
        b.orWhereRaw("details NOT LIKE '%Request context:%'")
      })
    }
    issues = (await Promise.resolve(
      iq
        .orderBy('last_seen_at', 'desc')
        .limit(10)
        .select('id', 'title', 'severity', 'status', 'occurrence_count', 'last_seen_at')
    ).catch(() => [])) as Array<Record<string, unknown>>
  }
  // Request traces are per process, not per tenant: cloud mode leaves them out (#1132).
  const slow = (process.env.CLOUD_META_DB_URL ? [] : listTraces(200))
    .filter((t) => traceBelongsTo(t, lane, entity, n.routePrefix, matchExtensionRoute))
    .slice(0, 5)
    .map((t) => ({ id: t.id, route: t.route, total_ms: t.total_ms, ts: t.ts }))
  return { ...body, issues, slow_traces: slow }
}

/** The map's own down nodes — attribution only, no history of their own. */
export const OWN_DOWN_NODES = new Set(['db', 'redis', 'store'])

export type DownHistoryResult =
  | { kind: 'ok'; data: Record<string, unknown> }
  /** Not a node any provider or the outbound log answers for. */
  | { kind: 'unknown' }

/** One down node's history: own nodes → a note; providers first; `ext:<id>` → outbound log. */
export async function downNodeHistory(
  id: string,
  hours: 1 | 6 | 24,
  warn?: Warn
): Promise<DownHistoryResult> {
  if (OWN_DOWN_NODES.has(id)) {
    return {
      kind: 'ok',
      data: {
        key: id,
        hours,
        series: [],
        note: 'Per-request attribution only — see DB Health for server-side figures.'
      }
    }
  }
  // Down nodes a feature added (email, AI, webhooks, extension nodes) bring their own log.
  try {
    const provided = await downHistoryFor(id, hours)
    if (provided) return { kind: 'ok', data: provided as unknown as Record<string, unknown> }
  } catch (err) {
    warn?.({ err }, 'traffic-map down-node history provider failed')
    throw new HistoryUnavailableError()
  }
  const m = id.match(/^ext:(\d{1,9})$/)
  if (!m) return { kind: 'unknown' }
  const since = new Date(Date.now() - hours * 3600_000)
  const bucketS = hours === 1 ? 60 : hours === 6 ? 300 : 900
  let logRows: Array<{
    method: string
    path: string | null
    status: number | null
    ok: boolean | number
    duration_ms: number
    created_at: Date
  }>
  try {
    logRows = await db('nivaro_outbound_log')
      .where('api_id', Number(m[1]))
      .where('created_at', '>=', since)
      .orderBy('created_at', 'desc')
      .limit(HISTORY_ROW_CAP)
      .select('method', 'path', 'status', 'ok', 'duration_ms', 'created_at')
  } catch (err) {
    warn?.({ err }, 'traffic-map down-node history read failed')
    throw new HistoryUnavailableError()
  }
  const start = Math.floor(since.getTime() / 1000)
  const points = (hours * 3600) / bucketS
  const series = Array.from({ length: points }, (_, i) => ({
    t: new Date((start + i * bucketS) * 1000).toISOString(),
    req: 0,
    error: 0,
    lat: [] as number[]
  }))
  const paths = new Map<string, number>()
  const codes: Record<string, number> = {}
  let error = 0
  let total = 0
  for (const r of logRows) {
    const i = Math.floor((Math.floor(new Date(r.created_at).getTime() / 1000) - start) / bucketS)
    if (i < 0 || i >= points) continue
    total++
    const failed = !(r.ok === true || r.ok === 1)
    series[i].req++
    if (failed) {
      series[i].error++
      error++
    }
    series[i].lat.push(r.duration_ms)
    // Templated like request routes, so `/orders/123` and `/orders/456` aggregate.
    const key = `${String(r.method || 'GET').toUpperCase()} ${pathTemplate(r.path ?? '').slice(0, 120)}`
    paths.set(key, (paths.get(key) ?? 0) + 1)
    const code = String(r.status ?? 'network')
    codes[code] = (codes[code] ?? 0) + 1
  }
  const p95 = (a: number[]) =>
    a.length
      ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * 0.95))]
      : 0
  return {
    kind: 'ok',
    data: {
      key: id,
      hours,
      bucket_s: bucketS,
      series: series.map((s) => ({ t: s.t, req: s.req, error: s.error, p95: p95(s.lat) })),
      totals: { req: total, error },
      status_codes: codes,
      top_paths: [...paths]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([path, n]) => ({ path, n })),
      truncated: logRows.length >= HISTORY_ROW_CAP
    }
  }
}
