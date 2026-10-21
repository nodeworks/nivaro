import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Search analytics (#1581): one row per search typed into Cmd+K or a
 * collection browser — the query text, how many results came back, which one
 * was opened and how long it took. Never the results themselves. Personal
 * data: read by administrators only and pruned with the api-log retention
 * pass (SEARCH_LOG_RETENTION_DAYS, default 60).
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_search_log')) return
  await knex.schema.createTable('nivaro_search_log', (t) => {
    t.bigIncrements('id')
    t.uuid('user').nullable()
    /** 'palette' (Cmd+K) | 'collection' (a collection browser's search box). */
    t.string('surface', 20).notNullable()
    t.string('collection', 100).nullable()
    t.string('query', 200).notNullable()
    t.integer('result_count').notNullable().defaultTo(0)
    t.integer('duration_ms').nullable()
    /** What the person opened from the results: record | page | action | similar. */
    t.string('opened_type', 20).nullable()
    t.string('opened_collection', 100).nullable()
    t.string('opened_item', 100).nullable()
    t.dateTime('opened_at').nullable()
    t.dateTime('created_at').notNullable().defaultTo(utcNow(knex))
    t.index(['created_at'])
    t.index(['surface', 'created_at'])
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_search_log')
}
