import type { Knex } from 'knex'
import { isMssql } from '../dialect.js'

export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_collection_layouts', 'addendum_lock_fields')
  if (!has) {
    if (isMssql(knex))
      await knex.raw(
        'ALTER TABLE nivaro_collection_layouts ADD addendum_lock_fields bit NOT NULL DEFAULT 1'
      )
    else
      await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
        t.boolean('addendum_lock_fields').notNullable().defaultTo(true)
      })
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_collection_layouts', 'addendum_lock_fields')
  if (has) {
    await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
      t.dropColumn('addendum_lock_fields')
    })
  }
}
