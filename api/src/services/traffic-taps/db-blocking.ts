// api/src/services/traffic-taps/db-blocking.ts
/**
 * #1170 — blocking chains on the database node. While the map is watched, every SAMPLE_S seconds
 * the tap reads `sys.dm_exec_requests` for sessions waiting on another session's locks
 * (`blocking_session_id <> 0`, waiting ≥ MIN_WAIT_MS), then the blockers themselves (a head
 * blocker is often IDLE — a session holding an open transaction and running nothing, so its text
 * comes from the connection's most recent statement).
 *
 * Each session is named the way the in-flight cancel (#1156) does it: a session of THIS process
 * (`host_process_id` = process.pid) is matched to the unfinished request running the same
 * statement started about as long ago (traffic-inflight) — that request's entity is the node the
 * map draws the red edge from/to. A session of this process with no matching request is
 * background work (a cron job, an import, a flow); a session of another program (the legacy app,
 * a DBA's tool) is named by its program and host.
 *
 * Never in cloud mode (the DMVs are server-wide and would name another tenant's sessions). Needs
 * VIEW SERVER STATE; without it the sample says so (`available: false`).
 *
 * frame / snapshot: BlockingSample (frames carry it only when a new sample landed).
 */
import { hostname } from 'node:os'
import { db } from '../../db/index.js'
import { entityOfRequest } from '../traffic-breaker.js'
import { inflightRunning } from '../traffic-inflight.js'
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'

export const DB_BLOCKING_TAP = 'db-blocking'
/** Seconds between samples while the map is watched. */
export const SAMPLE_S = 3
/** Waits shorter than this are ordinary lock churn, not a chain worth drawing. */
export const MIN_WAIT_MS = 500
const CHAIN_CAP = 30
const SQL_TEXT = 400
/** A sample older than this is not sent or served. */
const FRESH_S = 30

export interface SessionRow {
  session_id: number
  blocking_session_id: number | null
  wait_time: number | null
  wait_type: string | null
  age_ms: number | null
  host_process_id: number | null
  host_name: string | null
  program_name: string | null
  text: string | null
  /** 1 = the session is running nothing (an open transaction left sitting). */
  idle?: number | boolean | null
  open_transaction_count?: number | null
}

export interface Party {
  session: number
  kind: 'request' | 'background' | 'outside'
  /** `<lane>/<entity>` when the session is one of this API's requests. */
  entity: string | null
  /** Route / program, for the label. */
  label: string
  caller: string | null
  sql: string | null
  idle: boolean
}
export interface BlockingChain {
  waiter: Party
  blocker: Party
  head: Party
  wait_ms: number
  wait_type: string | null
}
export interface BlockingSample {
  /** Epoch ms of the sample. */
  at: number
  available: boolean
  error?: string
  blocked: number
  chains: BlockingChain[]
}

export interface RunningRequest {
  id: string
  method: string
  path: string
  route: string
  caller: string
  running: Array<{ sql: string; age_ms: number }>
}

/**
 * A statement's shape for matching what this process sent against what SQL Server reports:
 * lower case, no brackets, no whitespace, every literal and parameter (`@p0`, `?`, `'x'`, `12`)
 * as `?`. The server may report an ad-hoc statement auto-parameterized (`WHERE [id]=@1` for
 * `where id = 1`) and a knex statement with its sp_executesql parameter list in front. Pure.
 */
export function sqlShape(sql: string | null | undefined): string {
  if (!sql) return ''
  return String(sql)
    .toLowerCase()
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/[[\]]/g, '')
    .replace(/@\w+|\?/g, '?')
    .replace(/\b\d+(?:\.\d+)?\b/g, '?')
    .replace(/\s+/g, '')
}

/** The head of a statement's shape (what an index or a session text is searched for). */
export function shapeNeedle(sql: string | null | undefined): string {
  return sqlShape(sql).slice(0, 120)
}

/**
 * Which unfinished request each session runs. A session matches a request when the shape of one
 * of the request's running statements is in the session's text (sqlShape — literals, parameters,
 * brackets and whitespace ignored) and both started within `toleranceMs` of each other; a session
 * two requests could own is left unmatched rather than guessed. Pure.
 */
