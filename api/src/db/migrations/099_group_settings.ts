import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE nivaro_field_groups ADD hide_when_empty bit NOT NULL DEFAULT 0`)
  await knex.raw(`ALTER TABLE nivaro_field_groups ADD visibility_mode varchar(20) NOT NULL DEFAULT 'always'`)
  await knex.raw(`ALTER TABLE nivaro_field_groups ADD summary_fields varchar(500) NULL`)
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE nivaro_field_groups DROP COLUMN hide_when_empty`)
  await knex.raw(`ALTER TABLE nivaro_field_groups DROP COLUMN visibility_mode`)
  await knex.raw(`ALTER TABLE nivaro_field_groups DROP COLUMN summary_fields`)
}
