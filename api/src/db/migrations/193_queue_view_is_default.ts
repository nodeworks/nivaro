import type { Knex } from 'knex'

/**
 * Queue-wide default saved view — CBV is_default parity for queues: ONE view
 * per queue is the base every viewer gets when they have no personal default
 * (nivaro_queue_column_prefs.default_view_id still wins per viewer). Setting
 * it is queue-owner/admin only and forces the view shared.
 */
export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_queue_views', 'is_default')
  if (!has) {
    await knex.schema.alterTable('nivaro_queue_views', (t) => {
      t.boolean('is_default').notNullable().defaultTo(false)
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_queue_views', 'is_default')
  if (has) {
    await knex.schema.alterTable('nivaro_queue_views', (t) => {
      t.dropColumn('is_default')
    })
  }
}
