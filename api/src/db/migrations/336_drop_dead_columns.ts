import type { Knex } from 'knex'

/**
 * Drop nivaro_queues.view_mode (#505).
 *
 * Documented "DEAD — superseded by display_config, never read" since
 * 2026-07-06; nothing in api/src, packages or admin names it any more
 * (verified by `pnpm dead-columns:check`). Left in place it is a trap for
 * the next reader. Guarded so a database already without it is a no-op.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_queues', 'view_mode')) {
    // A DEFAULT constraint blocks DROP COLUMN on MSSQL — find and drop it first.
    await knex.raw(`
      DECLARE @c sysname;
      SELECT @c = dc.name FROM sys.default_constraints dc
        JOIN sys.columns c ON c.default_object_id = dc.object_id
       WHERE dc.parent_object_id = OBJECT_ID('nivaro_queues') AND c.name = 'view_mode';
      IF @c IS NOT NULL EXEC('ALTER TABLE nivaro_queues DROP CONSTRAINT [' + @c + ']');
    `)
    await knex.schema.alterTable('nivaro_queues', (t) => {
      t.dropColumn('view_mode')
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_queues', 'view_mode'))) {
    await knex.schema.alterTable('nivaro_queues', (t) => {
      t.string('view_mode', 20).notNullable().defaultTo('table')
    })
  }
}
