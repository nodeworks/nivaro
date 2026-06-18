import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE nivaro_layout_field_assignments ADD show_row_revisions bit NOT NULL DEFAULT 0`)
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE nivaro_layout_field_assignments DROP COLUMN show_row_revisions`)
}
