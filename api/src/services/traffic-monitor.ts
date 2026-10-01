// api/src/services/traffic-monitor.ts
/**
 * `traffic` ops monitor (#1124): judge one Traffic Map entity's live figures against a threshold
 * ("workflows errors > 5/min over 5 min"). Reads this API process's rings, like the map itself —
 * on several replicas each one judges its own traffic, and the monitor only fires where the
 * scheduled check runs. Never touches the database.
 */
import type { EvalResult } from './ops-monitors.js'
import { buildSnapshot } from './traffic-map.js'

export const TRAFFIC_METRICS = [
  'errors_per_min',
  'requests_per_min',
  'p95_ms',
  'error_pct'
] as const
export type TrafficMetric = (typeof TRAFFIC_METRICS)[number]

export interface TrafficMonitorConfig {
  /** `<lane>/<entity>` */
  entity?: string
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

export function normalizeTrafficConfig(
  cfg: TrafficMonitorConfig
): Required<TrafficMonitorConfig> | null {
  const entity = String(cfg.entity ?? '')
  if (!/^[a-z]+\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/.test(entity)) return null
  const metric = TRAFFIC_METRICS.includes(cfg.metric as TrafficMetric)
    ? (cfg.metric as TrafficMetric)
    : null
  const threshold = Number(cfg.threshold)
  if (!metric || !Number.isFinite(threshold) || threshold < 0) return null
  const w = Number(cfg.window_s)
  const window_s = w === 60 || w === 300 || w === 900 ? w : 300
  return { entity, metric, threshold, window_s }
}

export async function evalTraffic(cfg: TrafficMonitorConfig): Promise<EvalResult> {
  const c = normalizeTrafficConfig(cfg)
  if (!c) return { status: 'unknown', detail: 'Needs an entity, a metric and a threshold' }
  const snap = buildSnapshot(c.window_s as 60 | 300 | 900, {
    sockets: 0,
    users: 0,
    journalSeq: null
  })
  const row = snap.entities.find((e) => e.key === c.entity) ?? null
  const value = trafficMetricValue(c.metric, row, c.window_s)
  const shown = Math.round(value * 10) / 10
  const span = c.window_s === 60 ? 'the last minute' : `the last ${c.window_s / 60} minutes`
  if (value > c.threshold) {
    return {
      status: 'failing',
      metric: shown,
      detail: `${c.entity}: ${METRIC_TEXT[c.metric]} ${shown} over ${span} (limit ${c.threshold}, this API process)`
    }
  }
  return {
    status: 'ok',
    metric: shown,
    detail: `${c.entity}: ${METRIC_TEXT[c.metric]} ${shown} over ${span}`
  }
}
