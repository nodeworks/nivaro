import type { Knex } from 'knex'

/**
 * Record-form section width (2026-11-13):
 *  - nivaro_field_groups.form_width — 'full' | 'half' | NULL (= full).
 *    How wide a top-level section sits on the record FORM (edit mode): two
 *    half sections next to each other share a row from the lg breakpoint;
 *    phones always stack. Separate from read_width (migration 311), which
 *    only shapes the read view / summary / detail panels and is untouched.
 *    Code reads and writes it only once it exists (hasColumn probe).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_field_groups', 'form_width'))) {
    await knex.schema.alterTable('nivaro_field_groups', (t) => {
      t.string('form_width', 12).nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_field_groups', 'form_width')) {
    await knex.schema.alterTable('nivaro_field_groups', (t) => {
      t.dropColumn('form_width')
    })
  }
}
