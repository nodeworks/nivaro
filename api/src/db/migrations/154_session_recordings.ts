import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_session_recordings', (t) => {
    t.uuid('id').primary()
    t.uuid('user').notNullable().references('id').inTable('nivaro_users').onDelete('CASCADE')
    t.dateTime('started_at').notNullable()
    t.dateTime('ended_at').nullable()
    t.dateTime('last_event_at').nullable()
    t.integer('event_count').notNullable().defaultTo(0)
    t.integer('byte_size').notNullable().defaultTo(0)
    t.boolean('truncated').notNullable().defaultTo(false)
    t.index(['user', 'started_at'])
    t.index(['started_at'])
  })

  await knex.schema.createTable('nivaro_session_events', (t) => {
    t.increments('id').primary()
    t.uuid('recording')
      .notNullable()
      .references('id')
      .inTable('nivaro_session_recordings')
      .onDelete('CASCADE')
    t.integer('seq').notNullable()
    t.text('events', 'longtext').notNullable()
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now())
    t.index(['recording', 'seq'])
  })

  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.boolean('session_recording_enabled').notNullable().defaultTo(false)
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_session_events')
  await knex.schema.dropTableIfExists('nivaro_session_recordings')
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.dropColumn('session_recording_enabled')
  })
}
