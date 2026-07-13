import type { Knex } from 'knex'

/**
 * Record share links — expiring signed read-only views of a single record,
 * rendered through a grouped layout. Same curation-not-security model as
 * widget feeds and submission forms: the creator chooses what to expose.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_share_links', (t) => {
    t.uuid('id').primary()
    t.string('collection', 255).notNullable()
    t.string('item', 255).notNullable()
    t.string('token', 64).notNullable().unique()
    t.integer('layout_id') // explicit grouped layout; null = collection's active
    t.datetime('expires_at')
    t.boolean('is_active').notNullable().defaultTo(true)
    t.integer('view_count').notNullable().defaultTo(0)
    t.datetime('last_viewed_at')
    t.uuid('created_by').references('id').inTable('nivaro_users')
    t.datetime('created_at').defaultTo(knex.fn.now())
  })
  await knex.raw('CREATE INDEX ix_share_links_record ON nivaro_share_links (collection, item)')
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('nivaro_share_links')
}
