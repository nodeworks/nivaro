import type { Knex } from 'knex'
import { isMssql } from '../dialect.js'

export async function up(knex: Knex): Promise<void> {
  if (isMssql(knex))
    await knex.raw(`ALTER TABLE nivaro_field_groups ADD hide_when_empty bit NOT NULL DEFAULT 0`)
  else
    await knex.schema.alterTable('nivaro_field_groups', (t) => {
      t.boolean('hide_when_empty').notNullable().defaultTo(false)
    })
  if (isMssql(knex))
    await knex.raw(
      `ALTER TABLE nivaro_field_groups ADD visibility_mode varchar(20) NOT NULL DEFAULT 'always'`
    )
  else
    await knex.schema.alterTable('nivaro_field_groups', (t) => {
      t.string('visibility_mode', 20).notNullable().defaultTo('always')
    })
  if (isMssql(knex))
    await knex.raw(`ALTER TABLE nivaro_field_groups ADD summary_fields varchar(500) NULL`)
  else
    await knex.schema.alterTable('nivaro_field_groups', (t) => {
      t.string('summary_fields', 500).nullable()
    })
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE nivaro_field_groups DROP COLUMN hide_when_empty`)
  await knex.raw(`ALTER TABLE nivaro_field_groups DROP COLUMN visibility_mode`)
  await knex.raw(`ALTER TABLE nivaro_field_groups DROP COLUMN summary_fields`)
}
