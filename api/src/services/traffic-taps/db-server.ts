// api/src/services/traffic-taps/db-server.ts
/**
 * #2265 — what the database SERVER itself is short of, on the map's database node, beside the
 * connection pool (what this API waits for) and blocking chains (who waits on whom). Read from
 * SQL Server's own dynamic views, never more often than every SAMPLE_S seconds and only while the
 * map is watched (frames drive the sample, like the blocking tap):
 *   - CPU       sys.dm_os_ring_buffers scheduler monitor: SQL's share and everything else's
 *   - IO waits  sys.dm_os_wait_stats DELTAS between two samples (the view is cumulative since the
 *               server started): data-file reads, log flushes, other IO, lock waits — ms of wait
 *               per second of wall clock, i.e. about how many sessions are waiting on that
 *   - memory    sys.dm_exec_query_memory_grants: grants held and queries WAITING for one, and the
 *               server's memory against the machine's
 *   - tempdb    tempdb.sys.dm_db_file_space_usage: user objects, internal (sorts, hashes), the
 *               version store and what is left
 *
 * SQL Server only; never in cloud mode (the views are server-wide and would describe other
 * tenants). Needs VIEW SERVER STATE — without it the sample says so (`available: false`) and the
 * node keeps working. Admin only (the route is under the Traffic Map's admin gate).
 */

import { isMssql } from '../../db/dialect.js'
import { db } from '../../db/index.js'
import { registerTrafficTap, tapState } from '../traffic-taps.js'

export const DB_SERVER_TAP = 'db-server'
/** Seconds between samples while the map is watched (the cache lifetime of a read). */
export const SAMPLE_S = 15
/** A sample older than this is not sent or served. */
const FRESH_S = 60
const CPU_POINTS = 10

export type ServerLevel = 'ok' | 'warn' | 'error'

/** Cumulative wait milliseconds per class, since the server started. */
export interface WaitTotals {
  data_io: number
  log_io: number
  other_io: number
  locks: number
  signal: number
  total: number
}
export const WAIT_CLASSES = ['data_io', 'log_io', 'other_io', 'locks', 'signal', 'total'] as const

/** Wait milliseconds per second of wall clock, per class. */
export type WaitRates = Record<(typeof WAIT_CLASSES)[number], number>

export interface DbServerSample {
  /** Epoch ms. */
  at: number
  available: boolean
  error?: string
  cpu: {
    /** Share of the machine's CPU SQL Server used / everything else used, newest minute. */
    sql_pct: number
    other_pct: number
    /** SQL Server's share per minute, newest last. */
    series: number[]
  } | null
  /** Null on the first sample (a delta needs two). */
  waits: WaitRates | null
  memory: {
    grants_held: number
    grants_waiting: number
    granted_mb: number
    requested_mb: number
    /** Longest a query has waited for its grant (ms). */
    max_wait_ms: number
    sql_used_mb: number | null
    machine_total_mb: number | null
    machine_free_mb: number | null
  } | null
  tempdb: {
    total_mb: number
    user_mb: number
    internal_mb: number
    version_mb: number
    free_mb: number
    used_pct: number
  } | null
  level: ServerLevel
  /** Why the level is not ok, in plain words. */
  reasons: string[]
}

// ── pure ──────────────────────────────────────────────────────────────────────

/** Per-second wait rates between two cumulative readings; null when they cannot be compared
 *  (the server restarted and the counters went backwards, or no time passed). Pure. */
export function waitRates(prev: WaitTotals, cur: WaitTotals, dtMs: number): WaitRates | null {
  if (!(dtMs > 0)) return null
  const out = {} as WaitRates
  for (const k of WAIT_CLASSES) {
    const d = cur[k] - prev[k]
    if (!Number.isFinite(d) || d < 0) return null
    out[k] = Math.round((d / dtMs) * 1000 * 10) / 10
  }
  return out
}

export const THRESHOLDS = {
  cpu_warn: 85,
  cpu_error: 95,
  /** Data-file read wait, ms per second (≈ sessions waiting on the disk). */
  io_warn: 200,
  io_error: 1000,
  log_warn: 100,
  log_error: 500,
  /** Queries waiting for a memory grant. */
  grant_warn: 1,
  grant_error: 5,
  grant_wait_error_ms: 30_000,
  tempdb_warn: 70,
  tempdb_error: 90
}

