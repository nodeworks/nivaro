import type { Knex } from 'knex'
import { isMssql } from '../dialect.js'

export async function up(knex: Knex): Promise<void> {
  if (isMssql(knex))
    await knex.raw(`ALTER TABLE nivaro_field_groups ADD summary_hide_empty bit NOT NULL DEFAULT 0`)
  else
    await knex.schema.alterTable('nivaro_field_groups', (t) => {
      t.boolean('summary_hide_empty').notNullable().defaultTo(false)
    })
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE nivaro_field_groups DROP COLUMN summary_hide_empty`)
}
