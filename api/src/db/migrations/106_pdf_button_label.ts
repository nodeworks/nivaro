import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.string('pdf_button_label', 100).nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.dropColumn('pdf_button_label')
  })
}
