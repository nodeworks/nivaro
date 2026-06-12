import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  const hasTabMode = await knex.schema.hasColumn('nivaro_collection_layouts', 'tab_mode')
  if (!hasTabMode) {
    await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
      t.string('tab_mode', 10).notNullable().defaultTo('tabs')
      t.specificType('validate_before_next', 'bit').notNullable().defaultTo(0)
      t.specificType('summary_enabled', 'bit').notNullable().defaultTo(0)
      t.specificType('summary_show_all', 'bit').notNullable().defaultTo(0)
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.dropColumn('tab_mode')
    t.dropColumn('validate_before_next')
    t.dropColumn('summary_enabled')
    t.dropColumn('summary_show_all')
  })
}
