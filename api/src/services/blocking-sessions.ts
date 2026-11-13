/**
 * Blocking-session monitor (#88): database sessions blocked for more than 15 seconds form
 * chains that read as "everything is slow" with no visible cause. The cron in server.ts files
 * what this module reports as ONE deduped issue naming the head blocker and its statement.
 *
 * Only chains that touch THIS database are reported. The DMVs describe the whole server, and a
 * server often hosts other applications: in the first production week another application's
 * replication snapshot held 23 of its own sessions for 335 seconds, this app was untouched
 * (no 5xx, normal latency), and the monitor raised a critical issue here four times in two
 * days. A chain counts when a blocked session or its head is in this database.
 *
 * A head blocker is a session that blocks others and is not blocked itself; the sessions in
 * between are part of the chain, not heads. An idle head (a transaction left open) has no
 * running request, so its text is the last statement its connection ran.
 *
 * What the issue log keeps about a session:
 * - in ANOTHER database: its database name, nothing else. Its statement can carry that
 *   application's data, its login and host are not this app's to store, and its program name
 *   is free text the other application sets (replication and agent jobs put server and
 *   publication names in it).
 * - in this database under another login (a person in a query tool): its program and
 *   statement, never the person's login or machine name.
 * - the app's own sessions: program, host and login too (which process it was).
 * The queries below return NULL for what is not kept, so it never leaves the server.
 */
import type { Knex } from 'knex'

/** One request that is waiting on another session (sys.dm_exec_requests). */
export interface BlockedRequest {
  session_id: number
  blocking_session_id: number
  wait_time: number
  wait_type: string | null
  /** Is the request running in the database this API is connected to? */
  mine: boolean | number
  database_name?: string | null
  sql_text: string | null
}

/** What is known about a session in a chain (sys.dm_exec_sessions). */
export interface ChainSession {
  session_id: number
  mine: boolean | number
  /** Does the session run under the login this API connects with? */
  own_login?: boolean | number | null
  database_name?: string | null
  program_name?: string | null
  host_name?: string | null
  login_name?: string | null
  open_transaction_count?: number | null
  /** Its running statement, else the last one its connection ran. */
  sql_text: string | null
}

export interface BlockingReport {
  message: string
  stack: string
  severity: 'high' | 'critical'
}

/** A chain is reported once one of its sessions has waited this long. */
const REPORT_AFTER_MS = 15_000
const CRITICAL_AFTER_MS = 120_000

const yes = (v: boolean | number | null | undefined) => v === true || v === 1

function describeSession(id: number, s: ChainSession | undefined): string {
  if (!s) return `#${id}`
  const own = yes(s.mine)
  const parts = !own
    ? [s.database_name]
    : yes(s.own_login)
      ? [s.database_name, s.program_name, s.host_name, s.login_name]
      : [s.database_name, s.program_name]
  const who = parts
    .map((x) => (x ?? '').trim())
    .filter(Boolean)
    .join(' · ')
  const open = Number(s.open_transaction_count) || 0
  const tran = open > 0 ? `, ${open} open transaction(s)` : ''
  const head = `#${id}${who ? ` [${who}]` : ''}${tran}`
  // Another database's statement is not shown, even if a caller passed one in.
  return own ? `${head}: ${s.sql_text?.trim() || '(no statement)'}` : head
}

