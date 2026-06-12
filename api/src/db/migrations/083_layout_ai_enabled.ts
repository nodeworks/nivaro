import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_collection_layouts', 'ai_enabled')
  if (!has) {
    await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
      t.specificType('ai_enabled', 'bit').notNullable().defaultTo(0)
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.dropColumn('ai_enabled')
  })
}
