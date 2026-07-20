import type { Knex } from 'knex'

// Record-value-based layout selection: `record_conditions` (JSON rule array
// matched against a record — all rules must match for the layout to win) and
// `default_values` (JSON stamped onto new-record drafts when this layout is
// active) on nivaro_collection_layouts.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.text('record_conditions').nullable()
    t.text('default_values').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.dropColumn('record_conditions')
    t.dropColumn('default_values')
  })
}
