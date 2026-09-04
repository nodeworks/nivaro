import type { Knex } from 'knex'

/**
 * Cron schedule overrides — JSON map `{ [cronId]: { expression, note?,
 * updated_by?, updated_at? } }` on nivaro_settings. Every registered cron
 * (core or extension) can have its schedule replaced from the admin without a
 * deploy; hydrated before extensions register so the override applies no
 * matter who owns the job. Revert = delete the entry. Pause/enable stays in
 * the sibling paused_crons column.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_settings', 'cron_overrides'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.text('cron_overrides').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_settings', 'cron_overrides')) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('cron_overrides')
    })
  }
}
