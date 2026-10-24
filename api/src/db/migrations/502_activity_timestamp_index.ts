import type { Knex } from 'knex'
import { runLongSql } from '../../services/run-long.js'
import { isMssql } from '../dialect.js'

/**
 * nivaro_activity (timestamp DESC, id DESC).
 *
 * The activity log's newest-first pages (the admin dashboard's Recent activity, the Activity
 * page, GET /api/activity) sort by timestamp, and no index led with it: picking ten rows read
 * all 11–12M (8–10 s on staging, 2026-10-24; ~3 s after the route's two-step page). The id
 * tie-break is the route's own order, so the page is an ordered index scan of `limit` rows.
 *
 * Built on its own long request (migration 334's pattern). SQL Server Standard has no ONLINE
 * index build: writes to nivaro_activity wait for the build (about a minute at this size).
 */
/**
 * Outside knex's batch transaction: runLongSql uses its OWN pooled connection, and handing a
 * borrowed batch connection back left the batch's COMMIT with no BEGIN (migration 334's note).
 */
export const config = { transaction: false }

export async function up(knex: Knex): Promise<void> {
  // A performance index only: other dialects skip it (#757).
  if (!isMssql(knex)) return
  await runLongSql(
    `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_nivaro_activity_timestamp')
       CREATE INDEX ix_nivaro_activity_timestamp
         ON nivaro_activity ([timestamp] DESC, [id] DESC)
         WITH (SORT_IN_TEMPDB = ON)`,
    { timeoutMs: 60 * 60 * 1000 }
  )
}

export async function down(knex: Knex): Promise<void> {
  if (!isMssql(knex)) return
  await knex.raw(`
    IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_nivaro_activity_timestamp')
    DROP INDEX ix_nivaro_activity_timestamp ON nivaro_activity
  `)
}
