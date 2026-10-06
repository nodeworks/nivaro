import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Auto-transition failure memory (#1217). An automatic transition whose
 * blocking action fails (a partner refusing the order push) used to fire again
 * on every write and every hourly sweep — one refused request produced 192
 * failed submissions in four hours. One row per (instance, transition)
 * remembers the last failure: what kind of error it was and a hash of the
 * payload the blocking actions would send. The engine skips that transition
 * while the hash is unchanged; a changed payload, a manual transition or a
 * manual retry clears the row. Instance / transition ids are plain strings
 * with no FK — the memory must never block deleting either.
 */
const TABLE = 'nivaro_auto_transition_failures'

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) return
  await knex.schema.createTable(TABLE, (t) => {
    t.increments('id').primary()
    t.string('instance_id', 36).notNullable()
    t.string('transition_id', 36).notNullable()
    t.string('collection', 255).notNullable()
    t.string('item', 255).notNullable()
    t.string('transition_label', 255).nullable()
    // transient | rate_limited | auth | not_found | validation | unknown
    t.string('error_class', 20).nullable()
    t.string('error', 2000).nullable()
    // sha256 over what the transition's blocking actions would send.
    t.string('payload_hash', 64).nullable()
    t.integer('attempts').notNullable().defaultTo(1)
    t.datetime('first_failed_at').notNullable().defaultTo(utcNow(knex))
    t.datetime('last_failed_at').notNullable().defaultTo(utcNow(knex))
    t.unique(['instance_id', 'transition_id'], { indexName: 'ux_auto_transition_failures' })
    t.index(['collection', 'item'], 'ix_auto_transition_failures_record')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(TABLE)
}
