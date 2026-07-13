import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_admin_journeys', (t) => {
    t.increments('id').primary()
    t.uuid('user').notNullable().references('id').inTable('nivaro_users').onDelete('CASCADE')
    t.string('session_id', 64).notNullable()
    t.string('path', 300).notNullable()
    t.dateTime('entered_at').notNullable()
    t.integer('duration_seconds').nullable()
    t.index(['user', 'entered_at'])
    t.index(['session_id'])
    t.index(['entered_at'])
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_admin_journeys')
}
