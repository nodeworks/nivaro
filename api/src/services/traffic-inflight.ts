// api/src/services/traffic-inflight.ts
/**
 * Traffic Map: requests that have not finished yet (#1147), the SQL they are running, and
 * killing that SQL's session (#1156).
 *
 * plugins/request-trace.ts calls `inflightStart` right after it opens the request's trace and
 * `inflightEnd` when the response is sent (or the client went away). Statements are attributed
 * through the trace id the query runs under (knex `query` / `query-response` events), so a
 * request's running statement, its count, its SQL time and the rows it read are known while it
 * runs — and stamped onto the request at the end for the Traffic Map taps (#1122 cost per caller).
 *
 * Memory only, bounded (INFLIGHT_CAP entries; an entry older than STALE_MS is dropped on read).
 * Nothing here may throw into a request.
 */
import { hostname } from 'node:os'
import { currentTraceMeta } from './request-trace.js'
import { callerKeyFor, pathTemplate } from './traffic-entities.js'

export const INFLIGHT_CAP = 2000
const STALE_MS = 60 * 60_000
const SQL_TEXT_CAP = 600

interface RunningStatement {
  sql: string
  /** Epoch ms the statement was sent. */
  at: number
  perf: number
}
interface Entry {
  id: string
  req: unknown
  method: string
  route: string
  /** The request path (query string dropped) — the blocking-chain lens (#1170) classifies it. */
  path: string
  /** Epoch ms. */
  startedAt: number
  running: Map<string, RunningStatement>
  n: number
  ms: number
  rows: number
}

/** What a finished request carries for the taps (`req.__nvrSql`). */
export interface RequestSqlStats {
  queries: number
  sql_ms: number
  rows: number
}

const byTrace = new Map<string, Entry>()
const byReq = new WeakMap<object, string>()
const SQL_STAMP = '__nvrSql'

function inCloud(): boolean {
  return !!process.env.CLOUD_META_DB_URL
}

function routeOf(req: Record<string, unknown>, path: string): string {
  const ro = req.routeOptions as { url?: string } | undefined
  return typeof ro?.url === 'string' && ro.url ? ro.url.slice(0, 200) : pathTemplate(path)
}

/** Called inside the request's trace context (right after beginTrace). */
export function inflightStart(req: unknown): void {
  if (inCloud() || !req || typeof req !== 'object') return
  try {
    const id = currentTraceMeta()?.id
    if (!id || byTrace.size >= INFLIGHT_CAP) return
    const r = req as Record<string, unknown> & { raw?: { url?: string }; url?: string }
    const path = String(r.raw?.url ?? r.url ?? '').split('?')[0]
    byTrace.set(id, {
      id,
      req,
      method: String(r.method ?? 'GET'),
      route: routeOf(r, path),
      path: path.slice(0, 500),
      startedAt: Date.now(),
      running: new Map(),
      n: 0,
      ms: 0,
      rows: 0
    })
    byReq.set(req, id)
  } catch {
    /* never */
  }
}

/** The response went out (or the client left): stamp the SQL figures, drop the entry. */
export function inflightEnd(req: unknown): void {
  if (!req || typeof req !== 'object') return
  try {
    const id = byReq.get(req)
    if (!id) return
    byReq.delete(req)
    const e = byTrace.get(id)
    if (!e) return
    byTrace.delete(id)
    const stats: RequestSqlStats = { queries: e.n, sql_ms: Math.round(e.ms), rows: e.rows }
    ;(req as Record<string, unknown>)[SQL_STAMP] = stats
  } catch {
    /* never */
  }
}

/** The SQL figures of a finished request (stamped by inflightEnd); null when none. */
export function requestSqlStats(req: unknown): RequestSqlStats | null {
  if (!req || typeof req !== 'object') return null
  const v = (req as Record<string, unknown>)[SQL_STAMP] as RequestSqlStats | undefined
  return v && typeof v.queries === 'number' ? v : null
}

interface KnexQueryEvent {
  __knexQueryUid?: string
  sql?: string
}

/** Attach to a knex client once (plugins/request-trace.ts does, for both pools). */
export function attachInflightQueries(client: {
  on: (ev: string, fn: (...a: unknown[]) => void) => unknown
}): void {
  client.on('query', (q: unknown) => {
    if (byTrace.size === 0) return
    const id = currentTraceMeta()?.id
    const e = id ? byTrace.get(id) : undefined
    if (!e) return
    const ev = q as KnexQueryEvent
    if (!ev.__knexQueryUid || typeof ev.sql !== 'string') return
    e.running.set(ev.__knexQueryUid, { sql: ev.sql, at: Date.now(), perf: performance.now() })
  })
  const settle = (res: unknown, q: unknown) => {
    if (byTrace.size === 0) return
    const id = currentTraceMeta()?.id
    const e = id ? byTrace.get(id) : undefined
    if (!e) return
    const uid = (q as KnexQueryEvent).__knexQueryUid
    const started = uid ? e.running.get(uid) : undefined
    if (uid) e.running.delete(uid)
    e.n++
    if (started) e.ms += performance.now() - started.perf
    if (Array.isArray(res)) e.rows += res.length
  }
  client.on('query-response', (res: unknown, q: unknown) => settle(res, q))
  client.on('query-error', (_err: unknown, q: unknown) => settle(null, q))
}

/**
 * A statement sent outside knex (raw tedious batches: custom queries, widget renders, the SQL
 * scratchpad) — call at send, call the returned function when it answered. A no-op outside an
 * in-flight request.
 */
