import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_queues', (t) => {
    // JSON QueueDisplayConfig — per-queue display toggles (allowed views,
    // default view/scope, Work Next, bulk actions). NULL = all defaults.
    // Supersedes the never-honored view_mode column.
    t.specificType('display_config', 'nvarchar(max)').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_queues', (t) => {
    t.dropColumn('display_config')
  })
}
