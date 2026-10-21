import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Form usage per layout (#2597/#2598): one row per layout per UTC day with
 * opens, saves, abandoned new records and per-step time (step_stats JSON),
 * plus the distinct people and records that used the form that day (`seen`,
 * kind 'u' = user id, 'r' = record id). Written by POST /api/layout-usage/beacon
 * (one small upsert per form session); pruned after 180 days by the
 * `layout-usage-prune` cron. Per-database facts — RUNTIME, never promoted.
 * `layout_id` has no FK: usage history must never block a layout delete.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_layout_usage_daily'))) {
    await knex.schema.createTable('nivaro_layout_usage_daily', (t) => {
      t.increments('id')
      t.integer('layout_id').notNullable()
      t.string('collection', 64).notNullable()
      t.date('day').notNullable()
      t.integer('opens').notNullable().defaultTo(0)
      t.integer('saves').notNullable().defaultTo(0)
      t.integer('abandons').notNullable().defaultTo(0)
      t.text('step_stats').nullable() // JSON {stepKey: {ms, n, abandons}}
      t.datetime('updated_at').notNullable().defaultTo(utcNow(knex))
      t.unique(['layout_id', 'day'], { indexName: 'ux_layout_usage_daily' })
      t.index(['day'], 'ix_layout_usage_daily_day')
    })
  }
  if (!(await knex.schema.hasTable('nivaro_layout_usage_seen'))) {
    await knex.schema.createTable('nivaro_layout_usage_seen', (t) => {
      t.increments('id')
      t.integer('layout_id').notNullable()
      t.date('day').notNullable()
      t.string('kind', 1).notNullable() // u | r
      t.string('ref', 64).notNullable()
      t.unique(['layout_id', 'day', 'kind', 'ref'], { indexName: 'ux_layout_usage_seen' })
      t.index(['day'], 'ix_layout_usage_seen_day')
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const t of ['nivaro_layout_usage_seen', 'nivaro_layout_usage_daily'])
    if (await knex.schema.hasTable(t)) await knex.schema.dropTable(t)
}
