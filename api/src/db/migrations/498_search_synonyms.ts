import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Search synonyms (#1581). One row = a group of words that mean the same thing
 * to the people searching ("PO", "purchase order"). A search for any word in
 * the group also looks for the others — in a collection's search box, in
 * pickers and in Cmd+K. `collection` limits the group to one collection's
 * searches; NULL means everywhere. Authored config: it travels with promotion.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_search_synonyms')) return
  await knex.schema.createTable('nivaro_search_synonyms', (t) => {
    t.increments('id')
    /** JSON array of 2–10 lower-cased terms (each 1–100 chars, may hold spaces). */
    t.text('terms').notNullable()
    t.string('collection', 100).nullable()
    t.string('note', 500).nullable()
    t.uuid('created_by').nullable()
    t.dateTime('created_at').notNullable().defaultTo(utcNow(knex))
    t.uuid('updated_by').nullable()
    t.dateTime('updated_at').nullable()
    t.index(['collection'])
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_search_synonyms')
}
