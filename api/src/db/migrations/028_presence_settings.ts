import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.integer('presence_session_ttl').defaultTo(20)
    t.integer('presence_sweep_interval').defaultTo(8000)
    t.integer('presence_ping_interval').defaultTo(10000)
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.dropColumn('presence_session_ttl')
    t.dropColumn('presence_sweep_interval')
    t.dropColumn('presence_ping_interval')
  })
}
