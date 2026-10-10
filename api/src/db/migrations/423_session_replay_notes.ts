import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Timestamped notes on a session recording (#1363): an admin pins a remark to
 * a moment of a replay ("the save button greys out here"), sees it as a marker
 * on the scrubber, and can copy it onto the linked issue or an investigation
 * notebook with a deep link back to that second.
 *
 * `recording` cascades with its recording. `user` is a bare uuid with no FK:
 * nivaro_session_recordings.user already cascades from nivaro_users, and a
 * second cascading path users → notes is refused by SQL Server (error 1785,
 * multiple cascade paths) — a deleted user's notes go with their recordings,
 * and a note by a deleted admin simply shows no author. Runtime data — never
 * promoted between environments.
 */
const TABLE = 'nivaro_replay_notes'

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) return
  await knex.schema.createTable(TABLE, (t) => {
    t.uuid('id').primary()
    t.uuid('recording')
      .notNullable()
      .references('id')
      .inTable('nivaro_session_recordings')
      .onDelete('CASCADE')
    t.integer('at_ms').notNullable()
    t.text('text').notNullable()
    t.uuid('user').nullable()
    t.datetime('created_at').notNullable().defaultTo(utcNow(knex))
    t.datetime('updated_at').notNullable().defaultTo(utcNow(knex))
    t.index(['recording', 'at_ms'], 'ix_replay_notes_recording_at')
  })
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) await knex.schema.dropTable(TABLE)
}
