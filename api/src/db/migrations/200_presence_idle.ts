import type { Knex } from 'knex'

/**
 * Distinguish "at their desk" from "tab is open".
 *
 * `last_seen` cannot answer this: the heartbeat keeps beating while someone is
 * away from the machine, so everyone with a tab open reads as active. Idleness
 * is a client observation — time since the last real interaction — so the
 * client reports it and this column stores it.
 *
 * `last_active` is kept alongside the flag so a viewer can be told HOW long
 * ("idle 20m") rather than just that it happened, and so the boundary can be
 * re-judged server-side later without another client change.
 *
 * user_presence is a legacy (Directus-era) table, hence the guard: a fresh
 * install has no such table and this must be inert there.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('user_presence'))) return
  if (!(await knex.schema.hasColumn('user_presence', 'is_idle'))) {
    await knex.schema.alterTable('user_presence', (t) => {
      t.boolean('is_idle').notNullable().defaultTo(false)
    })
  }
  if (!(await knex.schema.hasColumn('user_presence', 'last_active'))) {
    await knex.schema.alterTable('user_presence', (t) => {
      t.dateTime('last_active').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('user_presence'))) return
  if (await knex.schema.hasColumn('user_presence', 'is_idle')) {
    await knex.schema.alterTable('user_presence', (t) => t.dropColumn('is_idle'))
  }
  if (await knex.schema.hasColumn('user_presence', 'last_active')) {
    await knex.schema.alterTable('user_presence', (t) => t.dropColumn('last_active'))
  }
}