export function trackStatement(sql: string): (rows?: number) => void {
  if (byTrace.size === 0) return () => {}
  try {
    const id = currentTraceMeta()?.id
    const e = id ? byTrace.get(id) : undefined
    if (!e) return () => {}
    const uid = `raw:${Math.random().toString(36).slice(2)}`
    const st = { sql, at: Date.now(), perf: performance.now() }
    e.running.set(uid, st)
    return (rows?: number) => {
      if (!e.running.delete(uid)) return
      e.n++
      e.ms += performance.now() - st.perf
      if (rows) e.rows += rows
    }
  } catch {
    return () => {}
  }
}

export interface InflightRow {
  id: string
  method: string
  route: string
  caller: string
  /** Epoch ms. */
  started_at: number
  age_ms: number
  queries: number
  sql_ms: number
  rows: number
  /** Statements sent and not answered yet, oldest first. */
  running: Array<{ sql: string; age_ms: number }>
}

function callerOf(req: unknown): string {
  const r = req as { authMethod?: string; apiKeyId?: number | null; user?: { id?: string } }
  return callerKeyFor({
    authMethod: r?.authMethod ?? null,
    apiKeyId: r?.apiKeyId ?? null,
    userId: r?.user?.id ?? null
  })
}

/** Unfinished requests, oldest first; `exclude` = the asking request's own trace id. */
export function listInflight(opts: { exclude?: string | null; limit?: number } = {}): {
  rows: InflightRow[]
  total: number
} {
  const now = Date.now()
  const nowPerf = performance.now()
  const rows: InflightRow[] = []
  for (const [id, e] of byTrace) {
    if (now - e.startedAt > STALE_MS) {
      byTrace.delete(id)
      continue
    }
    if (id === opts.exclude) continue
    const running = [...e.running.values()]
      .sort((a, b) => a.at - b.at)
      .map((s) => ({
        sql: s.sql.length > SQL_TEXT_CAP ? `${s.sql.slice(0, SQL_TEXT_CAP)}…` : s.sql,
        age_ms: Math.max(0, Math.round(nowPerf - s.perf))
      }))
    rows.push({
      id,
      method: e.method,
      route: e.route,
      caller: callerOf(e.req),
      started_at: e.startedAt,
      age_ms: now - e.startedAt,
      queries: e.n,
      sql_ms: Math.round(e.ms + running.reduce((a, s) => a + s.age_ms, 0)),
      rows: e.rows,
      running
    })
  }
  rows.sort((a, b) => b.age_ms - a.age_ms)
  return { rows: rows.slice(0, opts.limit ?? 100), total: rows.length }
}

/** The oldest statement a request is still running (with its full text), or null. */
export function oldestRunning(id: string): { sql: string; age_ms: number; route: string } | null {
  const e = byTrace.get(id)
  if (!e || e.running.size === 0) return null
  const s = [...e.running.values()].sort((a, b) => a.at - b.at)[0]
  return { sql: s.sql, age_ms: Math.round(performance.now() - s.perf), route: e.route }
}

/**
 * #1170 — every unfinished request that is running at least one statement right now: its method,
 * path, caller and the statements (full text) with their age. The blocking-chain lens matches
 * SQL Server sessions to requests with `pickSession` over these.
 */
export function inflightRunning(): Array<{
  id: string
  method: string
  path: string
  route: string
  caller: string
  running: Array<{ sql: string; age_ms: number }>
}> {
  const nowPerf = performance.now()
  const out: ReturnType<typeof inflightRunning> = []
  for (const [id, e] of byTrace) {
    if (e.running.size === 0) continue
    out.push({
      id,
      method: e.method,
      path: e.path,
      route: e.route,
      caller: callerOf(e.req),
      running: [...e.running.values()].map((s) => ({
        sql: s.sql,
        age_ms: Math.max(0, Math.round(nowPerf - s.perf))
      }))
    })
  }
  return out
}

export function inflightCount(): number {
  return byTrace.size
}

/** Test hook. */
export function resetInflight(): void {
  byTrace.clear()
}

// ── #1156: which SQL Server session runs that statement ───────────────────────

export interface SessionCandidate {
  session_id: number
  /** Milliseconds since the server started the request. */
  age_ms: number
  text: string
}

/** Whitespace-insensitive text to look for: the head of the statement. */
export function statementNeedle(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().slice(0, 160)
}

/**
 * Pick the one session running `sql`, started about `ageMs` ago. Sessions are this process's own
 * (the query filters on host_process_id), so another API on the same database never matches.
 * More than one plausible session → 'ambiguous' (never guess which to kill).
 */
export function pickSession(
  candidates: SessionCandidate[],
  sql: string,
  ageMs: number,
  toleranceMs = 3000
):
  | { status: 'found'; session_id: number }
  | { status: 'none' }
  | { status: 'ambiguous'; sessions: number[] } {
  const needle = statementNeedle(sql)
  if (!needle) return { status: 'none' }
  const hits = candidates.filter(
    (c) =>
      c.session_id > 50 &&
      c.text.replace(/\s+/g, ' ').includes(needle) &&
      Math.abs(c.age_ms - ageMs) <= toleranceMs
  )
  if (hits.length === 0) return { status: 'none' }
  if (hits.length === 1) return { status: 'found', session_id: hits[0].session_id }
  return { status: 'ambiguous', sessions: hits.map((h) => h.session_id) }
}

/** This process, as SQL Server sees it (tedious sends process.pid as the client PID). */
export function processIdentity(): { pid: number; host: string } {
  return { pid: process.pid, host: hostname() }
}
