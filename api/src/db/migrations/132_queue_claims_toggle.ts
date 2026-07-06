import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_queues', (t) => {
    // Per-queue toggle for the claim/release feature (default on — existing behavior).
    t.boolean('claims_enabled').notNullable().defaultTo(true)
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_queues', (t) => {
    t.dropColumn('claims_enabled')
  })
}
