import type { Knex } from 'knex'

/**
 * Quick picker (2026-09-11): an ordered list of relation fields a grouped
 * layout walks one step at a time when a record is created (Funding Year →
 * Zone → Region → Project Type → Project → Sub Type). JSON string[]; null =
 * no quick picker for the layout. Seeded from the cascade graph in the
 * Table Editor, never automatically.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_collection_layouts'))) return
  if (!(await knex.schema.hasColumn('nivaro_collection_layouts', 'quick_picker'))) {
    await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
      t.text('quick_picker').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_collection_layouts'))) return
  if (await knex.schema.hasColumn('nivaro_collection_layouts', 'quick_picker')) {
    await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
      t.dropColumn('quick_picker')
    })
  }
}
