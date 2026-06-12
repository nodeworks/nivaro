import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  const hasCol = await knex.schema.hasColumn('nivaro_collections', 'picker_filter')
  if (!hasCol) {
    await knex.schema.alterTable('nivaro_collections', t => {
      t.specificType('picker_filter', 'nvarchar(max)').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_collections', t => {
    t.dropColumn('picker_filter')
  })
}
