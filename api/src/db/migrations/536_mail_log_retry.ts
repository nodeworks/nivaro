import type { Knex } from 'knex'
import { runLongSql } from '../../services/run-long.js'
import { isMssql } from '../dialect.js'

/**
 * Automatic mail retry (Rob 2026-11-18: "failed sends should retry when the
 * mail server has a temporary error").
 *
 *   nivaro_mail_log.retry_at     datetime2, nullable — when the next automatic
 *                                retry of this ORIGINAL send is due; NULL = none
 *                                pending (never failed, retried, given up, or
 *                                someone pressed Resend)
 *   nivaro_mail_log.retry_count  int, nullable — automatic retries made so far
 *
 * The retry runner (services/mail-retry.ts) finds due rows through a filtered
 * index on retry_at (SQL Server; a plain index elsewhere) — almost every row is
 * NULL there, so the index holds only the pending few.
 *
 * Every reader and the logger probe the columns (services/mail-retry-state.ts),
 * so a database behind 536 keeps logging and resending — it just never retries
 * on its own. ADD COLUMN nullable only (production is a replication publisher);
 * the index is built on its own long request outside knex's batch transaction
 * (migration 535's pattern). Guarded both ways.
 */
export const config = { transaction: false }

const TABLE = 'nivaro_mail_log'
const INDEX = 'ix_nivaro_mail_log_retry_at'

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  if (!(await knex.schema.hasColumn(TABLE, 'retry_at'))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.datetime('retry_at', { precision: 3 }).nullable()
    })
  }
  if (!(await knex.schema.hasColumn(TABLE, 'retry_count'))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.integer('retry_count').nullable()
    })
  }
  if (isMssql(knex)) {
    await runLongSql(
      `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = '${INDEX}' AND object_id = OBJECT_ID('${TABLE}'))
         CREATE INDEX ${INDEX} ON ${TABLE} ([retry_at]) INCLUDE ([retry_count], [created_at]) WHERE [retry_at] IS NOT NULL`,
      { knex, timeoutMs: 60 * 60 * 1000 }
    )
    return
  }
  try {
    await knex.schema.alterTable(TABLE, (t) => {
      t.index(['retry_at'], INDEX)
    })
  } catch {
    // Already there (a re-run) — the index is a speed-up only.
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  if (isMssql(knex)) {
    await knex.raw(`
      IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = '${INDEX}' AND object_id = OBJECT_ID('${TABLE}'))
      DROP INDEX ${INDEX} ON ${TABLE}
    `)
  } else {
    await knex.schema
      .alterTable(TABLE, (t) => {
        t.dropIndex(['retry_at'], INDEX)
      })
      .catch(() => undefined)
  }
  if (await knex.schema.hasColumn(TABLE, 'retry_at')) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.dropColumn('retry_at')
    })
  }
  if (await knex.schema.hasColumn(TABLE, 'retry_count')) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.dropColumn('retry_count')
    })
  }
}
