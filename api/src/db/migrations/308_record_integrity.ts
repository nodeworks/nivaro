import type { Knex } from 'knex'

/**
 * Per-record integrity store — the "never stale" side of the record banner.
 * nivaro_record_integrity holds the latest live result for one record
 * (written by the after-write hook on the record or any child row, and by
 * the on-load check), so the banner reads a row that moves with the data
 * instead of the last collection sweep. One row per (collection, item_id).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_record_integrity'))) {
    await knex.schema.createTable('nivaro_record_integrity', (t) => {
      t.string('collection', 255).notNullable()
      t.string('item_id', 255).notNullable()
      t.text('findings').notNullable()
      t.dateTime('checked_at').notNullable()
      t.string('source', 20).notNullable().defaultTo('live')
      t.primary(['collection', 'item_id'])
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_record_integrity')) {
    await knex.schema.dropTable('nivaro_record_integrity')
  }
}
