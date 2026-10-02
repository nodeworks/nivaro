import type { Knex } from 'knex'
import { runLongSql } from '../../services/run-long.js'
import { isMssql } from '../dialect.js'

/**
 * The request id on every API log row (Traffic Map drill-down, Wave 0).
 *
 * `nivaro_api_logs.request_id` carries the id plugins/request-trace.ts mints per /api request —
 * the same id on the Traffic Map events (`rid`), the slow-request trace ring and the
 * `x-nivaro-request-id` response header — so a ticker event opens the exact log row behind it.
 *
 * Adding a nullable column is metadata-only on SQL Server. The index is FILTERED (request_id IS
 * NOT NULL): every existing row is NULL, so the build is a scan with nothing to sort — still
 * minutes on a large log, so it runs on its own long request outside knex's batch transaction
 * (migrations 334 / 351). Postgres gets the same partial index; any other dialect a plain one.
 * The logger probes the column (lib/column-probe), so a database behind 389 keeps logging.
 */
export const config = { transaction: false }

const TABLE = 'nivaro_api_logs'
const IX = 'ix_api_logs_request_id'
const PG_CLIENTS = new Set(['pg', 'postgres', 'postgresql'])

function dialectOf(knex: Knex): string {
  return String((knex as any).client?.config?.client ?? '')
}

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  if (!(await knex.schema.hasColumn(TABLE, 'request_id'))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.string('request_id', 36).nullable()
    })
  }
  if (isMssql(knex)) {
    await runLongSql(
      `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = '${IX}')
         CREATE INDEX ${IX} ON ${TABLE} (request_id) WHERE request_id IS NOT NULL`,
      { knex, timeoutMs: 60 * 60 * 1000 }
    )
    return
  }
  if (PG_CLIENTS.has(dialectOf(knex))) {
    await knex.raw(
      `CREATE INDEX IF NOT EXISTS ${IX} ON ${TABLE} (request_id) WHERE request_id IS NOT NULL`
    )
    return
  }
  try {
    await knex.schema.alterTable(TABLE, (t) => {
      t.index(['request_id'], IX)
    })
  } catch (err) {
    // Already there from an earlier run — the only failure worth tolerating.
    if (!/exist|duplicate/i.test(String((err as Error)?.message ?? err))) throw err
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  if (isMssql(knex)) {
    await knex.raw(
      `IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = '${IX}') DROP INDEX ${IX} ON ${TABLE}`
    )
  } else {
    await knex.schema
      .alterTable(TABLE, (t) => {
        t.dropIndex(['request_id'], IX)
      })
      .catch(() => {})
  }
  if (await knex.schema.hasColumn(TABLE, 'request_id')) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.dropColumn('request_id')
    })
  }
}
