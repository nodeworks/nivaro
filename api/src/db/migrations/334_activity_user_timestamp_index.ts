import type { Knex } from 'knex'
import { runLongSql } from '../../services/run-long.js'

/**
 * nivaro_activity (user, timestamp DESC).
 *
 * Every "is this person still active" question — the nightly redaction
 * sweep's liveness test, per-person activity views, last-touch attribution
 * — filters the activity log by USER, and the table (11M rows) carried no
 * index on that column: each check scanned by timestamp instead. The
 * redaction preview (#498) took over ten minutes on the shared database
 * for that reason alone.
 *
 * Built on its own long request (migration 321's pattern) — minutes on a
 * table this size, instant on a fresh database. The legacy twin,
 * directus_activity (16M rows, a replication article), needs the same
 * index from the DBA; this migration cannot touch it.
 */
/**
 * Outside knex's batch transaction: runLongSql builds the index on its OWN
 * pooled connection (an hour-long request the 15s knex.raw timeout cannot
 * carry). Borrowing the batch transaction's connection for that and handing
 * it back left the batch's COMMIT with no BEGIN (error 3902 on the first
 * multi-migration run, 2026-09-22) — so this migration opts out of it, and
 * never passes the transaction knex into runLongSql.
 */
export const config = { transaction: false }

export async function up(_knex: Knex): Promise<void> {
  await runLongSql(
    `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_nivaro_activity_user_timestamp')
       CREATE INDEX ix_nivaro_activity_user_timestamp
         ON nivaro_activity ([user], [timestamp] DESC)`,
    { timeoutMs: 60 * 60 * 1000 }
  )
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_nivaro_activity_user_timestamp')
    DROP INDEX ix_nivaro_activity_user_timestamp ON nivaro_activity
  `)
}
