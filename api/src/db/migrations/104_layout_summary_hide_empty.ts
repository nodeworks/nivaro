import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE nivaro_collection_layouts ADD summary_hide_empty bit NOT NULL DEFAULT 0`)
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE nivaro_collection_layouts DROP COLUMN summary_hide_empty`)
}
