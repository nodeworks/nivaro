import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  // Rename tables
  await knex.schema.renameTable('nivaro_line_items', 'nivaro_sub_rows')
  await knex.schema.renameTable('nivaro_line_item_templates', 'nivaro_sub_row_templates')

  // Rename column line_item_field → sub_row_field on nivaro_sub_rows
  await knex.schema.alterTable('nivaro_sub_rows', (t) => {
    t.renameColumn('line_item_field', 'sub_row_field')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_sub_rows', (t) => {
    t.renameColumn('sub_row_field', 'line_item_field')
  })
  await knex.schema.renameTable('nivaro_sub_rows', 'nivaro_line_items')
  await knex.schema.renameTable('nivaro_sub_row_templates', 'nivaro_line_item_templates')
}
