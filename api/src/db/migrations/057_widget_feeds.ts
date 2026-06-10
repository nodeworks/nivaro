import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  // Token-gated public content feeds for the embeddable widget SDK
  await knex.schema.createTable('nivaro_widget_feeds', (t) => {
    t.increments('id')
    t.string('name', 255).notNullable()
    t.string('token', 64).notNullable()
    t.string('collection', 100).notNullable()
    t.specificType('fields', 'nvarchar(max)').notNullable() // JSON array of exposed fields
    t.specificType('filters', 'nvarchar(max)').nullable() // JSON equality filters
    t.integer('limit_count').notNullable().defaultTo(20)
    t.string('sort', 100).nullable()
    t.boolean('is_active').notNullable().defaultTo(true)
    t.uuid('created_by').notNullable()
    t.foreign('created_by')
      .references('id')
      .inTable('nivaro_users')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.datetime('created_at').defaultTo(knex.fn.now())
  })
  await knex.raw(
    'ALTER TABLE nivaro_widget_feeds ADD CONSTRAINT uq_nivaro_widget_feeds_token UNIQUE (token)'
  )
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_widget_feeds')
}
