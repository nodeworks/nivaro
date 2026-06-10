import type { Knex } from 'knex'

export async function up(knex: Knex) {
  await knex.schema.createTable('nivaro_notification_subscriptions', (t) => {
    t.increments('id').primary()
    t.uuid('user').notNullable()
    t.foreign('user')
      .references('id')
      .inTable('nivaro_users')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.specificType('collection', 'nvarchar(255)').notNullable()
    t.specificType('event_type', 'nvarchar(50)').notNullable()
    t.specificType('filter_field', 'nvarchar(255)').nullable()
    t.specificType('filter_value', 'nvarchar(500)').nullable()
    t.specificType('label', 'nvarchar(255)').nullable()
    t.boolean('is_active').notNullable().defaultTo(true)
    t.datetime('created_at').notNullable()
  })
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('nivaro_notification_subscriptions')
}
