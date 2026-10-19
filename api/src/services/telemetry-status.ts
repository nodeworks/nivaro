// api/src/services/telemetry-status.ts
/**
 * Everything the Telemetry page shows about the external telemetry stack (#2544), in one read:
 *
 *  - settings  — what this instance is configured to send and read (URLs as host only, tokens as
 *                set / not set — never their values)
 *  - egress    — what THIS process sent: access lines written, traces queued / sent / dropped
 *  - arrival   — what the stores actually hold for this instance's env in the last hour
 *  - stack     — the stack's own view from its metrics store: scrape targets, firing alerts,
 *                uptime checks, backup age, disk and share space
 *
 * Every part is read on its own; one failing never blanks the others (it reports its error).
 * Queries are fixed expressions from this file. Cached 30 seconds.
 */
import { instanceKey } from './instance-key.js'
import {
  accessLineStats,
  accessLogEnabled,
  baseFilter,
  logsQuery,
  lq,
  type MetricSample,
  metricsQuery,
  type StoreStatus,
  storeConfig,
  storeStatus
} from './telemetry-store.js'
import { type TraceExportStats, traceExportConfig, traceExportStats } from './trace-export.js'

const hostOf = (url: string | undefined | null): string | null => {
  if (!url) return null
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

export interface TelemetrySettings {
  access_log: boolean
  store: {
    configured: boolean
    host: string | null
    env: string | null
    token_set: boolean
  }
  traces: {
    configured: boolean
    host: string | null
    token_set: boolean
    sample: number | null
    env: string | null
    service: string | null
  }
  grafana_url: string | null
  cloud: boolean
}

export interface StackPart<T> {
  items: T[]
  error: string | null
}

export interface TelemetryStatus {
  settings: TelemetrySettings
  egress: {
    instance: string
    access_lines: { written: number; since: string }
    traces: TraceExportStats
  }
  arrival: {
    store: StoreStatus
    access_lines_1h: number | null
    traces_1h: number | null
    error: string | null
  }
  stack: {
    targets: StackPart<{ job: string; instance: string; host: string | null; up: boolean }>
    alerts: StackPart<{
      name: string
      severity: string
      host: string | null
      subject: string | null
    }>
    uptime: StackPart<{ group: string; name: string; ok: boolean }>
    backups: StackPart<{ part: string; age_s: number }>
    space: StackPart<{
      host: string | null
      mountpoint: string
      fstype: string
      free_pct: number
      free_bytes: number | null
    }>
  }
  computed_at: string
}

export function telemetrySettings(): TelemetrySettings {
  const store = storeConfig()
  const traces = traceExportConfig()
  const grafana = process.env.TELEMETRY_GRAFANA_URL?.trim() || null
  return {
    access_log: accessLogEnabled(),
    store: {
      configured: !!store,
      host: hostOf(store?.url),
      env: store?.env ?? null,
      token_set: !!store?.token
    },
    traces: {
      configured: !!traces,
      host: hostOf(traces?.url),
      token_set: !!traces?.token,
      sample: traces?.sample ?? null,
      env: traces?.env ?? null,
      service: traces?.service ?? null
    },
    grafana_url: grafana && /^https?:\/\//i.test(grafana) ? grafana : null,
    cloud: !!process.env.CLOUD_META_DB_URL
  }
}

const errText = (err: unknown) => (err instanceof Error ? err.message : 'unavailable')

async function part<T>(expr: string, map: (s: MetricSample) => T | null): Promise<StackPart<T>> {
  try {
    const rows = await metricsQuery(expr)
    return { items: rows.map(map).filter((x): x is T => x != null), error: null }
  } catch (err) {
    return { items: [], error: errText(err) }
  }
}

let cache: { at: number; value: TelemetryStatus } | null = null

export function resetTelemetryStatusForTests(): void {
  cache = null
}

export async function telemetryStatus(nowMs = Date.now()): Promise<TelemetryStatus> {
  if (cache && nowMs - cache.at < 30_000) return cache.value
  const settings = telemetrySettings()
  const cfg = storeConfig()
  const hourAgo = nowMs - 3600_000

  const arrivalP = (async () => {
    const out = {
      access_lines_1h: null as number | null,
      traces_1h: null as number | null,
      error: null as string | null
    }
    if (!cfg) return out
    const [lines, traces] = await Promise.allSettled([
      logsQuery(`${baseFilter(cfg.env)} | stats count() as n`, hourAgo, nowMs),
      logsQuery(
        `"resource_attr:service.name":=${lq(settings.traces.service ?? 'nivaro-api')}${
          settings.traces.env
            ? ` "resource_attr:deployment.environment.name":=${lq(settings.traces.env)}`
            : ''
        } | stats count_uniq(trace_id) as n`,
        hourAgo,
        nowMs,
        { store: 'traces' }
      )
    ])
    if (lines.status === 'fulfilled') out.access_lines_1h = Number(lines.value[0]?.n ?? 0)
    else out.error = errText(lines.reason)
    if (traces.status === 'fulfilled') out.traces_1h = Number(traces.value[0]?.n ?? 0)
    else out.error = out.error ?? errText(traces.reason)
    return out
  })()

  const none = <T>(): StackPart<T> => ({
    items: [],
    error: 'The telemetry store is not configured'
  })
  const stackP = cfg
    ? Promise.all([
        part('up', (s) => ({
          job: s.labels.job ?? '?',
          instance: s.labels.instance ?? '',
          host: s.labels.host ?? null,
          up: s.value === 1
        })),
        part('ALERTS{alertstate="firing",alertname!="Watchdog"}', (s) => ({
          name: s.labels.alertname ?? '?',
          severity: s.labels.severity ?? 'warning',
          host: s.labels.host ?? null,
          subject:
            s.labels.mountpoint ?? s.labels.container ?? s.labels.job ?? s.labels.part ?? null
        })),
        part('gatus_results_endpoint_success', (s) => ({
          group: s.labels.group ?? '',
          name: s.labels.name ?? '?',
          ok: s.value === 1
        })),
        part('time() - max by (part) (efp_backup_last_success_timestamp_seconds)', (s) =>
          s.labels.part ? { part: s.labels.part, age_s: Math.round(s.value) } : null
        ),
        part(
          'node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"} / node_filesystem_size_bytes{fstype!~"tmpfs|overlay"}',
          (s) =>
            Number.isFinite(s.value)
              ? {
                  host: s.labels.host ?? null,
                  mountpoint: s.labels.mountpoint ?? '?',
                  fstype: s.labels.fstype ?? '',
                  free_pct: Math.round(s.value * 1000) / 10,
                  free_bytes: null
                }
              : null
        )
      ])
    : Promise.resolve([none(), none(), none(), none(), none()] as const)

  const [store, arrival, stack] = await Promise.all([storeStatus(nowMs), arrivalP, stackP])
  const [targets, alerts, uptime, backups, space] = stack as [
    TelemetryStatus['stack']['targets'],
    TelemetryStatus['stack']['alerts'],
    TelemetryStatus['stack']['uptime'],
    TelemetryStatus['stack']['backups'],
    TelemetryStatus['stack']['space']
  ]
  targets.items.sort((a, b) => Number(a.up) - Number(b.up) || a.job.localeCompare(b.job))
  uptime.items.sort(
    (a, b) =>
      Number(a.ok) - Number(b.ok) || a.group.localeCompare(b.group) || a.name.localeCompare(b.name)
  )
  space.items.sort((a, b) => a.free_pct - b.free_pct)
  alerts.items.sort(
    (a, b) => (a.severity === 'critical' ? -1 : 0) - (b.severity === 'critical' ? -1 : 0)
  )

  const value: TelemetryStatus = {
    settings,
    egress: {
      instance: instanceKey().slice(0, 60),
      access_lines: accessLineStats(),
      traces: traceExportStats()
    },
    arrival: { store, ...arrival },
    stack: { targets, alerts, uptime, backups, space },
    computed_at: new Date(nowMs).toISOString()
  }
  cache = { at: nowMs, value }
  return value
}
