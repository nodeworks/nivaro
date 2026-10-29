import type { Knex } from 'knex'
import { runLongSql } from '../../services/run-long.js'
import { isMssql } from '../dialect.js'

/**
 * Human-readable audit trail (activity sentences, bursts, real actors).
 *
 *   nivaro_activity.group_key  nvarchar(64) NULL — the burst a row belongs to: every row one
 *                              bulk action, import run, flow run, cron tick, batch request or
 *                              MCP request wrote shares it (`bulk:<request id>`,
 *                              `import_run:<id>`, `flow_run:<id>`, `cron:<chain id>`,
 *                              `mcp:<request id>`; services/activity-scope.ts). The Activity
 *                              page folds a burst into one expandable line. NULL = a single
 *                              write (or a row from before 516 — readers fall back to
 *                              same person + collection + action within 60 s).
 *   nivaro_activity.actor      nvarchar(400) NULL — JSON {kind, id, name, on_behalf_of}: who
 *                              really did it when that is not simply the signed-in person
 *                              (view_as | api_key | mcp | import | flow | cron | system). NULL
 *                              = a person acting as themselves, or a row from before 516 —
 *                              readers derive it from auth_method / api_key_id / mcp_conn /
 *                              chain_parent / origin (lib/activity-sentence.ts actorOf).
 *   ix_nivaro_activity_group_key  (group_key, id) WHERE group_key IS NOT NULL — expanding a
 *                              burst reads its rows by key. Filtered: single writes hold none.
 *
 * Both columns are nullable (a metadata-only change on SQL Server). The filtered index still
 * reads the table once while it builds: on its own long request, outside knex's batch
 * transaction (migrations 502/512's pattern). SQL Server Standard has no ONLINE build —
 * writes to nivaro_activity wait for it (about a minute at 12M rows).
 */
export const config = { transaction: false }

const TABLE = 'nivaro_activity'

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  if (!(await knex.schema.hasColumn(TABLE, 'group_key'))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.string('group_key', 64).nullable()
    })
  }
  if (!(await knex.schema.hasColumn(TABLE, 'actor'))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.string('actor', 400).nullable()
    })
  }
  // A performance index only: other dialects skip it (#757).
  if (!isMssql(knex)) return
  await runLongSql(
    `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_nivaro_activity_group_key')
       CREATE INDEX ix_nivaro_activity_group_key
         ON nivaro_activity (group_key, id)
         WHERE group_key IS NOT NULL
         WITH (SORT_IN_TEMPDB = ON)`,
    { timeoutMs: 60 * 60 * 1000 }
  )
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  if (isMssql(knex)) {
    await knex.raw(`
      IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_nivaro_activity_group_key')
      DROP INDEX ix_nivaro_activity_group_key ON nivaro_activity
    `)
  }
  for (const col of ['actor', 'group_key']) {
    if (await knex.schema.hasColumn(TABLE, col)) {
      await knex.schema.alterTable(TABLE, (t) => {
        t.dropColumn(col)
      })
    }
  }
}
