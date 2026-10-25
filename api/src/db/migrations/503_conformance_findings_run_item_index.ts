import type { Knex } from 'knex'
import { runLongSql } from '../../services/run-long.js'
import { isMssql } from '../dialect.js'

/**
 * nivaro_conformance_findings (run, item_id).
 *
 * Every record open runs the live integrity check, which reconciles that record's rows of the
 * latest conformance run. The table was indexed by run only (migration 227), so each
 * `WHERE run = ? AND item_id = ?` read or delete scanned and locked the whole run's rows, and
 * people opening different records deadlocked each other (staging load test 2026-10-24). The
 * check now skips unchanged results; this index makes the rest touch only the record's rows.
 *
 * Built on its own long request (migration 334's pattern), outside knex's batch transaction.
 */
export const config = { transaction: false }

export async function up(knex: Knex): Promise<void> {
  // A performance index only: other dialects skip it (#757).
  if (!isMssql(knex)) return
  await runLongSql(
    `IF OBJECT_ID('nivaro_conformance_findings', 'U') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_nivaro_conformance_findings_run_item')
       CREATE INDEX ix_nivaro_conformance_findings_run_item
         ON nivaro_conformance_findings ([run], item_id)`,
    { timeoutMs: 60 * 60 * 1000 }
  )
}

export async function down(knex: Knex): Promise<void> {
  if (!isMssql(knex)) return
  await knex.raw(`
    IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_nivaro_conformance_findings_run_item')
    DROP INDEX ix_nivaro_conformance_findings_run_item ON nivaro_conformance_findings
  `)
}
