// api/src/services/traffic-alert-preview.ts
/**
 * #2222 — before an alert is saved, replay it over the last two weeks of the request log: the
 * monitor is checked every CHECK_MIN minutes on the window that ends there, and every run of
 * failing checks is one moment it would have fired (it notifies on the ok → failing flip).
 *
 * One read of the entity's own rows (the history narrowing, then the live classifier, at most
 * PREVIEW_ROW_CAP newest rows), folded per minute; `replayMonitor()` is pure. A caller → entity
 * edge (#2247) filters the rows to that caller. A route → partner edge has no history (the
 * outbound log does not say which route made the call), so it answers `unsupported`.
 */
import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { extensionRoutes } from '../extensions/loader.js'
import { hasColumn } from '../lib/column-probe.js'
import { instanceScope } from './api-log-instances.js'
import { callerKeyFor, classifyRequest, entityKey, type TrafficLane } from './traffic-entities.js'
import { applyHistoryNarrowing } from './traffic-entity-history.js'
import { historyNarrowing } from './traffic-history.js'
import { matchExtensionRoute } from './traffic-map.js'
import {
  type NormalizedTrafficConfig,
  type TrafficMetric,
  trafficMetricValue
} from './traffic-monitor.js'

export const PREVIEW_DAYS = 14
export const CHECK_MIN = 5
export const PREVIEW_ROW_CAP = 200_000
export const EPISODE_CAP = 50

export interface MinuteBucket {
  n: number
  e: number
  lat: number[]
}
export interface Episode {
  /** Epoch ms of the first and last failing check. */
  from: number
  to: number
  /** Highest figure while failing. */
  peak: number
  checks: number
}
export interface PreviewResult {
  checks: number
  failing_checks: number
  /** Separate times it would have notified (ok → failing flips). */
  fired: number
  /** Newest first, at most EPISODE_CAP. */
  episodes: Episode[]
  /** Highest checked figure per hour, oldest first (for a sparkline). */
  hourly: number[]
  from: string
  to: string
  peak: number
}

function pct95(values: number[]): number {
  if (!values.length) return 0
  const a = values.slice().sort((x, y) => x - y)
  return Math.round(a[Math.min(a.length - 1, Math.floor(a.length * 0.95))])
}

/**
 * Replay a threshold over per-minute buckets (keys = epoch minutes). Checks run at every minute
 * divisible by CHECK_MIN in (startMin + window, endMin], each on the window minutes before it.
 */
export function replayMonitor(
  buckets: Map<number, MinuteBucket>,
  startMin: number,
  endMin: number,
  cfg: { metric: TrafficMetric; threshold: number; window_s: number }
): PreviewResult {
  const w = Math.max(1, Math.round(cfg.window_s / 60))
  const first = Math.ceil((startMin + w) / CHECK_MIN) * CHECK_MIN
  const hours = Math.max(1, Math.ceil((endMin - startMin) / 60))
  const hourly = new Array<number>(hours).fill(0)
  const episodes: Episode[] = []
  let cur: Episode | null = null
  let checks = 0
  let failing = 0
  let peak = 0
  for (let c = first; c <= endMin; c += CHECK_MIN) {
    let n = 0
    let e = 0
    const lat: number[] = []
    for (let m = c - w; m < c; m++) {
      const b = buckets.get(m)
      if (!b) continue
      n += b.n
      e += b.e
      if (cfg.metric === 'p95_ms') for (const v of b.lat) lat.push(v)
    }
    const value = trafficMetricValue(cfg.metric, { req: n, error: e, p95: pct95(lat) }, w * 60)
    checks++
    const hi = Math.min(hours - 1, Math.max(0, Math.floor((c - startMin) / 60)))
    if (value > hourly[hi]) hourly[hi] = Math.round(value * 10) / 10
    if (value > peak) peak = value
    if (value > cfg.threshold) {
      failing++
      // `cur` is cleared by every passing check, so a live episode means the previous check failed
      if (cur) {
        cur.to = c * 60_000
        cur.peak = Math.max(cur.peak, value)
        cur.checks++
      } else {
        cur = { from: c * 60_000, to: c * 60_000, peak: value, checks: 1 }
        episodes.push(cur)
      }
    } else cur = null
  }
  for (const ep of episodes) ep.peak = Math.round(ep.peak * 10) / 10
  return {
    checks,
    failing_checks: failing,
    fired: episodes.length,
    episodes: episodes.slice(-EPISODE_CAP).reverse(),
    hourly,
    from: new Date(startMin * 60_000).toISOString(),
    to: new Date(endMin * 60_000).toISOString(),
    peak: Math.round(peak * 10) / 10
  }
}

