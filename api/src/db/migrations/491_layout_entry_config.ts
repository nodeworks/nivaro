import type { Knex } from 'knex'

/**
 * Entry ergonomics (#2702 #2707 #2708 #2710 #2711 #2728): one JSON text column
 * on a layout carries every "how people enter data on this form" setting —
 * placement presets, keyboard-first flags, tab order, beginner / expert mode
 * and the form identity badge.
 *
 *   nivaro_collection_layouts.entry_config  nvarchar(max) NULL
 *     NULL = none of it (the old behaviour). Shape: services/layout-entry.ts.
 *
 * Guarded and additive: nothing is backfilled.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_collection_layouts'))) return
  if (await knex.schema.hasColumn('nivaro_collection_layouts', 'entry_config')) return
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.text('entry_config').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_collection_layouts'))) return
  if (!(await knex.schema.hasColumn('nivaro_collection_layouts', 'entry_config'))) return
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.dropColumn('entry_config')
  })
}
