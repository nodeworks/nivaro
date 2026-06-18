import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE nivaro_collection_layouts ADD accordion_mode bit NOT NULL DEFAULT 0`)
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE nivaro_collection_layouts DROP COLUMN accordion_mode`)
}
