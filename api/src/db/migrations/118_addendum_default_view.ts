import type { Knex } from 'knex'

export async function up(knex: Knex) {
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.boolean('addendum_default_view').notNullable().defaultTo(false)
  })
}

export async function down(knex: Knex) {
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.dropColumn('addendum_default_view')
  })
}
