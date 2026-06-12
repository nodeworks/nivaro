import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  const hasComments = await knex.schema.hasColumn('nivaro_collection_layouts', 'disable_comments')
  if (!hasComments) {
    await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
      t.specificType('disable_comments', 'bit').notNullable().defaultTo(0)
      t.specificType('disable_tasks', 'bit').notNullable().defaultTo(0)
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.dropColumn('disable_comments')
    t.dropColumn('disable_tasks')
  })
}
