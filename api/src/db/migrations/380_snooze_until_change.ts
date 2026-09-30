import type { Knex } from 'knex'

/**
 * Snooze until it changes (#647).
 *   - nivaro_notifications.snooze_until_change (bit, default 0): the row is
 *     snoozed until the record it names moves — a field write or a state
 *     change by someone else — instead of until a time. snoozed_until holds a
 *     far-future date meanwhile, so every existing snoozed-row filter still
 *     hides it.
 *   - an index on (collection, item): the wake-up is one UPDATE per write on
 *     a collection that has such a snooze.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_notifications'))) return
  if (!(await knex.schema.hasColumn('nivaro_notifications', 'snooze_until_change'))) {
    await knex.schema.alterTable('nivaro_notifications', (t) => {
      t.boolean('snooze_until_change').notNullable().defaultTo(false)
    })
  }
  try {
    await knex.schema.alterTable('nivaro_notifications', (t) => {
      t.index(['collection', 'item'], 'ix_nivaro_notifications_collection_item')
    })
  } catch {
    // already there
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_notifications'))) return
  try {
    await knex.schema.alterTable('nivaro_notifications', (t) => {
      t.dropIndex(['collection', 'item'], 'ix_nivaro_notifications_collection_item')
    })
  } catch {}
  if (await knex.schema.hasColumn('nivaro_notifications', 'snooze_until_change')) {
    await knex.schema.alterTable('nivaro_notifications', (t) => {
      t.dropColumn('snooze_until_change')
    })
  }
}
