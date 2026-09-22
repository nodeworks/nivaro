import type { Knex } from 'knex'
import { runLongSql } from '../../services/run-long.js'

/**
 * nivaro_workflow_history (instance, to_state) INCLUDE ([timestamp]).
 *
 * "When did this record enter the state it is in" is asked of the history
 * table by instance and target state — the v_<collection>_state views'
 * entered_at, and every reader moving off the legacy mirrored state columns.
 * The table (442k rows on the shared database) carried no index on either
 * column, so each answer scanned it: a correlated lookup per row cost 82% of
 * a single-record read of the view, and 1,945ms over the whole view against
 * 499ms once the aggregate was hoisted out of the correlation.
 *
 * The INCLUDE carries [timestamp] so MAX() is answered from the index leaf
 * without touching the base table.
 *
 * Built on its own long request (migration 321's pattern) — the table is far
 * smaller than nivaro_activity, so this is seconds rather than minutes, and
 * instant on a fresh database.
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
    `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_nivaro_workflow_history_instance_to_state')
       CREATE INDEX ix_nivaro_workflow_history_instance_to_state
         ON nivaro_workflow_history (instance, to_state) INCLUDE ([timestamp])`,
    { timeoutMs: 60 * 60 * 1000 }
  )
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_nivaro_workflow_history_instance_to_state')
    DROP INDEX ix_nivaro_workflow_history_instance_to_state ON nivaro_workflow_history
  `)
}
