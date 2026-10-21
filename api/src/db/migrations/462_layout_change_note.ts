import type { Knex } from 'knex'

/**
 * Required change note (#2654): a per-layout setting that makes the layout
 * editor ask for a short reason (and, with 'note_ticket', a ticket link) on
 * every save. The reason rides the History version's note.
 *
 *   nivaro_collection_layouts.change_note  varchar(20) NULL
 *     NULL = off · 'note' = reason required · 'note_ticket' = reason + ticket link
 *
 * Guarded and additive: nothing is backfilled (NULL = the old behaviour).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_collection_layouts'))) return
  if (await knex.schema.hasColumn('nivaro_collection_layouts', 'change_note')) return
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.string('change_note', 20).nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_collection_layouts'))) return
  if (!(await knex.schema.hasColumn('nivaro_collection_layouts', 'change_note'))) return
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.dropColumn('change_note')
  })
}
