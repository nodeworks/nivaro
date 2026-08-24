import type { Knex } from 'knex'

// Idle lock release: a record lock held by someone who walked away is released
// after this many minutes of no real input (null = never — historic behavior).
// Enforced in the heartbeat route; the client reports its idle time.
export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_settings', 'lock_idle_release_minutes')
  if (!has) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.integer('lock_idle_release_minutes').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_settings', 'lock_idle_release_minutes')
  if (has) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('lock_idle_release_minutes')
    })
  }
}
