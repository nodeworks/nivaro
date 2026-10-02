import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Traffic Map investigation notebooks (drill-down #1212): a saved investigation stack — the
 * encoded levels (`kind:id@at/…`, the same form as the page's `?inspect=` URL value), the notes an
 * admin keeps while working it, and the compact JSON of what each level showed when it was saved
 * (≤ 64 KB, built by the page's stack context builder).
 *
 * `store` is the map store the investigation belongs to ('default' self-hosted, `t:<tenant>` in
 * cloud mode, #1132). `created_by` is a bare uuid with no FK: a deleted user must never block a
 * read or a delete. Runtime data — never promoted between environments.
 */
const TABLE = 'nivaro_traffic_investigations'

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) return
  await knex.schema.createTable(TABLE, (t) => {
    t.string('id', 36).primary()
    t.string('store', 120).notNullable().defaultTo('default')
    t.string('title', 200).notNullable()
    t.text('stack').notNullable()
    t.text('notes').nullable()
    t.text('context').nullable()
    t.uuid('created_by').nullable()
    t.datetime('created_at').notNullable().defaultTo(utcNow(knex))
    t.datetime('updated_at').notNullable().defaultTo(utcNow(knex))
    // the list is the newest-updated 30 of a store (every autosave bumps updated_at)
    t.index(['store', 'updated_at'], 'ix_traffic_investigations_store_updated')
  })
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) await knex.schema.dropTable(TABLE)
}
