import type { Knex } from 'knex'

/**
 * Scheduled changes apply themselves (2026-11-15, services/scheduled-apply.ts):
 *  - nivaro_scheduled_changes.apply_meta — nvarchar(max) NULL, JSON bookkeeping per change:
 *    the scheduled fields' values when it was scheduled (conflict check), their values just
 *    before it was applied (24 h undo), the undo deadline and who applied it. Never sent to
 *    clients. Rows written before this migration kept the same JSON in `inngest_event_id`
 *    (500 characters); the code still reads it from there for those rows.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_scheduled_changes'))) return
  if (!(await knex.schema.hasColumn('nivaro_scheduled_changes', 'apply_meta'))) {
    await knex.schema.alterTable('nivaro_scheduled_changes', (t) => {
      t.text('apply_meta').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_scheduled_changes'))) return
  if (await knex.schema.hasColumn('nivaro_scheduled_changes', 'apply_meta')) {
    await knex.schema.alterTable('nivaro_scheduled_changes', (t) => {
      t.dropColumn('apply_meta')
    })
  }
}
