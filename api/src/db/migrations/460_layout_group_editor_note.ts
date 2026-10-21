import type { Knex } from 'knex'

/**
 * Notes on the canvas (#2608): an admin can pin a short note to a form
 * section ("Finance asked for this in Q3"). The note is a small JSON object
 * {text, by, by_name, at} in `nivaro_field_groups.editor_note`; a field's
 * note rides its placement's existing `overrides` JSON (key `editor_note`),
 * so only sections need a column. Both are written through the layout ops,
 * so a note is versioned with the layout and undoes like any other change.
 * Record pages never receive either (the /active and /detail routes strip them).
 *
 * Guarded and additive: a nullable text column, added only when missing.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_field_groups'))) return
  if (await knex.schema.hasColumn('nivaro_field_groups', 'editor_note')) return
  await knex.schema.alterTable('nivaro_field_groups', (t) => {
    t.text('editor_note').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_field_groups'))) return
  if (!(await knex.schema.hasColumn('nivaro_field_groups', 'editor_note'))) return
  await knex.schema.alterTable('nivaro_field_groups', (t) => {
    t.dropColumn('editor_note')
  })
}
