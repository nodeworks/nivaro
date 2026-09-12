import type { Knex } from 'knex'

/**
 * Read-mode detail layouts get presentation settings: the drill sheet's
 * width, a header band of identity fields rendered above the cards, and an
 * option to collapse empty values instead of rendering "—" walls.
 */
export async function up(knex: Knex): Promise<void> {
  const t = 'nivaro_collection_layouts'
  if (!(await knex.schema.hasColumn(t, 'sheet_width'))) {
    await knex.schema.alterTable(t, (tb) => {
      tb.integer('sheet_width').nullable()
    })
  }
  if (!(await knex.schema.hasColumn(t, 'header_fields'))) {
    await knex.schema.alterTable(t, (tb) => {
      tb.text('header_fields').nullable() // JSON string[] of field keys
    })
  }
  if (!(await knex.schema.hasColumn(t, 'hide_empty'))) {
    await knex.schema.alterTable(t, (tb) => {
      tb.boolean('hide_empty').notNullable().defaultTo(false)
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  const t = 'nivaro_collection_layouts'
  for (const c of ['sheet_width', 'header_fields', 'hide_empty']) {
    if (await knex.schema.hasColumn(t, c)) {
      await knex.schema.alterTable(t, (tb) => {
        tb.dropColumn(c)
      })
    }
  }
}
