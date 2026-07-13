import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_session_recordings', (t) => {
    t.string('app', 100).nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_session_recordings', (t) => {
    t.dropColumn('app')
  })
}
