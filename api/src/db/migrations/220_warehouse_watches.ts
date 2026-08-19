import type { Knex } from 'knex'

/**
 * Stock Planning per-part alert watches + per-user alert preferences.
 *
 * warehouse_watches — one row per (user, cifa, warehouse) subscription.
 *   warehouse NULL means "any warehouse". threshold is an optional on-hand
 *   floor ("alert when on hand < N"). alert_state remembers the last alert
 *   signature sent so the instant scan only fires on transitions.
 *
 * warehouse_alert_prefs — one row per user; which alert channels they want.
 *   Missing row = all channels on (defaults applied in code).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('warehouse_watches'))) {
    await knex.schema.createTable('warehouse_watches', (t) => {
      t.increments('id')
      t.uuid('user').notNullable()
      t.integer('cifa').notNullable()
      t.integer('warehouse').nullable()
      t.integer('threshold').nullable()
      t.string('alert_state', 120).nullable()
      t.dateTime('date_created').notNullable().defaultTo(knex.fn.now())
      t.unique(['user', 'cifa', 'warehouse'])
      t.index(['user'])
      t.index(['cifa'])
    })
  }
  if (!(await knex.schema.hasTable('warehouse_alert_prefs'))) {
    await knex.schema.createTable('warehouse_alert_prefs', (t) => {
      t.uuid('user').primary()
      t.boolean('daily').notNullable().defaultTo(true)
      t.boolean('instant').notNullable().defaultTo(true)
      t.boolean('banner').notNullable().defaultTo(true)
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('warehouse_watches')
  await knex.schema.dropTableIfExists('warehouse_alert_prefs')
}