/** The sample's overall level and the plain-language reasons it is not ok. Pure. */
export function serverLevel(s: Pick<DbServerSample, 'cpu' | 'waits' | 'memory' | 'tempdb'>): {
  level: ServerLevel
  reasons: string[]
} {
  const T = THRESHOLDS
  let level: ServerLevel = 'ok'
  const reasons: string[] = []
  const rank: Record<ServerLevel, number> = { ok: 0, warn: 1, error: 2 }
  const bump = (to: ServerLevel, why: string) => {
    reasons.push(why)
    if (rank[to] > rank[level]) level = to
  }
  if (s.cpu) {
    const total = s.cpu.sql_pct + s.cpu.other_pct
    if (s.cpu.sql_pct >= T.cpu_error)
      bump('error', `SQL Server is using ${s.cpu.sql_pct}% of the CPU`)
    else if (s.cpu.sql_pct >= T.cpu_warn || total >= T.cpu_error)
      bump('warn', `CPU is ${Math.max(s.cpu.sql_pct, total)}% busy`)
  }
  if (s.waits) {
    if (s.waits.data_io >= T.io_error) bump('error', 'Queries are queuing for disk reads')
    else if (s.waits.data_io >= T.io_warn) bump('warn', 'Disk reads are slowing queries')
    if (s.waits.log_io >= T.log_error) bump('error', 'Transaction log writes are queuing')
    else if (s.waits.log_io >= T.log_warn) bump('warn', 'Transaction log writes are slowing writes')
  }
  if (s.memory) {
    if (s.memory.grants_waiting >= T.grant_error || s.memory.max_wait_ms >= T.grant_wait_error_ms)
      bump('error', `${s.memory.grants_waiting} queries are waiting for memory to run`)
    else if (s.memory.grants_waiting >= T.grant_warn)
      bump('warn', `${s.memory.grants_waiting} query waiting for memory to run`)
  }
  if (s.tempdb) {
    if (s.tempdb.used_pct >= T.tempdb_error) bump('error', `tempdb is ${s.tempdb.used_pct}% full`)
    else if (s.tempdb.used_pct >= T.tempdb_warn)
      bump('warn', `tempdb is ${s.tempdb.used_pct}% full`)
  }
  return { level, reasons }
}

const n = (v: unknown): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}
const r1 = (v: number) => Math.round(v * 10) / 10

/** Scheduler-monitor rows (newest first) → CPU shares. Pure. */
export function cpuFromRows(
  rows: Array<{ sql_cpu: unknown; idle: unknown }>
): DbServerSample['cpu'] {
  if (!rows.length) return null
  const pts = rows.map((r) => ({
    sql: Math.max(0, Math.min(100, n(r.sql_cpu))),
    idle: Math.max(0, Math.min(100, n(r.idle)))
  }))
  const newest = pts[0]
  return {
    sql_pct: newest.sql,
    other_pct: Math.max(0, 100 - newest.idle - newest.sql),
    series: pts
      .slice(0, CPU_POINTS)
      .map((p) => p.sql)
      .reverse()
  }
}

// ── reads ─────────────────────────────────────────────────────────────────────

interface State {
  latest: DbServerSample | null
  prevWaits: { at: number; totals: WaitTotals } | null
  sentAt: number
  startedAt: number
  inflight: boolean
}
const state = (): State =>
  tapState<State>(DB_SERVER_TAP, () => ({
    latest: null,
    prevWaits: null,
    sentAt: 0,
    startedAt: 0,
    inflight: false
  }))

const permission = (msg: string) => /permission|VIEW SERVER STATE|denied/i.test(msg)

async function readOne<T>(sql: string): Promise<T[]> {
  const res = (await db.raw(sql)) as unknown
  return (Array.isArray(res) ? res : ((res as { recordset?: T[] })?.recordset ?? [])) as T[]
}

