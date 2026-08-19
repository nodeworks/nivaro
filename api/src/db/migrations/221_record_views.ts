import type { Knex } from 'knex'

/**
 * Per-user record view watermarks — powers the "since you last looked" recap
 * strip on record forms. One row per (user, collection, item):
 *
 *   last_viewed_at — rolled forward on every open (subject to a 30-minute
 *     session grace so a refresh doesn't erase the recap you were reading)
 *   prev_viewed_at — the watermark the recap diffs against
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_record_views'))) {
    await knex.schema.createTable('nivaro_record_views', (t) => {
      t.increments('id')
      t.uuid('user').notNullable()
      t.string('collection', 255).notNullable()
      t.string('item_id', 255).notNullable()
      t.dateTime('last_viewed_at').notNullable()
      t.dateTime('prev_viewed_at').nullable()
      t.unique(['user', 'collection', 'item_id'])
      t.index(['user', 'collection'])
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_record_views')
}
