import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_collections', (t) => {
    // Default 1 — all existing collections keep locking enabled
    t.specificType('item_locking_enabled', 'bit').notNullable().defaultTo(1)
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_collections', (t) => {
    t.dropColumn('item_locking_enabled')
  })
}