export function matchSessions(
  sessions: Array<Pick<SessionRow, 'session_id' | 'text' | 'age_ms'>>,
  running: RunningRequest[],
  toleranceMs = 3000
): Map<number, RunningRequest> {
  const out = new Map<number, RunningRequest>()
  for (const s of sessions) {
    const text = sqlShape(s.text)
    if (!text) continue
    const age = Number(s.age_ms)
    const hits = running.filter((r) =>
      r.running.some((st) => {
        const needle = shapeNeedle(st.sql)
        return (
          !!needle &&
          text.includes(needle) &&
          (!Number.isFinite(age) || Math.abs(age - st.age_ms) <= toleranceMs)
        )
      })
    )
    if (hits.length === 1) out.set(s.session_id, hits[0])
  }
  return out
}

/** Statement text without sp_executesql's leading parameter list ("(@p0 int,@p1 nvarchar(40))
 *  select …"), whitespace-collapsed, capped. Pure. */
export function clipSql(t: string | null | undefined): string | null {
  if (!t) return null
  let s = String(t).replace(/\s+/g, ' ').trim()
  if (s.startsWith('(@')) {
    let depth = 0
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') depth++
      else if (s[i] === ')' && --depth === 0) {
        s = s.slice(i + 1).trim()
        break
      }
    }
  }
  return s.length > SQL_TEXT ? `${s.slice(0, SQL_TEXT)}…` : s
}

/**
 * Build chains from the sampled rows. `blocked` = sessions waiting on another, `others` = every
 * session either list names (blockers, heads). `me` decides which sessions are this process's.
 * Pure (tests feed it rows and in-flight requests).
 */
export function buildChains(
  blocked: SessionRow[],
  others: SessionRow[],
  running: RunningRequest[],
  me: { pid: number },
  classify: (method: string, path: string) => string | null = entityOfRequest
): BlockingChain[] {
  const all = new Map<number, SessionRow>()
  for (const r of others) all.set(Number(r.session_id), r)
  for (const r of blocked) all.set(Number(r.session_id), r)
  const mine = [...all.values()].filter((r) => Number(r.host_process_id) === me.pid)
  const owners = matchSessions(mine, running)
  const party = (sid: number): Party => {
    const r = all.get(sid)
    const idle = !!r && (r.idle === true || r.idle === 1)
    if (!r)
      return {
        session: sid,
        kind: 'outside',
        entity: null,
        label: `session ${sid}`,
        caller: null,
        sql: null,
        idle: false
      }
    const sql = clipSql(r.text)
    if (Number(r.host_process_id) === me.pid) {
      const req = owners.get(sid)
      if (req)
        return {
          session: sid,
          kind: 'request',
          entity: classify(req.method, req.path),
          label: `${req.method} ${req.route}`,
          caller: req.caller,
          sql,
          idle
        }
      return {
        session: sid,
        kind: 'background',
        entity: null,
        label: 'this API, no request (background work)',
        caller: null,
        sql,
        idle
      }
    }
    const program = String(r.program_name ?? '').trim() || 'another program'
    const host = String(r.host_name ?? '').trim()
    return {
      session: sid,
      kind: 'outside',
      entity: null,
      label: host ? `${program} on ${host}` : program,
      caller: null,
      sql,
      idle
    }
  }
  const headOf = (sid: number): number => {
    const seen = new Set<number>()
    let cur = sid
    for (;;) {
      seen.add(cur)
      const next = Number(all.get(cur)?.blocking_session_id ?? 0)
      if (!next || next === cur || seen.has(next)) return cur
      cur = next
    }
  }
  const chains: BlockingChain[] = []
  for (const r of blocked) {
    const sid = Number(r.session_id)
    const by = Number(r.blocking_session_id ?? 0)
    if (!by || by === sid) continue
    chains.push({
      waiter: party(sid),
      blocker: party(by),
      head: party(headOf(by)),
      wait_ms: Math.max(0, Number(r.wait_time) || 0),
      wait_type: r.wait_type ?? null
    })
  }
  return chains.sort((a, b) => b.wait_ms - a.wait_ms).slice(0, CHAIN_CAP)
}

interface State {
  latest: BlockingSample | null
  sentAt: number
  startedAt: number
  inflight: boolean
}
const state = (): State =>
  tapState<State>(DB_BLOCKING_TAP, () => ({
    latest: null,
    sentAt: 0,
    startedAt: 0,
    inflight: false
  }))

