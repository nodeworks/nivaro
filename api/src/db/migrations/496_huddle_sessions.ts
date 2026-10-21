import type { Knex } from 'knex'

/**
 * Huddle sessions (#2849): one row per finished huddle, for the admin "Huddles" tab in
 * Chat Analytics. Counts and timings only — no audio, no names. `room` is NULL for direct
 * and group-conversation sessions (their keys carry user ids). RUNTIME table: rows are
 * written by the running app, never copied between instances. Pruned after 180 days by
 * the `huddle-sessions-prune` cron.
 *
 * Guarded and additive. Without the table the app keeps recent sessions in Redis.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_chat_huddle_sessions')) return
  await knex.schema.createTable('nivaro_chat_huddle_sessions', (t) => {
    t.increments('id').primary()
    t.string('room', 200).nullable()
    t.string('kind', 20).notNullable()
    t.datetime('started_at').notNullable()
    t.datetime('ended_at').notNullable()
    t.integer('duration_s').notNullable().defaultTo(0)
    t.integer('participants').notNullable().defaultTo(0)
    t.integer('peak').notNullable().defaultTo(0)
    t.boolean('screen_shared').notNullable().defaultTo(false)
    t.integer('quality_reports').notNullable().defaultTo(0)
    t.float('relay_share').nullable()
    t.integer('ice_failed').notNullable().defaultTo(0)
    t.float('avg_loss').nullable()
    t.integer('avg_rtt_ms').nullable()
    t.index(['ended_at'], 'ix_nivaro_chat_huddle_sessions_ended')
  })
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_chat_huddle_sessions')) {
    await knex.schema.dropTable('nivaro_chat_huddle_sessions')
  }
}
