import type { Knex } from 'knex'

/**
 * Traffic Map longer high-resolution history (#2228): the OPTIONAL per-minute store.
 *
 * `nivaro_traffic_minutes` — one row per (UTC minute, node or edge key): requests, errors,
 * p50 / p95 (ms, from the merged latency histogram), response bytes and that histogram
 * (`hist`, 12 comma-separated bucket counts — services/traffic-history-analysis.ts LAT_BOUNDS) so
 * longer steps can be merged exactly. Written once a minute in one batch by the scheduler leader
 * (cron traffic-minutes-write), pruned by cron traffic-minutes-prune. A late push can leave two
 * rows for the same (bucket, key); reads sum them, so there is no unique key.
 *
 * `nivaro_settings.traffic_history` — JSON `{enabled, retention_days, edges}`; NULL = off,
 * 30 days, edges kept. The store is off until an administrator switches it on.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_traffic_minutes'))) {
    await knex.schema.createTable('nivaro_traffic_minutes', (t) => {
      t.bigIncrements('id').primary()
      t.datetime('bucket').notNullable()
      t.string('key', 300).notNullable()
      t.string('kind', 8).notNullable().defaultTo('node')
      t.integer('requests').notNullable().defaultTo(0)
      t.integer('errors').notNullable().defaultTo(0)
      t.integer('p50').notNullable().defaultTo(0)
      t.integer('p95').notNullable().defaultTo(0)
      t.bigInteger('bytes').notNullable().defaultTo(0)
      t.string('hist', 200).nullable()
      t.index(['bucket'], 'ix_traffic_minutes_bucket')
      t.index(['key', 'bucket'], 'ix_traffic_minutes_key_bucket')
    })
  }
  if (
    (await knex.schema.hasTable('nivaro_settings')) &&
    !(await knex.schema.hasColumn('nivaro_settings', 'traffic_history'))
  ) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.text('traffic_history').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_traffic_minutes'))
    await knex.schema.dropTable('nivaro_traffic_minutes')
  if (
    (await knex.schema.hasTable('nivaro_settings')) &&
    (await knex.schema.hasColumn('nivaro_settings', 'traffic_history'))
  ) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('traffic_history')
    })
  }
}
