import type { Knex } from 'knex'

// `create_hidden` on nivaro_collection_layouts: explicitly excludes a slugged
// grouped layout from the collection browser's New-item dropdown (the slug
// may still be needed for queues / detail sheets / ?layout= links).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.boolean('create_hidden').notNullable().defaultTo(false)
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.dropColumn('create_hidden')
  })
}
