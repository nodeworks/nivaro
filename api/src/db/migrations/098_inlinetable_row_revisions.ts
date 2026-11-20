import type { Knex } from 'knex'
import { isMssql } from '../dialect.js'

export async function up(knex: Knex): Promise<void> {
  if (isMssql(knex))
    await knex.raw(
      `ALTER TABLE nivaro_layout_field_assignments ADD show_row_revisions bit NOT NULL DEFAULT 0`
    )
  else
    await knex.schema.alterTable('nivaro_layout_field_assignments', (t) => {
      t.boolean('show_row_revisions').notNullable().defaultTo(false)
    })
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE nivaro_layout_field_assignments DROP COLUMN show_row_revisions`)
}
