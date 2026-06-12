import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_collection_layouts', 'conditions')
  if (!has) {
    await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
      t.specificType('conditions', 'nvarchar(max)').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.dropColumn('conditions')
  })
}