/** One sample now. Each view degrades on its own: one the login cannot read leaves its part null. */
export async function sampleDbServer(): Promise<DbServerSample> {
  const at = Date.now()
  const empty = (error: string): DbServerSample => ({
    at,
    available: false,
    error,
    cpu: null,
    waits: null,
    memory: null,
    tempdb: null,
    level: 'ok',
    reasons: []
  })
  if (process.env.CLOUD_META_DB_URL) return empty('Not in cloud mode')
  if (!isMssql(db)) return empty('Server resources are read from SQL Server only')
  const st = state()
  let denied = false
  const guard = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn()
    } catch (err) {
      if (permission(err instanceof Error ? err.message : String(err))) denied = true
      return null
    }
  }

  const [cpuRows, waitRows, grantRows, sysMem, tempRows] = await Promise.all([
    guard(() =>
      readOne<{ sql_cpu: number; idle: number }>(
        `SELECT TOP (${CPU_POINTS})
                record.value('(./Record/SchedulerMonitorEvent/SystemHealth/ProcessUtilization)[1]', 'int') AS sql_cpu,
                record.value('(./Record/SchedulerMonitorEvent/SystemHealth/SystemIdle)[1]', 'int') AS idle
           FROM (SELECT [timestamp], CONVERT(xml, record) AS record
                   FROM sys.dm_os_ring_buffers
                  WHERE ring_buffer_type = N'RING_BUFFER_SCHEDULER_MONITOR'
                    AND record LIKE N'%<SystemHealth>%') x
          ORDER BY [timestamp] DESC`
      )
    ),
    guard(() =>
      readOne<Record<string, number | null>>(
        `SELECT SUM(CASE WHEN wait_type LIKE N'PAGEIOLATCH[_]%' THEN wait_time_ms ELSE 0 END) AS data_io,
                SUM(CASE WHEN wait_type IN (N'WRITELOG', N'LOGBUFFER') THEN wait_time_ms ELSE 0 END) AS log_io,
                SUM(CASE WHEN wait_type IN (N'IO_COMPLETION', N'ASYNC_IO_COMPLETION', N'BACKUPIO') THEN wait_time_ms ELSE 0 END) AS other_io,
                SUM(CASE WHEN wait_type LIKE N'LCK[_]M[_]%' THEN wait_time_ms ELSE 0 END) AS locks,
                SUM(signal_wait_time_ms) AS signal,
                SUM(wait_time_ms) AS total
           FROM sys.dm_os_wait_stats`
      )
    ),
    guard(() =>
      readOne<Record<string, number | null>>(
        `SELECT SUM(CASE WHEN grant_time IS NOT NULL THEN 1 ELSE 0 END) AS held,
                SUM(CASE WHEN grant_time IS NULL THEN 1 ELSE 0 END) AS waiting,
                SUM(CAST(COALESCE(granted_memory_kb, 0) AS bigint)) AS granted_kb,
                SUM(CAST(COALESCE(requested_memory_kb, 0) AS bigint)) AS requested_kb,
                MAX(CASE WHEN grant_time IS NULL THEN wait_time_ms ELSE 0 END) AS max_wait_ms
           FROM sys.dm_exec_query_memory_grants`
      )
    ),
    guard(() =>
      readOne<Record<string, number | null>>(
        `SELECT (SELECT physical_memory_in_use_kb FROM sys.dm_os_process_memory) AS sql_kb,
                total_physical_memory_kb AS total_kb,
                available_physical_memory_kb AS free_kb
           FROM sys.dm_os_sys_memory`
      )
    ),
    guard(() =>
      readOne<Record<string, number | null>>(
        `SELECT SUM(CAST(total_page_count AS bigint)) * 8 / 1024.0 AS total_mb,
                SUM(CAST(user_object_reserved_page_count AS bigint)) * 8 / 1024.0 AS user_mb,
                SUM(CAST(internal_object_reserved_page_count AS bigint)) * 8 / 1024.0 AS internal_mb,
                SUM(CAST(version_store_reserved_page_count AS bigint)) * 8 / 1024.0 AS version_mb,
                SUM(CAST(unallocated_extent_page_count AS bigint)) * 8 / 1024.0 AS free_mb
           FROM tempdb.sys.dm_db_file_space_usage`
      )
    )
  ])

  const cpu = cpuRows ? cpuFromRows(cpuRows) : null
  let waits: WaitRates | null = null
  const w = waitRows?.[0]
  if (w) {
    const totals: WaitTotals = {
      data_io: n(w.data_io),
      log_io: n(w.log_io),
      other_io: n(w.other_io),
      locks: n(w.locks),
      signal: n(w.signal),
      total: n(w.total)
    }
    if (st.prevWaits) waits = waitRates(st.prevWaits.totals, totals, at - st.prevWaits.at)
    st.prevWaits = { at, totals }
  }
  const g = grantRows?.[0]
  const m = sysMem?.[0]
  const memory: DbServerSample['memory'] =
    g || m
      ? {
          grants_held: n(g?.held),
          grants_waiting: n(g?.waiting),
          granted_mb: Math.round(n(g?.granted_kb) / 1024),
          requested_mb: Math.round(n(g?.requested_kb) / 1024),
          max_wait_ms: n(g?.max_wait_ms),
          sql_used_mb: m?.sql_kb != null ? Math.round(n(m.sql_kb) / 1024) : null,
          machine_total_mb: m?.total_kb != null ? Math.round(n(m.total_kb) / 1024) : null,
          machine_free_mb: m?.free_kb != null ? Math.round(n(m.free_kb) / 1024) : null
        }
      : null
  const t = tempRows?.[0]
  const tempdb: DbServerSample['tempdb'] =
    t && n(t.total_mb) > 0
      ? {
          total_mb: Math.round(n(t.total_mb)),
          user_mb: Math.round(n(t.user_mb)),
          internal_mb: Math.round(n(t.internal_mb)),
          version_mb: Math.round(n(t.version_mb)),
          free_mb: Math.round(n(t.free_mb)),
          used_pct: r1(100 - (n(t.free_mb) / n(t.total_mb)) * 100)
        }
      : null

  if (!cpu && !waitRows && !memory && !tempdb) {
    return empty(
      denied
        ? 'The database login cannot read server resources (VIEW SERVER STATE)'
        : 'The database server resources could not be read'
    )
  }
  const { level, reasons } = serverLevel({ cpu, waits, memory, tempdb })
  return { at, available: true, cpu, waits, memory, tempdb, level, reasons }
}

