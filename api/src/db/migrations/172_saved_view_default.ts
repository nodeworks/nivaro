import type { Knex } from 'knex'

// Collection-level default browser view: one saved view per collection can be
// flagged is_default (admin-set, forced shared) — browsers apply it for every
// viewer who hasn't picked their own state yet.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_saved_views', (t) => {
    t.boolean('is_default').notNullable().defaultTo(false)
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_saved_views', (t) => {
    t.dropColumn('is_default')
  })
}
