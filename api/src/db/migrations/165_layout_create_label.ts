import type { Knex } from 'knex'

// `create_label` on nivaro_collection_layouts: optional display label for the
// collection browser's New-item layout menu (falls back to the layout name).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.string('create_label', 255).nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.dropColumn('create_label')
  })
}
