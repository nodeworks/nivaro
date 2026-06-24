import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.boolean('single_active_addendum').notNullable().defaultTo(false)
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.dropColumn('single_active_addendum')
  })
}
