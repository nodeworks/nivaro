import type { Knex } from 'knex'

/**
 * A section as an email body (#2725): the layout names the section whose
 * fields notification emails show as the record summary, in place of the
 * header strip.
 *
 *   nivaro_collection_layouts.email_summary_group  varchar(100) NULL
 *     NULL = the header strip (the old behaviour) · else a group key of this layout
 *
 * Guarded and additive: nothing is backfilled.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_collection_layouts'))) return
  if (await knex.schema.hasColumn('nivaro_collection_layouts', 'email_summary_group')) return
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.string('email_summary_group', 100).nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_collection_layouts'))) return
  if (!(await knex.schema.hasColumn('nivaro_collection_layouts', 'email_summary_group'))) return
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.dropColumn('email_summary_group')
  })
}
