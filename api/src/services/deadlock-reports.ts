// api/src/services/deadlock-reports.ts
/**
 * The one reader of SQL Server's `xml_deadlock_report` events (DB Health panel, the hourly
 * deadlock sweep, the Traffic Map deadlock tap).
 *
 * system_health's event FILE first: its ring buffer, read through the DMV, is cut at a few MB
 * and on a busy shared server holds no deadlock at all while the file has them (2026-10-01 and
 * again 2026-11-04, when the SqlServerDeadlocks alert — which reads the file — fired and the DB
 * Health panel was empty). The ring is the fallback for servers without `timestamp_utc` on the
 * file reader (before SQL Server 2017) or without access to the file.
 *
 * `thisDatabase` keeps only deadlocks with a session in the database this API is connected to:
 * the server may be shared (replication cleanup in `distribution`, SQL Sentry in `msdb`, other
 * applications, another environment's database), and another database's statements are not
 * this instance's to show.
 */
import { db } from '../db/index.js'

export interface DeadlockReport {
  occurred_at: Date | string
  /** The whole `<event name="xml_deadlock_report">` element as text. */
  graph: string
}

export interface DeadlockReportQuery {
  /** Newest first, at most this many (1–100). */
  limit: number
  /** Only reports at or after this moment. */
  since?: Date
  /** Only deadlocks with a session in this API's own database. */
  thisDatabase?: boolean
}

const PROCESS_IN_DB = 'deadlock/process-list/process[@currentdbname = sql:variable("@db")]'

export function deadlockReportSql(q: DeadlockReportQuery): { file: string; ring: string } {
  const top = Math.max(1, Math.min(100, Math.floor(q.limit) || 1))
  const declare = q.thisDatabase ? 'DECLARE @db sysname = DB_NAME();' : ''
  // DATEADD(second, 0, …) keeps the time filter off the file reader: pushed down into
  // fn_xe_file_target_read_file, `timestamp_utc > x` matches nothing on SQL Server 2019.
  const fileWhere = [
    `object_name = 'xml_deadlock_report'`,
    q.since ? 'DATEADD(second, 0, timestamp_utc) >= ?' : null,
    q.thisDatabase
      ? `CAST(event_data AS xml).exist('/event/data/value/${PROCESS_IN_DB}') = 1`
      : null
  ].filter(Boolean)
  const ringWhere = [
    q.since ? `xed.value('@timestamp', 'datetime2') >= ?` : null,
    q.thisDatabase ? `xed.exist('data/value/${PROCESS_IN_DB}') = 1` : null
  ].filter(Boolean)
  return {
    file: `${declare}
      SELECT TOP ${top} timestamp_utc AS occurred_at, CAST(event_data AS nvarchar(max)) AS graph
      FROM sys.fn_xe_file_target_read_file('system_health*.xel', NULL, NULL, NULL)
      WHERE ${fileWhere.join(' AND ')}
      ORDER BY timestamp_utc DESC`,
    ring: `${declare}
      SELECT TOP ${top}
        xed.value('@timestamp', 'datetime2') AS occurred_at,
        CAST(xed.query('.') AS nvarchar(max)) AS graph
      FROM (
        SELECT CAST(target_data AS XML) AS target_data
        FROM sys.dm_xe_session_targets st
        JOIN sys.dm_xe_sessions s ON s.address = st.event_session_address
        WHERE s.name = 'system_health' AND st.target_name = 'ring_buffer'
      ) AS tab
      CROSS APPLY target_data.nodes('RingBufferTarget/event[@name="xml_deadlock_report"]') AS q(xed)
      ${ringWhere.length ? `WHERE ${ringWhere.join(' AND ')}` : ''}
      ORDER BY occurred_at DESC`
  }
}

/** Newest deadlock reports: the event file, else the ring buffer. Throws when neither reads
 *  (no VIEW SERVER STATE — the ring's error is the one thrown). */
export async function readDeadlockReports(q: DeadlockReportQuery): Promise<DeadlockReport[]> {
  const sql = deadlockReportSql(q)
  const bindings = q.since ? [q.since] : []
  try {
    return (await db.raw(sql.file, bindings)) as DeadlockReport[]
  } catch {
    return (await db.raw(sql.ring, bindings)) as DeadlockReport[]
  }
}
