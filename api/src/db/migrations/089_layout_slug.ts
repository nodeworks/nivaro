import type { Knex } from 'knex'

export async function up(knex: Knex) {
  const has = await knex.schema.hasColumn('nivaro_collection_layouts', 'slug')
  if (!has) {
    await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
      t.string('slug', 255).nullable()
    })
  }
}

export async function down(knex: Knex) {
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.dropColumn('slug')
  })
}