/** Kick a sample when one is due (never two at once); the result lands in the tap state. */
function maybeSample(sec: number): void {
  const st = state()
  if (st.inflight || sec - st.startedAt < SAMPLE_S) return
  st.startedAt = sec
  st.inflight = true
  void sampleDbServer()
    .then((s) => {
      st.latest = s
    })
    .catch(() => {})
    .finally(() => {
      st.inflight = false
    })
}

/** The newest sample when it is fresh enough to show. */
export function latestDbServer(nowMs = Date.now()): DbServerSample | null {
  const l = state().latest
  return l && nowMs - l.at <= FRESH_S * 1000 ? l : null
}

/**
 * For the route: the cached sample while it is under SAMPLE_S old, else one fresh read
 * (single-flight through the tap state, so many panels cost one read per SAMPLE_S).
 */
export async function dbServerNow(): Promise<DbServerSample> {
  const st = state()
  const l = st.latest
  if (l && Date.now() - l.at < SAMPLE_S * 1000) return l
  if (st.inflight) return l ?? sampleDbServer()
  st.inflight = true
  st.startedAt = Math.floor(Date.now() / 1000)
  try {
    st.latest = await sampleDbServer()
    return st.latest
  } finally {
    st.inflight = false
  }
}

registerTrafficTap({
  id: DB_SERVER_TAP,
  frame(sec) {
    if (process.env.CLOUD_META_DB_URL) return undefined
    maybeSample(sec)
    const st = state()
    // send each sample once; the page keeps it until the next one
    if (!st.latest || st.latest.at <= st.sentAt) return undefined
    st.sentAt = st.latest.at
    return st.latest
  },
  snapshot() {
    return latestDbServer() ?? undefined
  }
})
