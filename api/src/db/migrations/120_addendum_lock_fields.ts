import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_collection_layouts', 'addendum_lock_fields')
  if (!has) {
    await knex.raw('ALTER TABLE nivaro_collection_layouts ADD addendum_lock_fields bit NOT NULL DEFAULT 1')
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
