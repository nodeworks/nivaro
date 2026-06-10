import type { Knex } from 'knex'

export async function up(knex: Knex) {
  await knex.schema.createTable('nivaro_page_views', (t) => {
    t.bigIncrements('id').primary()
    t.specificType('session_id', 'nvarchar(64)').notNullable()
    t.specificType('user_id', 'nvarchar(128)').nullable()
    t.specificType('user_email', 'nvarchar(254)').nullable()
    t.specificType('user_name', 'nvarchar(128)').nullable()
    t.specificType('page_url', 'nvarchar(2048)').notNullable()
    t.specificType('page_title', 'nvarchar(256)').nullable()
    t.specificType('referrer', 'nvarchar(2048)').nullable()
    t.specificType('device_type', 'nvarchar(16)').nullable()
    t.specificType('ip', 'nvarchar(45)').nullable()
    t.specificType('user_agent', 'nvarchar(500)').nullable()
    t.datetime('viewed_at').notNullable().defaultTo(knex.fn.now())
    t.integer('duration_seconds').nullable()
  })
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('nivaro_page_views')
}
