import type { Knex } from 'knex'
import { isMssql } from '../dialect.js'

/**
 * Monthly API usage statements per key (#1462).
 *   - usage_statement (bit, default 0): send the key's monthly usage statement
 *     on the 1st (cron `api-key-usage-statements`). Off until an admin turns
 *     it on for the key.
 *   - usage_contact (nvarchar 320, NULL): where the statement goes; NULL = the
 *     key owner's email.
 *   - usage_statement_sent_for (varchar 7, NULL): the 'YYYY-MM' month the last
 *     statement covered — a second run in the same month (run-now, a replica
 *     catch-up) sends nothing.
 */
const TABLE = 'nivaro_api_keys'

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  if (!(await knex.schema.hasColumn(TABLE, 'usage_statement'))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.boolean('usage_statement').notNullable().defaultTo(false)
    })
  }
  if (!(await knex.schema.hasColumn(TABLE, 'usage_contact'))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.string('usage_contact', 320).nullable()
    })
  }
  if (!(await knex.schema.hasColumn(TABLE, 'usage_statement_sent_for'))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.string('usage_statement_sent_for', 7).nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  for (const col of ['usage_statement_sent_for', 'usage_contact']) {
    if (await knex.schema.hasColumn(TABLE, col)) {
      await knex.schema.alterTable(TABLE, (t) => t.dropColumn(col))
    }
  }
  if (await knex.schema.hasColumn(TABLE, 'usage_statement')) {
    // A DEFAULT constraint blocks DROP COLUMN on SQL Server — drop it first.
    if (isMssql(knex)) {
      await knex.raw(`
        DECLARE @c sysname;
        SELECT @c = dc.name FROM sys.default_constraints dc
          JOIN sys.columns c ON c.default_object_id = dc.object_id
         WHERE dc.parent_object_id = OBJECT_ID('${TABLE}') AND c.name = 'usage_statement';
        IF @c IS NOT NULL EXEC('ALTER TABLE ${TABLE} DROP CONSTRAINT [' + @c + ']');
      `)
    }
    await knex.schema.alterTable(TABLE, (t) => t.dropColumn('usage_statement'))
  }
}
