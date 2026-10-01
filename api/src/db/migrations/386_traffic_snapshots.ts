import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Traffic Map snapshots (#1097): a frozen view — the map's snapshot JSON (counts, series, routes,
 * callers, recent errors and writes), the labels it showed, the window, filters and selection —
 * that opens read-only from a link (/traffic-map?snapshot=<id>).
 *
 * `store` is the map store the snapshot was taken in ('default' self-hosted, `t:<tenant>` in
 * cloud mode, #1132), so a snapshot only ever opens for the store it describes. `created_by` is
 * a bare uuid with no FK: a deleted user must never block a snapshot read or delete.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_traffic_snapshots')) return
  await knex.schema.createTable('nivaro_traffic_snapshots', (t) => {
    t.string('id', 36).primary()
    t.string('store', 120).notNullable().defaultTo('default')
    t.string('name', 200).notNullable()
    t.text('note').nullable()
    t.integer('window_s').notNullable()
    t.string('scope', 20).notNullable().defaultTo('node')
    t.string('node', 40).nullable()
    t.string('instance', 120).nullable()
    t.text('filters').nullable()
    t.text('selection').nullable()
    t.text('snapshot').notNullable()
    t.text('catalog').nullable()
    t.uuid('created_by').nullable()
    t.datetime('created_at').notNullable().defaultTo(utcNow(knex))
    t.index(['store', 'created_at'], 'ix_traffic_snapshots_store_created')
  })
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_traffic_snapshots'))
    await knex.schema.dropTable('nivaro_traffic_snapshots')
}
