import type { Knex } from 'knex'

/**
 * Read-view section width (2026-09-14):
 *  - nivaro_field_groups.read_width — 'full' | 'half' | 'third' | NULL (auto).
 *    How wide a section renders on the read-only board (Summary mode, detail
 *    sheets). NULL = auto: half for a short fact list, full when the section
 *    holds a child grid, a widget or many fields. Edited per group in the
 *    Table Editor's layout tab.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_field_groups', 'read_width'))) {
    await knex.schema.alterTable('nivaro_field_groups', (t) => {
      t.string('read_width', 12).nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_field_groups', 'read_width')) {
    await knex.schema.alterTable('nivaro_field_groups', (t) => {
      t.dropColumn('read_width')
    })
  }
}
