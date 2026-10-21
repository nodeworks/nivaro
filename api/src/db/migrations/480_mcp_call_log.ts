import type { Knex } from 'knex'
import { runLongSql } from '../../services/run-long.js'
import { isMssql } from '../dialect.js'

/**
 * MCP calls in the request log (#2466 / #2469 / #2498) and the MCP settings (#2497).
 *
 * `nivaro_api_logs` gains five nullable columns, stamped only on requests that came through the
 * hosted MCP endpoint — the POST /api/mcp row itself (one per tool call) and the in-process calls
 * its tools make back into the API (services/mcp-calls.ts):
 *   mcp_conn     the connection: `o<grant id>` (OAuth), `k<api key id>`, `u<user id>` (token)
 *   mcp_client   the caller's name as a Traffic Map caller key slug (`Claude_Code`)
 *   mcp_tool     the tool the call ran under
 *   mcp_outcome  ok | error | refused — on the POST /api/mcp row of a tools/call only
 *   mcp_bytes    what the tool answered the agent, in bytes (same row)
 * Adding nullable columns is metadata-only on SQL Server. Two FILTERED indexes (mcp_conn IS NOT
 * NULL — every existing row is NULL, so each build is a scan with nothing to sort) serve the
 * per-connection stats and the person's "What my agents did" list; built on their own long
 * request outside knex's batch transaction (migrations 351 / 389).
 *
 * `nivaro_settings.mcp_settings` — JSON: idle review days and the per-connection rate limit.
 * Readers probe every column, so a database behind 480 keeps logging and uses the defaults.
 */
export const config = { transaction: false }

const TABLE = 'nivaro_api_logs'
const COLUMNS: Array<[string, (t: Knex.AlterTableBuilder) => void]> = [
  ['mcp_conn', (t) => t.string('mcp_conn', 60).nullable()],
  ['mcp_client', (t) => t.string('mcp_client', 60).nullable()],
  ['mcp_tool', (t) => t.string('mcp_tool', 60).nullable()],
  ['mcp_outcome', (t) => t.string('mcp_outcome', 10).nullable()],
  ['mcp_bytes', (t) => t.integer('mcp_bytes').nullable()]
]
const INDEXES: Array<[string, string]> = [
  ['ix_api_logs_mcp_conn', '(mcp_conn, created_at)'],
  ['ix_api_logs_mcp_user', '([user], created_at)']
]
const PG_CLIENTS = new Set(['pg', 'postgres', 'postgresql'])

function dialectOf(knex: Knex): string {
  return String((knex as any).client?.config?.client ?? '')
}

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) {
    for (const [name, add] of COLUMNS) {
      if (!(await knex.schema.hasColumn(TABLE, name))) {
        await knex.schema.alterTable(TABLE, (t) => {
          add(t)
        })
      }
    }
    for (const [ix, cols] of INDEXES) {
      if (isMssql(knex)) {
        await runLongSql(
          `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = '${ix}')
             CREATE INDEX ${ix} ON ${TABLE} ${cols} WHERE mcp_conn IS NOT NULL`,
          { knex, timeoutMs: 60 * 60 * 1000 }
        )
      } else if (PG_CLIENTS.has(dialectOf(knex))) {
        await knex.raw(
          `CREATE INDEX IF NOT EXISTS ${ix} ON ${TABLE} ${cols.replace(/[[\]]/g, '"')} WHERE mcp_conn IS NOT NULL`
        )
      }
    }
  }
  if (
    (await knex.schema.hasTable('nivaro_settings')) &&
    !(await knex.schema.hasColumn('nivaro_settings', 'mcp_settings'))
  ) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.text('mcp_settings').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) {
    for (const [ix] of INDEXES) {
      if (isMssql(knex)) {
        await knex.raw(
          `IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = '${ix}') DROP INDEX ${ix} ON ${TABLE}`
        )
      } else if (PG_CLIENTS.has(dialectOf(knex))) {
        await knex.raw(`DROP INDEX IF EXISTS ${ix}`)
      }
    }
    for (const [name] of COLUMNS) {
      if (await knex.schema.hasColumn(TABLE, name)) {
        await knex.schema.alterTable(TABLE, (t) => {
          t.dropColumn(name)
        })
      }
    }
  }
  if (
    (await knex.schema.hasTable('nivaro_settings')) &&
    (await knex.schema.hasColumn('nivaro_settings', 'mcp_settings'))
  ) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('mcp_settings')
    })
  }
}