export type PreviewAnswer =
  | ({ kind: 'ok'; truncated: boolean; rows: number } & PreviewResult)
  | { kind: 'unsupported'; reason: string }

/** #2222 — the moments in the last PREVIEW_DAYS days this monitor would have fired. */
export async function previewTrafficAlert(
  cfg: NormalizedTrafficConfig,
  query: unknown = {},
  nowMs = Date.now()
): Promise<PreviewAnswer> {
  if (cfg.edge?.to)
    return {
      kind: 'unsupported',
      reason:
        'The request log does not record which route made a partner call, so a route → partner alert cannot be replayed. It is judged on live traffic only.'
    }
  const cut = cfg.entity.indexOf('/')
  const lane = cfg.entity.slice(0, cut) as TrafficLane
  const entity = cfg.entity.slice(cut + 1)
  const extUrls = lane === 'extension' ? (extensionRoutes.get(entity) ?? []).map((r) => r.url) : []
  const endMin = Math.floor(nowMs / 60_000)
  const startMin = endMin - PREVIEW_DAYS * 1440
  const narrowing = historyNarrowing(lane, entity, extUrls)
  const empty = replayMonitor(new Map(), startMin, endMin, cfg)
  if (lane === 'extension' && !narrowing.like?.length)
    return { kind: 'ok', truncated: false, rows: 0, ...empty }
  const gql = await hasColumn('nivaro_api_logs', 'graphql_operation').catch(() => false)
  const q: Knex.QueryBuilder = db('nivaro_api_logs')
    .where('created_at', '>=', new Date(startMin * 60_000))
    .orderBy('created_at', 'desc')
    .limit(PREVIEW_ROW_CAP)
    .select(
      'method',
      'path',
      'status',
      'latency_ms',
      'auth',
      'api_key_id',
      'user',
      'created_at',
      ...(gql ? ['graphql_operation', 'graphql_kind'] : [])
    )
  applyHistoryNarrowing(q, narrowing)
  const sc = await instanceScope(query)
  sc.apply(q)
  const rows = (await q) as Array<{
    method: string
    path: string
    status: number
    latency_ms: number
    auth: string | null
    api_key_id: number | null
    user: string | null
    created_at: Date | string
    graphql_operation?: string | null
    graphql_kind?: string | null
  }>
  const want = cfg.entity
  const buckets = new Map<number, MinuteBucket>()
  for (const r of rows) {
    let c = classifyRequest({
      method: r.method,
      path: r.path,
      graphqlOperation: r.graphql_operation,
      graphqlKind: r.graphql_kind
    })
    if (c?.lane === 'other') {
      const ext = matchExtensionRoute(r.method, r.path)
      if (ext) c = classifyRequest({ method: r.method, path: r.path, extensionId: ext })
    }
    if (!c || entityKey(c.lane, c.entity) !== want) continue
    if (
      cfg.edge?.from &&
      callerKeyFor({ authMethod: r.auth, apiKeyId: r.api_key_id, userId: r.user }) !== cfg.edge.from
    )
      continue
    const m = Math.floor(new Date(r.created_at).getTime() / 60_000)
    let b = buckets.get(m)
    if (!b) {
      b = { n: 0, e: 0, lat: [] }
      buckets.set(m, b)
    }
    b.n++
    if (Number(r.status) >= 400) b.e++
    if (cfg.metric === 'p95_ms') b.lat.push(Number(r.latency_ms) || 0)
  }
  return {
    kind: 'ok',
    truncated: rows.length >= PREVIEW_ROW_CAP,
    rows: rows.length,
    ...replayMonitor(buckets, startMin, endMin, cfg)
  }
}
