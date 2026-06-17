import type { Knex } from 'knex'

export async function up(knex: Knex) {
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.string('row_order_field', 255).nullable()
  })
}

export async function down(knex: Knex) {
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.dropColumn('row_order_field')
  })
}
