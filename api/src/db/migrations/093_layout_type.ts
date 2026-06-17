import type { Knex } from 'knex'

export async function up(knex: Knex) {
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.string('layout_type', 50).defaultTo('grouped').nullable()
  })
}

export async function down(knex: Knex) {
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.dropColumn('layout_type')
  })
}
