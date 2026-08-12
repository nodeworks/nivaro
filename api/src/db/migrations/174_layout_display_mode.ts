import type { Knex } from 'knex'

// Detail-layout render mode: null/'form' = editable ItemEditForm (allocation
// sheets), 'read' = the read-only RecordReadView presentation (definition
// grids + tabbed child lists, no inputs) used by drill-down sheets.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.string('display_mode', 20).nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.dropColumn('display_mode')
  })
}
