import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_queue_sources', (t) => {
    // 'include' (default, existing behavior): state_values is an allow-list.
    // 'exclude': state_values lists states to drop; stateless items are kept.
    t.string('state_mode', 10).notNullable().defaultTo('include')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_queue_sources', (t) => {
    t.dropColumn('state_mode')
  })
}
