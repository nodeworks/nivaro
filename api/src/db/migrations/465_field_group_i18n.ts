import type { Knex } from 'knex'

/**
 * Section label translations (#2665).
 *
 * `nivaro_field_groups.i18n` — text JSON `{ "<locale>": { "label": "…" } }`: a
 * section's, tab's or step's label per language, edited in the layout editor's
 * inspector and saved through the layout ops like every other group setting
 * (so it versions with the layout). Field labels and help text need no column:
 * they live in the placement's `overrides.i18n`.
 *
 * Guarded and additive: nullable, no default, added only when missing. The
 * code reads and writes it only once it exists (groupI18nSupported).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_field_groups'))) return
  if (await knex.schema.hasColumn('nivaro_field_groups', 'i18n')) return
  await knex.schema.alterTable('nivaro_field_groups', (t) => {
    t.text('i18n').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_field_groups', 'i18n'))) return
  await knex.schema.alterTable('nivaro_field_groups', (t) => {
    t.dropColumn('i18n')
  })
}
