import type { Knex } from 'knex'

export async function up(knex: Knex) {
  await knex.schema.createTable('nivaro_external_api_logs', (t) => {
    t.increments('id').primary()
    t.integer('api_id').notNullable()
    t.integer('endpoint_id').nullable()
    t.string('triggered_by', 100).notNullable().defaultTo('unknown')
    t.string('method', 10).notNullable()
    t.string('url', 2048).notNullable()
    t.specificType('request_headers', 'nvarchar(max)').nullable()
    t.specificType('request_body', 'nvarchar(max)').nullable()
    t.integer('response_status').nullable()
    t.specificType('response_headers', 'nvarchar(max)').nullable()
    t.specificType('response_body', 'nvarchar(max)').nullable()
    t.integer('duration_ms').nullable()
    t.string('error', 2000).nullable()
    t.string('user_id', 255).nullable()
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now())
  })
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('nivaro_external_api_logs')
}
