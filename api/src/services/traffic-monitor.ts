// api/src/services/traffic-monitor.ts
/**
 * `traffic` ops monitor (#1124): judge one Traffic Map entity's live figures against a threshold
 * ("workflows errors > 5/min over 5 min"). Reads this API process's rings, like the map itself —
 * on several replicas each one judges its own traffic, and the monitor only fires where the
 * scheduled check runs. Never touches the database.
 */
import type { EvalResult } from './ops-monitors.js'
import { buildSnapshot, currentTrafficSec } from './traffic-map.js'
import { entityCallerCounts } from './traffic-taps/entity-callers.js'
import { partnerEdgeTotals } from './traffic-taps/what-changed.js'

export const TRAFFIC_METRICS = [
  'errors_per_min',
  'requests_per_min',
  'p95_ms',
  'error_pct'
] as const
export type TrafficMetric = (typeof TRAFFIC_METRICS)[number]

/** #2247 — an edge instead of the whole node: a caller's traffic INTO the entity (`from`), or the
 *  entity's calls OUT to a partner / down node (`to`). Exactly one side. */
export interface TrafficEdge {
  from?: string
  to?: string
}
export interface TrafficMonitorConfig {
  /** `<lane>/<entity>` */
  entity?: string
  edge?: TrafficEdge | null
  metric?: TrafficMetric
  threshold?: number
  /** 60 | 300 | 900 */
  window_s?: number
}

export const METRIC_TEXT: Record<TrafficMetric, string> = {
  errors_per_min: 'errors per minute',
  requests_per_min: 'requests per minute',
  p95_ms: 'p95 latency (ms)',
  error_pct: 'error rate (%)'
}

/** The figure a metric reads off an entity's window totals. */
export function trafficMetricValue(
  metric: TrafficMetric,
  row: { req: number; error: number; p95: number } | null,
  windowS: number
): number {
  if (!row) return 0
  const minutes = windowS / 60
  if (metric === 'errors_per_min') return row.error / minutes
  if (metric === 'requests_per_min') return row.req / minutes
  if (metric === 'p95_ms') return row.p95
  return row.req ? (100 * row.error) / row.req : 0
}

const CALLER_RE = /^(k\d{1,12}|u[0-9A-F-]{36}|cron|anon)$/
const DOWN_RE = /^(db|redis|store|ext:\d{1,12}|[a-z]{1,20}:[A-Za-z0-9_.:-]{1,80})$/

/** A valid edge (one side only), or null. */
export function normalizeEdge(edge: unknown): TrafficEdge | null {
  if (!edge || typeof edge !== 'object') return null
  const e = edge as TrafficEdge
  const from = typeof e.from === 'string' ? e.from : ''
  const to = typeof e.to === 'string' ? e.to : ''
  if (from && !to && CALLER_RE.test(from)) return { from }
  if (to && !from && DOWN_RE.test(to)) return { to }
  return null
}

export type NormalizedTrafficConfig = Required<Omit<TrafficMonitorConfig, 'edge'>> & {
  edge?: TrafficEdge
}

/** "workflows", "u… → workflows" or "workflows → ext:9". */
export function edgeLabel(entity: string, edge?: TrafficEdge | null): string {
  if (edge?.from) return `${edge.from} → ${entity}`
  if (edge?.to) return `${entity} → ${edge.to}`
  return entity
}

export function normalizeTrafficConfig(cfg: TrafficMonitorConfig): NormalizedTrafficConfig | null {
  const entity = String(cfg.entity ?? '')
  if (!/^[a-z]+\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/.test(entity)) return null
  const metric = TRAFFIC_METRICS.includes(cfg.metric as TrafficMetric)
    ? (cfg.metric as TrafficMetric)
    : null
  const threshold = Number(cfg.threshold)
  if (!metric || !Number.isFinite(threshold) || threshold < 0) return null
  const w = Number(cfg.window_s)
  const window_s = w === 60 || w === 300 || w === 900 ? w : 300
  if (cfg.edge != null) {
    const edge = normalizeEdge(cfg.edge)
    if (!edge) return null
    return { entity, metric, threshold, window_s, edge }
  }
  return { entity, metric, threshold, window_s }
}

/** The window totals an edge carries on this process (null = nothing counted). */
export function edgeRow(
  entity: string,
  edge: TrafficEdge,
  windowS: number,
  sec = currentTrafficSec()
): { req: number; error: number; p95: number } | null {
  if (edge.from) {
    const s = entityCallerCounts(entity, windowS, sec)?.[edge.from]
    return s ? { req: s[0] ?? 0, error: s[5] ?? 0, p95: s[6] ?? 0 } : null
  }
  if (edge.to) {
    const t = partnerEdgeTotals(`${entity}>${edge.to}`, windowS, sec)
    return t.req > 0 ? t : null
  }
  return null
}

export async function evalTraffic(cfg: TrafficMonitorConfig): Promise<EvalResult> {
  const c = normalizeTrafficConfig(cfg)
  if (!c) return { status: 'unknown', detail: 'Needs an entity, a metric and a threshold' }
  const row = c.edge
    ? edgeRow(c.entity, c.edge, c.window_s)
    : (buildSnapshot(c.window_s as 60 | 300 | 900, {
        sockets: 0,
        users: 0,
        journalSeq: null
      }).entities.find((e) => e.key === c.entity) ?? null)
  const value = trafficMetricValue(c.metric, row, c.window_s)
  const shown = Math.round(value * 10) / 10
  const span = c.window_s === 60 ? 'the last minute' : `the last ${c.window_s / 60} minutes`
  const name = edgeLabel(c.entity, c.edge)
  if (value > c.threshold) {
    return {
      status: 'failing',
      metric: shown,
      detail: `${name}: ${METRIC_TEXT[c.metric]} ${shown} over ${span} (limit ${c.threshold}, this API process)`
    }
  }
  return {
    status: 'ok',
    metric: shown,
    detail: `${name}: ${METRIC_TEXT[c.metric]} ${shown} over ${span}`
  }
}
