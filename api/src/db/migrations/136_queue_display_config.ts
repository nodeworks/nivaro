import type { Knex } from 'knex'
import { longText } from '../portable-ddl.js'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_queues', (t) => {
    // JSON QueueDisplayConfig — per-queue display toggles (allowed views,
    // default view/scope, Work Next, bulk actions). NULL = all defaults.
    // Supersedes the never-honored view_mode column.
    longText(t, knex, 'display_config').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_queues', (t) => {
    t.dropColumn('display_config')
  })
}
