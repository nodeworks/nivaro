import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Per-record SLA override (#1239). An approver on the record (the current
 * step's owner, or an admin) extends or shortens THIS record's clock in its
 * current state, with a reason. Rules stay as they are — the override only
 * replaces the matched rule's duration for one state-entry episode.
 *
 * Episode identity = instance_id + state_key + entered_at (the moment the
 * instance entered the state, compared with a 1s tolerance like the ack and
 * escalation tables). Leaving the state ends the override naturally; a later
 * re-entry is a new episode the old override no longer matches. cleared_at is
 * set only when someone removes it (or replaces it with a new one).
 */
const TABLE = 'nivaro_sla_overrides'

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) return
  await knex.schema.createTable(TABLE, (t) => {
    t.increments('id').primary()
    t.string('collection', 255).notNullable()
    t.string('item', 255).notNullable()
    t.string('state_key', 255).notNullable()
    t.uuid('instance_id').notNullable()
    // When the instance entered the state — the episode the override belongs to.
    t.datetime('entered_at').notNullable()
    t.float('duration_hours').notNullable()
    // The rule's own duration at the time, for "48h (rule: 24h)".
    t.float('rule_duration_hours')
    t.string('reason', 1000).notNullable()
    t.uuid('set_by').references('id').inTable('nivaro_users').onDelete('NO ACTION')
    t.datetime('set_at').notNullable().defaultTo(utcNow(knex))
    t.datetime('cleared_at')
    t.uuid('cleared_by').references('id').inTable('nivaro_users').onDelete('NO ACTION')
    t.index(['collection', 'item'], 'ix_sla_overrides_record')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(TABLE)
}
