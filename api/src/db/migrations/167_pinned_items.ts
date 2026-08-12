import type { Knex } from 'knex'

// Generic per-user starred/pinned records (e.g. catalog-picker favorites):
// one row per (user, collection, item). Item ids stored as varchar so int and
// uuid PKs both fit.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_pinned_items', (t) => {
    t.increments('id').primary()
    t.uuid('user').notNullable().references('id').inTable('nivaro_users').onDelete('CASCADE')
    t.string('collection', 255).notNullable()
    t.string('item_id', 255).notNullable()
    t.datetime('created_at').defaultTo(knex.fn.now())
    t.unique(['user', 'collection', 'item_id'])
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_pinned_items')
}