/** The issue to raise for what is blocked right now, or null when nothing here is. */
export function summarizeBlocking(
  requests: BlockedRequest[],
  sessions: ChainSession[]
): BlockingReport | null {
  const blocked = new Map<number, BlockedRequest>()
  for (const r of requests) if (r.blocking_session_id > 0) blocked.set(r.session_id, r)
  if (blocked.size === 0) return null
  const info = new Map(sessions.map((s) => [s.session_id, s]))

  // The head of a blocked session's chain: follow the blockers up to one that is not waiting
  // on anyone (a cycle, i.e. a deadlock about to be resolved, stops where it started).
  const headOf = (id: number): number => {
    const seen = new Set<number>()
    let cur = id
    while (blocked.has(cur) && !seen.has(cur)) {
      seen.add(cur)
      cur = (blocked.get(cur) as BlockedRequest).blocking_session_id
    }
    return cur
  }
  const chains = new Map<number, BlockedRequest[]>()
  for (const r of blocked.values()) {
    const head = headOf(r.session_id)
    const members = chains.get(head) ?? []
    members.push(r)
    chains.set(head, members)
  }

  const reported: Array<{ head: number; members: BlockedRequest[] }> = []
  for (const [head, members] of chains) {
    const here = members.some((m) => yes(m.mine)) || yes(info.get(head)?.mine)
    if (!here) continue
    if (!members.some((m) => m.wait_time > REPORT_AFTER_MS)) continue
    reported.push({ head, members })
  }
  if (reported.length === 0) return null

  const waiting = reported.flatMap((c) => c.members).sort((a, b) => b.wait_time - a.wait_time)
  const worst = waiting[0].wait_time
  const heads = reported.map((c) => describeSession(c.head, info.get(c.head)))
  return {
    message: `${waiting.length} session(s) blocked (worst ${Math.round(worst / 1000)}s) behind ${reported.length} head blocker(s)`,
    stack: `Head blocker statement(s): ${heads.join(' · ')}\nBlocked: ${waiting
      .slice(0, 10)
      .map(
        (r) =>
          `#${r.session_id}${r.database_name ? ` [${r.database_name}]` : ''} waits ${Math.round(r.wait_time / 1000)}s (${r.wait_type ?? '?'}) on #${r.blocking_session_id}`
      )
      .join('\n')}`,
    severity: worst > CRITICAL_AFTER_MS ? 'critical' : 'high'
  }
}

/**
 * Read the server's blocked requests and the sessions in their chains, and summarize them.
 * Null when nothing is blocked here, or when the login may not read the DMVs (VIEW SERVER
 * STATE), or the database is not SQL Server.
 */
export async function blockingReport(db: Knex): Promise<BlockingReport | null> {
  let requests: BlockedRequest[] = []
  try {
    requests = (await db.raw(`
      SELECT r.session_id, r.blocking_session_id, r.wait_time, r.wait_type,
             CASE WHEN r.database_id = DB_ID() THEN 1 ELSE 0 END AS mine,
             DB_NAME(r.database_id) AS database_name,
             CASE WHEN r.database_id = DB_ID() THEN LEFT(t.text, 300) END AS sql_text
      FROM sys.dm_exec_requests r
      OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
      WHERE r.blocking_session_id > 0
    `)) as BlockedRequest[]
  } catch {
    return null
  }
  if (!requests.some((r) => r.wait_time > REPORT_AFTER_MS)) return null
  const ids = [...new Set(requests.flatMap((r) => [r.session_id, r.blocking_session_id]))]
  let sessions: ChainSession[] = []
  try {
    sessions = (await db.raw(
      `SELECT s.session_id,
              CASE WHEN s.database_id = DB_ID() THEN 1 ELSE 0 END AS mine,
              CASE WHEN s.login_name = SUSER_SNAME() THEN 1 ELSE 0 END AS own_login,
              DB_NAME(s.database_id) AS database_name,
              s.open_transaction_count,
              CASE WHEN s.database_id = DB_ID() THEN s.program_name END AS program_name,
              CASE WHEN s.database_id = DB_ID() AND s.login_name = SUSER_SNAME()
                   THEN s.host_name END AS host_name,
              CASE WHEN s.database_id = DB_ID() AND s.login_name = SUSER_SNAME()
                   THEN s.login_name END AS login_name,
              CASE WHEN s.database_id = DB_ID()
                   THEN LEFT(COALESCE(rt.text, ct.text), 300) END AS sql_text
       FROM sys.dm_exec_sessions s
       LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
       OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) rt
       OUTER APPLY (SELECT TOP 1 c.most_recent_sql_handle AS h
                    FROM sys.dm_exec_connections c WHERE c.session_id = s.session_id) mc
       OUTER APPLY sys.dm_exec_sql_text(mc.h) ct
       WHERE s.session_id IN (${ids.map(() => '?').join(',')})`,
      ids
    )) as ChainSession[]
  } catch {
    // The requests alone still say which chains touch this database.
  }
  return summarizeBlocking(requests, sessions)
}
