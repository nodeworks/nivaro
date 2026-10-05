import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Bounce handling (#1299): addresses the relay has refused with a HARD bounce
 * (5xx on RCPT/DATA, "user unknown", "mailbox unavailable" …). Every sender
 * drops a suppressed address with a 'dropped' mail-log row instead of
 * hammering the relay; an admin clears the mark from the Mail Log.
 *
 * Keyed on the lower-cased address — a mail call carries nothing else, and an
 * address with no nivaro_users row (a vendor, a list) bounces like any other.
 * `notified_at` is the once-only stamp for "the owners were told". No FKs: a
 * log-like table, and a deleted user must never block a bounce being recorded.
 * Runtime data — never promoted between environments.
 */
const TABLE = 'nivaro_mail_suppressions'

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) return
  await knex.schema.createTable(TABLE, (t) => {
    t.increments('id').primary()
    t.string('address', 320).notNullable().unique('ux_mail_suppressions_address')
    t.string('reason', 500).nullable()
    t.datetime('first_seen').notNullable().defaultTo(utcNow(knex))
    t.datetime('last_seen').notNullable().defaultTo(utcNow(knex))
    t.integer('count').notNullable().defaultTo(1)
    t.datetime('notified_at').nullable()
    t.index(['last_seen'], 'ix_mail_suppressions_last_seen')
  })
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) await knex.schema.dropTable(TABLE)
}
