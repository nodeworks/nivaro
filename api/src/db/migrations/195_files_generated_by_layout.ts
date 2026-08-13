import type { Knex } from 'knex'

/**
 * Marks a file as PDF output of a layout's generate-and-attach.
 *
 * Needed so a re-save can REPLACE the document it generated last time instead
 * of stacking a new copy on every save — identified by provenance rather than
 * by filename, so a user-uploaded file that happens to share a name is never
 * deleted. NULL = uploaded by a person; nothing prunes those.
 */
export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_files', 'generated_by_layout')
  if (!has) {
    await knex.schema.alterTable('nivaro_files', (t) => {
      t.integer('generated_by_layout').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_files', 'generated_by_layout')
  if (has) {
    await knex.schema.alterTable('nivaro_files', (t) => {
      t.dropColumn('generated_by_layout')
    })
  }
}
