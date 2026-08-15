import type { Knex } from 'knex'

/**
 * Whether the person currently has a live connection.
 *
 * Online was inferred from `last_seen` inside a time window, which is both slow
 * and wrong at the edges: someone who closes the tab lingers until the window
 * passes, and a backgrounded tab whose timers the browser throttles drops off
 * while still open. The socket already knows the truth — it has a connect and a
 * disconnect — so it records it here and the window becomes a fallback for
 * hosts with no socket rather than the primary signal.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('user_presence'))) return
  if (await knex.schema.hasColumn('user_presence', 'is_online')) return
  await knex.schema.alterTable('user_presence', (t) => {
    t.boolean('is_online').notNullable().defaultTo(false)
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('user_presence'))) return
  if (!(await knex.schema.hasColumn('user_presence', 'is_online'))) return
  await knex.schema.alterTable('user_presence', (t) => t.dropColumn('is_online'))
}
