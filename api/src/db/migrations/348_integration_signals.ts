import type { Knex } from 'knex'

/**
 * Integrations console (spec 2026-09-23): the signal snapshot, per-run log,
 * admin settings, snoozes and opt-in alert subscriptions.
 *
 * rows       — one row per open problem instance; cleared_at set when the
 *              signal stops returning its key. UNIQUE(signal,row_key) over
 *              OPEN rows only (a problem that clears and returns is a new row).
 * runs       — one row per signal per evaluation; pruned to 7 days.
 * settings   — thresholds / severity / enabled per signal (config).
 * snoozes    — per row, per group or per signal; until a time or until the
 *              payload hash changes.
 * subscriptions — opt-in alert subscriptions; nobody has a row by default.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_integration_signal_rows'))) {
    await knex.schema.createTable('nivaro_integration_signal_rows', (t) => {
      t.bigIncrements('id')
      t.string('signal', 120).notNullable()
      t.string('row_key', 300).notNullable()
      t.string('group_key', 300).nullable()
      t.text('payload').notNullable()
      t.dateTime('first_seen').notNullable()
      t.dateTime('last_seen').notNullable()
      t.dateTime('cleared_at').nullable()
      t.dateTime('alerted_at').nullable()
      t.index(['signal', 'cleared_at'])
    })
    await knex.raw(
      `CREATE UNIQUE INDEX ux_integration_signal_rows_open
         ON nivaro_integration_signal_rows (signal, row_key) WHERE cleared_at IS NULL`
    )
  }
  if (!(await knex.schema.hasTable('nivaro_integration_signal_runs'))) {
    await knex.schema.createTable('nivaro_integration_signal_runs', (t) => {
      t.bigIncrements('id')
      t.string('signal', 120).notNullable()
      t.dateTime('ran_at').notNullable()
      t.integer('duration_ms').notNullable().defaultTo(0)
      t.integer('count').notNullable().defaultTo(0)
      t.string('error', 1000).nullable()
      t.index(['signal', 'ran_at'])
    })
  }
  if (!(await knex.schema.hasTable('nivaro_integration_signal_settings'))) {
    await knex.schema.createTable('nivaro_integration_signal_settings', (t) => {
      t.increments('id')
      t.string('signal', 120).notNullable()
      t.string('key', 200).notNullable()
      t.string('value', 200).notNullable()
      t.uuid('updated_by').nullable()
      t.dateTime('updated_at').notNullable()
      t.unique(['signal', 'key'])
    })
  }
  if (!(await knex.schema.hasTable('nivaro_integration_signal_snoozes'))) {
    await knex.schema.createTable('nivaro_integration_signal_snoozes', (t) => {
      t.increments('id')
      t.string('signal', 120).notNullable()
      t.string('row_key', 300).nullable()
      t.string('group_key', 300).nullable()
      t.dateTime('until').nullable()
      t.string('until_change_hash', 64).nullable()
      t.string('note', 500).nullable()
      t.uuid('created_by').nullable()
      t.dateTime('created_at').notNullable()
      t.index(['signal'])
    })
  }
  if (!(await knex.schema.hasTable('nivaro_integration_signal_subscriptions'))) {
    await knex.schema.createTable('nivaro_integration_signal_subscriptions', (t) => {
      t.increments('id')
      t.uuid('user').notNullable().references('id').inTable('nivaro_users')
      t.string('signal', 120).notNullable()
      t.string('mode', 20).notNullable()
      t.dateTime('last_notified_at').nullable()
      t.dateTime('created_at').notNullable()
      t.unique(['user', 'signal', 'mode'])
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const t of [
    'nivaro_integration_signal_subscriptions',
    'nivaro_integration_signal_snoozes',
    'nivaro_integration_signal_settings',
    'nivaro_integration_signal_runs',
    'nivaro_integration_signal_rows'
  ]) {
    await knex.schema.dropTableIfExists(t)
  }
}
