import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.bit('disable_revisions').defaultTo(0).notNullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.dropColumn('disable_revisions')
  })
}
