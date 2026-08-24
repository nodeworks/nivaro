import type { Knex } from 'knex'

// Data Model sprint: collection folders (#356), layout inheritance (#424),
// FK auto-index policy (#358).
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_collections', 'folder'))) {
    await knex.schema.alterTable('nivaro_collections', (t) => {
      t.string('folder', 120).nullable()
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_collection_layouts', 'parent_layout_id'))) {
    await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
      // Self-referential — NO ACTION per the MSSQL FK rule.
      t.integer('parent_layout_id').nullable()
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_settings', 'auto_index_fk'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.boolean('auto_index_fk').notNullable().defaultTo(false)
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const [table, col] of [
    ['nivaro_collections', 'folder'],
    ['nivaro_collection_layouts', 'parent_layout_id'],
    ['nivaro_settings', 'auto_index_fk']
  ] as const) {
    if (await knex.schema.hasColumn(table, col)) {
      await knex.schema.alterTable(table, (t) => t.dropColumn(col))
    }
  }
}
