import type { Knex } from 'knex'
import { isMssql } from '../dialect.js'

export async function up(knex: Knex): Promise<void> {
  if (isMssql(knex))
    await knex.raw(`ALTER TABLE nivaro_collection_layouts ADD disable_clone bit NOT NULL DEFAULT 0`)
  else
    await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
      t.boolean('disable_clone').notNullable().defaultTo(false)
    })
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE nivaro_collection_layouts DROP COLUMN disable_clone`)
}