/** One sample now (the route's `fresh=1` and the frame cadence both land here). */
export async function sampleBlocking(): Promise<BlockingSample> {
  const at = Date.now()
  if (process.env.CLOUD_META_DB_URL)
    return { at, available: false, error: 'Not in cloud mode', blocked: 0, chains: [] }
  try {
    const blocked = (await db.raw(
      `SELECT r.session_id, r.blocking_session_id, r.wait_time, r.wait_type,
              DATEDIFF(millisecond, r.start_time, GETDATE()) AS age_ms,
              s.host_process_id, s.host_name, s.program_name, 0 AS idle,
              SUBSTRING(t.text, 1, 4000) AS text
         FROM sys.dm_exec_requests r
         JOIN sys.dm_exec_sessions s ON s.session_id = r.session_id
        OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
        WHERE r.blocking_session_id <> 0 AND r.session_id <> @@SPID AND r.wait_time >= ?`,
      [MIN_WAIT_MS]
    )) as SessionRow[]
    let others: SessionRow[] = []
    if (blocked.length) {
      // the blockers, and whoever blocks them (a chain is rarely more than three deep)
      let want = [
        ...new Set(blocked.map((b) => Number(b.blocking_session_id)).filter((n) => n > 0))
      ]
      const known = new Set(blocked.map((b) => Number(b.session_id)))
      for (let depth = 0; depth < 3 && want.length; depth++) {
        const ids = want.filter((n) => Number.isInteger(n) && !known.has(n)).slice(0, 100)
        if (!ids.length) break
        const rows = (await db.raw(
          `SELECT s.session_id, r.blocking_session_id, r.wait_time, r.wait_type,
                  DATEDIFF(millisecond, COALESCE(r.start_time, s.last_request_start_time), GETDATE()) AS age_ms,
                  s.host_process_id, s.host_name, s.program_name, s.open_transaction_count,
                  CASE WHEN r.session_id IS NULL THEN 1 ELSE 0 END AS idle,
                  SUBSTRING(COALESCE(rt.text, ct.text), 1, 4000) AS text
             FROM sys.dm_exec_sessions s
             LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
             LEFT JOIN sys.dm_exec_connections c ON c.session_id = s.session_id
            OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) rt
            OUTER APPLY sys.dm_exec_sql_text(c.most_recent_sql_handle) ct
            WHERE s.session_id IN (${ids.map(() => '?').join(',')})`,
          ids
        )) as SessionRow[]
        for (const r of rows) {
          others.push(r)
          known.add(Number(r.session_id))
        }
        want = rows.map((r) => Number(r.blocking_session_id ?? 0)).filter((n) => n > 0)
      }
      others = others.slice(0, 300)
    }
    const chains = blocked.length
      ? buildChains(blocked, others, inflightRunning(), { pid: process.pid })
      : []
    return { at, available: true, blocked: blocked.length, chains }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      at,
      available: false,
      error: /permission|VIEW SERVER STATE/i.test(msg)
        ? 'The database login cannot read sessions (VIEW SERVER STATE)'
        : 'The database sessions could not be read',
      blocked: 0,
      chains: []
    }
  }
}

/** Kick a sample when one is due (never two at once); the result lands in the tap state. */
function maybeSample(sec: number): void {
  const st = state()
  if (st.inflight || sec - st.startedAt < SAMPLE_S) return
  st.startedAt = sec
  st.inflight = true
  void sampleBlocking()
    .then((s) => {
      st.latest = s
    })
    .catch(() => {})
    .finally(() => {
      st.inflight = false
    })
}

/** The newest sample when it is fresh enough to show. */
export function latestBlocking(nowMs = Date.now()): BlockingSample | null {
  const l = state().latest
  return l && nowMs - l.at <= FRESH_S * 1000 ? l : null
}

const tap: TrafficTap = {
  id: DB_BLOCKING_TAP,
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
    return latestBlocking() ?? undefined
  },
  entityDetail(entityKey) {
    const l = latestBlocking()
    if (!l) return undefined
    const chains = l.chains.filter(
      (c) =>
        c.waiter.entity === entityKey ||
        c.blocker.entity === entityKey ||
        c.head.entity === entityKey
    )
    return chains.length ? { at: l.at, chains } : undefined
  }
}
registerTrafficTap(tap)

/** This process as SQL Server sees it — for the inspector's "sessions of this API" note. */
export function blockingIdentity(): { pid: number; host: string } {
  return { pid: process.pid, host: hostname() }
}
