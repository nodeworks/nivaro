import type { Knex } from 'knex'
import { runLongSql } from '../../services/run-long.js'
import { isMssql } from '../dialect.js'

/**
 * MCP write attribution (#3213 agent badge, #3219 roll back a connection's changes).
 *
 *   nivaro_activity.mcp_conn  nvarchar(40) NULL — the MCP connection a write arrived on
 *                             (`o<grant uuid>` | `k<api key id>` | `u<user uuid>`,
 *                             services/mcp-calls.ts CONN_RE). Set only on writes the hosted
 *                             MCP endpoint's tool calls made (req.mcpInner).
 *   nivaro_activity.via_app   nvarchar(80) NULL — the connected app's name at the time of the
 *                             write (OAuth client registration / API key name), shown as the
 *                             record's "via …" badge.
 *   ix_nivaro_activity_mcp_conn  (mcp_conn, [timestamp]) WHERE mcp_conn IS NOT NULL — the
 *                             rollback preview's read. Filtered, so it holds agent rows only.
 *
 * Both columns are nullable (a metadata-only change on SQL Server). The filtered index still
 * reads the table once while it builds: on its own long request, outside knex's batch
 * transaction (migration 502's pattern). SQL Server Standard has no ONLINE build — writes to
 * nivaro_activity wait for it (about a minute at 12M rows).
 */
export const config = { transaction: false }

const TABLE = 'nivaro_activity'

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  if (!(await knex.schema.hasColumn(TABLE, 'mcp_conn'))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.string('mcp_conn', 40).nullable()
    })
  }
  if (!(await knex.schema.hasColumn(TABLE, 'via_app'))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.string('via_app', 80).nullable()
    })
  }
  // A performance index only: other dialects skip it (#757).
  if (!isMssql(knex)) return
  await runLongSql(
    `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_nivaro_activity_mcp_conn')
       CREATE INDEX ix_nivaro_activity_mcp_conn
         ON nivaro_activity (mcp_conn, [timestamp])
         INCLUDE ([user], [action], [collection], [item])
         WHERE mcp_conn IS NOT NULL
         WITH (SORT_IN_TEMPDB = ON)`,
    { timeoutMs: 60 * 60 * 1000 }
  )
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  if (isMssql(knex)) {
    await knex.raw(`
      IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_nivaro_activity_mcp_conn')
      DROP INDEX ix_nivaro_activity_mcp_conn ON nivaro_activity
    `)
  }
  for (const col of ['via_app', 'mcp_conn']) {
    if (await knex.schema.hasColumn(TABLE, col)) {
      await knex.schema.alterTable(TABLE, (t) => {
        t.dropColumn(col)
      })
    }
  }
}
