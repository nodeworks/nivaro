/**
 * Operations reads (admin): readiness, detailed health, this process's runtime
 * stats, the instance roster, the DB connection pool, expensive SQL, the
 * Traffic Map snapshot, the background-job registry + run history, and a
 * summarized CPU profile of the replica that answers.
 */
import { type Command, cmd } from '../command.js'
import type { ISODate, UUID } from '../index.js'

// ─── Health ───────────────────────────────────────────────────────────────────

export interface ReadyReport {
  ready: boolean
  checks: Array<{ id: string; ok: boolean; summary: string }>
}

/** May traffic be routed here? Public; answers 503 (with the same body) when not ready. */
export function readReadiness(): Command<ReadyReport> {
  return cmd('GET', '/ready')
}

export interface HealthDetailed {
  db: { ok: boolean; latency_ms: number }
  redis: { ok: boolean; latency_ms: number }
  migrations: { latest: string | null; count: number }
  sockets: { connections: number | null }
  read_gate?: Record<string, unknown>
  redis_degradation?: { redis_ok: boolean; consumers: Array<Record<string, unknown>> }
  db_posture?: unknown
  uptime_s: number
  version: string
  node_version: string
  memory_mb: number
}

/** Subsystem diagnostics for the replica that answers (admin). */
export function readHealthDetailed(): Command<{ data: HealthDetailed }> {
  return cmd('GET', '/health/detailed')
}

// ─── Runtime ──────────────────────────────────────────────────────────────────

export interface PoolStats {
  used: number
  free: number
  pending_acquires: number
  pending_creates: number
  max: number
}

export interface RuntimeStats {
  uptime_seconds: number
  rss_mb: number
  heap_used_mb: number
  heap_total_mb: number
  event_loop_lag_ms: { current: number; max_1m: number }
  pool: PoolStats
}

/** Memory, event-loop lag and pool of the replica that answers (admin). */
export function readRuntimeStats(): Command<{ data: RuntimeStats }> {
  return cmd('GET', '/ops-runtime/runtime')
}

/** Every registered API process, plus which one holds the scheduler lease (admin). */
export function readInstanceRoster(): Command<{
  data: Array<Record<string, unknown>>
  scheduler: Record<string, unknown> | null
}> {
  return cmd('GET', '/ops-runtime/roster')
}

export interface CpuProfileSummary {
  /** The saved .cpuprofile, downloadable from /ops-runtime/cpu-profile/:name. */
  name: string
  seconds: number
  busy_ms: number
  idle_ms: number
  gc_ms: number
  self: Array<{ fn: string; where: string; ms: number }>
  files: Array<{ where: string; ms: number }>
  ours: Array<{ fn: string; where: string; ms: number }>
}

/** Sample the answering replica's CPU for `seconds` (1–30, default 10) and summarize it
 *  (admin). One at a time (409); refused in cloud mode (403). */
export function captureCpuProfile(seconds?: number): Command<{ data: CpuProfileSummary }> {
  return cmd('POST', '/ops-runtime/cpu-profile', undefined, seconds ? { seconds } : {})
}

// ─── Database ─────────────────────────────────────────────────────────────────

/** A DMV panel: rows, or why the database login cannot read them. */
export type DmvResult<T> = { data: T } | { unavailable: string }

/** The connection pool right now, with the requests holding connections (admin). */
export function readDbPool(): Command<{
  data: PoolStats & {
    held: Array<{ held_ms: number; hint: string | null }>
    pressure: Record<string, unknown>
  }
}> {
  return cmd('GET', '/ops-db/pool')
}

export interface ExpensiveStatement {
  total_cpu_ms: number
  execution_count: number
  avg_cpu_ms: number
  avg_elapsed_ms: number
  last_execution_time: ISODate
  statement_text: string
}

/** The 15 statements with the most total CPU since the plan cache last cleared (admin). */
export function readExpensiveSql(): Command<DmvResult<ExpensiveStatement[]>> {
  return cmd('GET', '/ops-db/expensive-sql')
}

// ─── Traffic Map ──────────────────────────────────────────────────────────────

export interface TrafficSnapshotEntity {
  key: string
  lane: string
  entity: string
  label: string
  system: boolean
  req: number
  read: number
  create: number
  update: number
  delete: number
  error: number
  p50: number
  p95: number
  routes: Array<{ route: string; n: number }>
  callers: Array<{ key: string; n: number }>
  [key: string]: unknown
}

export interface TrafficSnapshot {
  instance: string
  node_scope: string
  at: ISODate
  window_s: number
  uptime_s: number
  entities: TrafficSnapshotEntity[]
  callers: Array<{ key: string; req: number; error: number }>
  down: Array<{ id: string; label: string; kind: string; req: number; error: number; p95: number }>
  totals: {
    req: number
    read: number
    create: number
    update: number
    delete: number
    error: number
    p50: number
    p95: number
    outbound_req: number
    outbound_error: number
  }
  sockets: { count: number; users: number }
  sources?: Array<{ id: string; label: string; kind: string; req: number; error: number }>
  [key: string]: unknown
}

/** The live Traffic Map over the last `window` seconds (60, 300 or 900; admin). */
export function readTrafficSnapshot(
  window: 60 | 300 | 900 = 60
): Command<{ data: TrafficSnapshot }> {
  return cmd('GET', '/traffic-map/snapshot', { window })
}

// ─── Background jobs ──────────────────────────────────────────────────────────

export interface JobRun {
  id: number
  kind: string
  job_id: string
  label: string | null
  extension_id: string | null
  status: string
  started_at: ISODate
  finished_at: ISODate | null
  duration_ms: number | null
  outcome: string | null
  error: string | null
  progress: string | null
  triggered_by: UUID | null
  triggered_by_name?: string | null
}

export interface JobRegistryCron {
  id: string
  expression: string
  default_expression: string
  overridden: boolean
  extension_id: string | null
  next_run: ISODate | null
  paused: boolean
  heavy: boolean
  idempotent: boolean | 'unknown'
  description: string | null
  timezone: string | null
  last: {
    status: string
    started_at: ISODate
    duration_ms: number | null
    outcome: string | null
    error: string | null
  } | null
  errors_7d: number
  [key: string]: unknown
}

/** Every scheduled job with its latest run and 7-day error count, plus what is running now
 *  (admin). */
export function readJobRegistry(): Command<{
  data: {
    crons: JobRegistryCron[]
    ticks_enabled: boolean
    scheduler: Record<string, unknown> | null
    running: JobRun[]
  }
}> {
  return cmd('GET', '/job-runs/registry')
}

/** Background-job run history, newest first (admin). `job_id` is a contains-match. */
export function listJobRuns(query?: {
  kind?: string
  job_id?: string
  status?: string
  page?: number
  limit?: number
}): Command<{ data: JobRun[]; total: number }> {
  const params: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== '') params[k] = v
  return cmd('GET', '/job-runs', params)
}
